import {
  cancelTimer,
  createTimer,
  discardAllTimersOnBrowserRestart,
  handleAlarm,
  handleNotificationClicked,
  handleNotificationClosed,
  handleTabRemoved,
  handleTabReplaced,
  handleTabUpdated,
  reconcileNormal,
} from "./timer-service";
import { enqueueTask, loadState } from "./storage";
import type { ActionRequest, ActionResponse, GetStateResponse, Request } from "../shared/messages";

const MENU_PARENT_ID = "tab-timer-set";
const PRESET_MINUTES = [15, 30, 60] as const;

const SESSION_MARKER_KEY = "browserSessionMarker";

// 当初はchrome.runtime.onStartupの発火（ブラウザ全体の再起動時にのみ発火し、
// SW単体の再起動では発火しない）を使って「ブラウザ全体の再起動（無条件
// 破棄）」と「同一セッション内の通常のSW再起動（通常整合）」を区別して
// いたが、Stage5実装レビューで「ブラウザ再起動時に他のイベント（alarm等）
// がonStartupより先にensureReconciled()へ到達すると、破棄より先に通常
// 整合が走ってしまう」という配送順序への依存が指摘された。
//
// chrome.storage.session（ブラウザ終了時にクリアされ、SW単体の再起動では
// 保持される一時ストレージ）にセッションマーカーを持たせる方式へ変更する
// ことで、イベント配送順序に一切依存せず「このマーカーが無ければ新しい
// ブラウザセッションの最初のSW起動」と自己完結的に判定できるようにした。
//
// 通常整合（reconcileNormal）・破棄処理のいずれも、onInstalled経由・
// イベント経由のいずれであってもSW生存期間中に1回だけ実行する
// （reconciledPromiseで一元管理）。失敗時はreconciledPromiseを破棄し、
// 次回呼び出しで再試行できるようにする（Stage5実装レビューで、一時的な
// 失敗でWorkerが恒久的に機能停止するリスクが指摘されたため）。
let reconciledPromise: Promise<void> | undefined;
function ensureReconciled(): Promise<void> {
  if (!reconciledPromise) {
    const promise = enqueueTask(async () => {
      try {
        const sessionData = await chrome.storage.session.get(SESSION_MARKER_KEY);
        if (sessionData[SESSION_MARKER_KEY] !== true) {
          await chrome.storage.session.set({ [SESSION_MARKER_KEY]: true });
          await discardAllTimersOnBrowserRestart();
        } else {
          await reconcileNormal(Date.now());
        }
      } catch (error) {
        if (reconciledPromise === promise) {
          reconciledPromise = undefined;
        }
        throw error;
      }
    });
    reconciledPromise = promise;
  }
  return reconciledPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error("contextMenus.removeAll failed", chrome.runtime.lastError.message);
    }
    chrome.contextMenus.create(
      { id: MENU_PARENT_ID, title: "このタブにタイマーを設定", contexts: ["page"] },
      () => {
        if (chrome.runtime.lastError) {
          console.error("contextMenus.create (parent) failed", chrome.runtime.lastError.message);
        }
      },
    );
    for (const minutes of PRESET_MINUTES) {
      chrome.contextMenus.create(
        {
          id: `${MENU_PARENT_ID}:${minutes}`,
          parentId: MENU_PARENT_ID,
          title: `${minutes}分後`,
          contexts: ["page"],
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error("contextMenus.create (preset) failed", chrome.runtime.lastError.message);
          }
        },
      );
    }
  });
  void ensureReconciled();
});

// ensureReconciled()が失敗した場合、.catch()を付けずvoidで投げっぱなしに
// すると未処理rejectionになり、以降のensureReconciled()呼び出しは
// reconciledPromiseがリセットされているため再試行はされるものの、この
// 1回分のイベント処理（タブ削除・URL変更・alarm発火・通知クリック等）が
// 無言で失われる（実Chromeスモークテスト監査で発見）。全リスナー共通で
// ログを残すヘルパーに統一する。
function runAfterReconcile(label: string, task: () => Promise<void>): void {
  void ensureReconciled()
    .then(() => enqueueTask(task))
    .catch((error: unknown) => {
      console.error(`${label} failed`, error);
    });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const minutesMatch = /^tab-timer-set:(\d+)$/.exec(String(info.menuItemId));
  if (!minutesMatch || tab?.id === undefined || tab.url === undefined) return;
  const minutes = Number(minutesMatch[1]);
  const now = Date.now();
  const tabId = tab.id;
  const title = tab.title ?? tab.url;
  const url = tab.url;
  runAfterReconcile("contextMenus.onClicked", () =>
    createTimer(tabId, title, url, now + minutes * 60_000, now).then(() => undefined),
  );
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runAfterReconcile("tabs.onRemoved", () => handleTabRemoved(tabId, Date.now()));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  const newUrl = changeInfo.url;
  runAfterReconcile("tabs.onUpdated", () => handleTabUpdated(tabId, newUrl, Date.now()));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  runAfterReconcile("tabs.onReplaced", () => handleTabReplaced(removedTabId, addedTabId));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  runAfterReconcile("alarms.onAlarm", () => handleAlarm(alarm.name, Date.now()));
});

chrome.notifications.onClicked.addListener((notificationId) => {
  runAfterReconcile("notifications.onClicked", () => handleNotificationClicked(notificationId));
});

chrome.notifications.onClosed.addListener((notificationId) => {
  runAfterReconcile("notifications.onClosed", () => handleNotificationClosed(notificationId));
});

const EMPTY_STATE_RESPONSE: GetStateResponse = {
  currentTabId: undefined,
  currentTabTitle: undefined,
  currentTabTimer: undefined,
  currentTabCancelledReason: undefined,
  allTimers: [],
};

async function handleGetState(): Promise<GetStateResponse> {
  try {
    await ensureReconciled();
  } catch (error) {
    console.error("ensureReconciled failed (GET_STATE)", error);
    return EMPTY_STATE_RESPONSE;
  }
  const state = await loadState();

  let currentTabId: number | undefined;
  let currentTabTitle: string | undefined;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = activeTab?.id;
    currentTabTitle = activeTab?.title ?? activeTab?.url;
  } catch {
    currentTabId = undefined;
    currentTabTitle = undefined;
  }

  const allTimers = Object.values(state.timersById).sort((a, b) => a.fireAt - b.fireAt);
  const currentTabTimer = currentTabId !== undefined ? allTimers.find((t) => t.tabId === currentTabId) : undefined;
  const cancelledEntry =
    currentTabId !== undefined
      ? [...state.recentlyCancelled].reverse().find((entry) => entry.tabId === currentTabId)
      : undefined;

  return {
    currentTabId,
    currentTabTitle,
    currentTabTimer,
    currentTabCancelledReason: cancelledEntry?.reason,
    allTimers,
  };
}

async function handleAction(request: ActionRequest): Promise<ActionResponse> {
  try {
    await ensureReconciled();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const now = Date.now();
  switch (request.type) {
    case "SET_TIMER": {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(request.tabId);
      } catch {
        return { ok: false, reason: "対象タブが見つかりません。" };
      }
      if (tab.url === undefined) return { ok: false, reason: "対象タブのURLを取得できません。" };
      return enqueueTask(() =>
        createTimer(request.tabId, tab.title ?? tab.url ?? "", tab.url as string, request.fireAt, now),
      );
    }
    case "CANCEL_TIMER":
      await enqueueTask(() => cancelTimer(request.tabId, "manual", now));
      return { ok: true };
  }
}

// handleGetState・handleAction自体は内部でensureReconciled()の失敗を
// 捕捉して安全な値を返すが、念のためここでも.catchを付け、想定外の例外で
// sendResponseが呼ばれずメッセージポートが応答なしで閉じることを防ぐ
// （B-8の実装レビューで見つかった同種の問題への対応を踏襲）。
chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    void handleGetState()
      .catch((error: unknown) => {
        console.error("handleGetState failed", error);
        return EMPTY_STATE_RESPONSE;
      })
      .then(sendResponse);
    return true;
  }
  void handleAction(message)
    .catch((error: unknown) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }))
    .then(sendResponse);
  return true;
});
