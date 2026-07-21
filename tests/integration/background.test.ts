import { beforeEach, describe, expect, it, vi } from "vitest";
import chrome from "sinon-chrome";
import { chromeExtra } from "../setup";
import type { ActionResponse, GetStateResponse, Request } from "../../src/shared/messages";
import type { TimerRecord, TimerState } from "../../src/shared/timer-types";

async function loadBackgroundFresh(): Promise<void> {
  vi.resetModules();
  await import("../../src/background/index");
}

function dispatchMessage<T>(message: Request): Promise<T> {
  const listener = chrome.runtime.onMessage.addListener.lastCall.args[0] as (
    message: Request,
    sender: unknown,
    sendResponse: (response: T) => void,
  ) => boolean;
  return new Promise((resolve) => {
    listener(message, {}, (response) => resolve(response));
  });
}

// イベントリスナーはPromiseチェーン（ensureReconciled().then(() =>
// enqueueTask(...))）で非同期に処理が続くため、固定回数のPromise.resolve()
// では深さが足りず、後続のawaitが必要な処理に到達する前にアサーションが
// 実行されてしまう。setTimeout(0)によるマクロタスク経由のフラッシュで、
// 深さに関わらず保留中のマイクロタスクを確実に処理させる。
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeChromeTab {
  id: number;
  url: string;
  title?: string;
  windowId: number;
}

function fakeTab(overrides: Partial<FakeChromeTab> & Pick<FakeChromeTab, "id" | "url">): FakeChromeTab {
  return { windowId: 1, title: "title", ...overrides };
}

async function seedState(state: TimerState): Promise<void> {
  await chrome.storage.local.set({ timerState: state });
}

function fakeRecord(overrides: Partial<TimerRecord> & Pick<TimerRecord, "id" | "tabId">): TimerRecord {
  return {
    alarmName: `tab-timer:${overrides.id}`,
    notificationId: `tab-timer-notification:${overrides.id}`,
    title: "t",
    url: "https://example.com/room",
    originAndPath: "https://example.com/room",
    createdAt: 0,
    // 既定は十分先の未来にする。0のままだとensureReconciled()経由の
    // reconcileNormal()がshouldFire()＝trueと判定し、テスト対象の
    // イベントハンドラが動く前にレコードが発火・削除されてしまう
    // （firing/発火系のテストでは個別にfireAtを上書きする）。
    fireAt: Date.now() + 60 * 60_000,
    status: "scheduled",
    ...overrides,
  };
}

beforeEach(() => {
  chrome.notifications.getPermissionLevel.resolves("granted");
  chrome.alarms.create.resolves(undefined);
  chrome.alarms.clear.resolves(true);
  chrome.alarms.getAll.resolves([]);
  chrome.notifications.create.resolves("id");
  chrome.notifications.clear.resolves(true);
  chrome.notifications.getAll.resolves({});
  chrome.windows.update.resolves(undefined);
  chrome.tabs.update.resolves(undefined);
  chrome.contextMenus.removeAll.callsFake((callback?: () => void) => callback?.());
  chrome.contextMenus.create.callsFake((_options: unknown, callback?: () => void) => callback?.());
});

describe("background: リスナー登録", () => {
  it("インポート時点で同期的に全リスナーを登録する", async () => {
    await loadBackgroundFresh();

    expect(chrome.runtime.onInstalled.addListener.called).toBe(true);
    expect(chrome.contextMenus.onClicked.addListener.called).toBe(true);
    expect(chrome.tabs.onRemoved.addListener.called).toBe(true);
    expect(chrome.tabs.onUpdated.addListener.called).toBe(true);
    expect(chrome.tabs.onReplaced.addListener.called).toBe(true);
    expect(chrome.alarms.onAlarm.addListener.called).toBe(true);
    expect(chrome.notifications.onClicked.addListener.called).toBe(true);
    expect(chrome.notifications.onClosed.addListener.called).toBe(true);
    expect(chrome.runtime.onMessage.addListener.called).toBe(true);
  });
});

describe("background: コンテキストメニュー", () => {
  it("onInstalledでremoveAll後、親＋3プリセットを作成する", async () => {
    await loadBackgroundFresh();
    const installListener = chrome.runtime.onInstalled.addListener.lastCall.args[0] as () => void;

    installListener();
    await flushAsync();

    expect(chrome.contextMenus.removeAll.called).toBe(true);
    expect(chrome.contextMenus.create.callCount).toBe(4);
    const parentArgs = chrome.contextMenus.create.getCall(0).args[0];
    expect(parentArgs.id).toBe("tab-timer-set");
    const presetArgs = chrome.contextMenus.create.getCall(1).args[0];
    expect(presetArgs.id).toBe("tab-timer-set:15");
    expect(presetArgs.parentId).toBe("tab-timer-set");
  });

  it("プリセットクリックでcreateTimer相当の処理が走りalarmを作成する", async () => {
    await loadBackgroundFresh();
    const clickListener = chrome.contextMenus.onClicked.addListener.lastCall.args[0] as (
      info: { menuItemId: string },
      tab: FakeChromeTab,
    ) => void;

    clickListener(
      { menuItemId: "tab-timer-set:15" },
      fakeTab({ id: 1, url: "https://example.com/room" }),
    );
    await flushAsync();

    expect(chrome.alarms.create.called).toBe(true);
    const [alarmName, alarmInfo] = chrome.alarms.create.lastCall.args as [string, { when: number }];
    expect(alarmName).toMatch(/^tab-timer:/);
    expect(alarmInfo.when).toBeGreaterThan(Date.now());
  });
});

describe("background: SET_TIMER・CANCEL_TIMER", () => {
  it("SET_TIMERは妥当な日時ならalarmを作成し成功を返す", async () => {
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();

    const response = await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 15 * 60_000,
    });

    expect(response.ok).toBe(true);
    expect(chrome.alarms.create.called).toBe(true);
  });

  it("SET_TIMERは1分未満の日時を拒否しalarmを作成しない", async () => {
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();

    const response = await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 1000,
    });

    expect(response.ok).toBe(false);
    expect(chrome.alarms.create.called).toBe(false);
  });

  it("SET_TIMERは通知権限が無効なら拒否する", async () => {
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    chrome.notifications.getPermissionLevel.resolves("denied");
    await loadBackgroundFresh();

    const response = await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 15 * 60_000,
    });

    expect(response.ok).toBe(false);
    expect(chrome.alarms.create.called).toBe(false);
  });

  it("同じタブへ再設定すると古いタイマーを先にキャンセルする", async () => {
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();

    await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 15 * 60_000,
    });
    chrome.alarms.clear.resetHistory();
    await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 30 * 60_000,
    });

    expect(chrome.alarms.clear.called).toBe(true);
  });

  it("CANCEL_TIMERは既存タイマーのalarm・通知を消去する", async () => {
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();
    await dispatchMessage<ActionResponse>({
      type: "SET_TIMER",
      tabId: 1,
      fireAt: Date.now() + 15 * 60_000,
    });

    const response = await dispatchMessage<ActionResponse>({ type: "CANCEL_TIMER", tabId: 1 });

    expect(response.ok).toBe(true);
    expect(chrome.alarms.clear.called).toBe(true);
    expect(chrome.notifications.clear.called).toBe(true);
  });
});

describe("background: タブイベントによる自動キャンセル", () => {
  it("tabs.onRemovedで対象タイマーをキャンセルする", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.tabs.onRemoved.addListener.lastCall.args[0] as (tabId: number) => void;
    listener(1);
    await flushAsync();

    expect(chrome.alarms.clear.calledWith("tab-timer:r1")).toBe(true);
  });

  it("tabs.onUpdatedはクエリ・ハッシュだけの変更ではキャンセルしない", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.tabs.onUpdated.addListener.lastCall.args[0] as (
      tabId: number,
      changeInfo: { url?: string },
    ) => void;
    listener(1, { url: "https://example.com/room?token=xyz#state" });
    await flushAsync();

    expect(chrome.alarms.clear.called).toBe(false);
  });

  it("tabs.onUpdatedはoriginまたはpathnameの変更でキャンセルする", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.tabs.onUpdated.addListener.lastCall.args[0] as (
      tabId: number,
      changeInfo: { url?: string },
    ) => void;
    listener(1, { url: "https://example.com/other-room" });
    await flushAsync();

    expect(chrome.alarms.clear.calledWith("tab-timer:r1")).toBe(true);
  });

  it("tabs.onReplacedでtabIdを移行しキャンセルしない", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.tabs.onReplaced.addListener.lastCall.args[0] as (
      addedTabId: number,
      removedTabId: number,
    ) => void;
    listener(2, 1);
    await flushAsync();

    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1?.tabId).toBe(2);
    expect(chrome.alarms.clear.called).toBe(false);
  });
});

describe("background: alarms.onAlarm（発火）", () => {
  it("対象タブが有効なら通知を作成しstatusをnotifiedにする", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "scheduled", fireAt: 1000 }) },
      recentlyCancelled: [],
    });
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();

    const listener = chrome.alarms.onAlarm.addListener.lastCall.args[0] as (alarm: { name: string }) => void;
    listener({ name: "tab-timer:r1" });
    await flushAsync();

    expect(chrome.notifications.create.calledWith("tab-timer-notification:r1")).toBe(true);
    // 重複発火の回帰確認：ensureReconciled()経由のreconcileNormal()と
    // handleAlarm()の両方がこのレコードに触れ得るが、通知は1回だけに
    // 限定されるべき（Stage5実装レビューで発見されたblockerの回帰）。
    expect(chrome.notifications.create.callCount).toBe(1);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1?.status).toBe("notified");
  });

  it("対象タブが消えていれば通知せずレコードを削除する", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "scheduled", fireAt: 1000 }) },
      recentlyCancelled: [],
    });
    chrome.tabs.get.withArgs(1).rejects(new Error("no tab"));
    await loadBackgroundFresh();

    const listener = chrome.alarms.onAlarm.addListener.lastCall.args[0] as (alarm: { name: string }) => void;
    listener({ name: "tab-timer:r1" });
    await flushAsync();

    expect(chrome.notifications.create.called).toBe(false);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1).toBeUndefined();
  });
});

describe("background: crash-resume（firing残留からの再開）", () => {
  it("statusがfiringのまま通知が無い状態から、整合処理で通知を1件だけ作成する", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "firing", fireAt: 1000 }) },
      recentlyCancelled: [],
    });
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room" }));
    await loadBackgroundFresh();

    await dispatchMessage<GetStateResponse>({ type: "GET_STATE" });

    expect(chrome.notifications.create.callCount).toBe(1);
    expect(chrome.notifications.create.calledWith("tab-timer-notification:r1")).toBe(true);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1?.status).toBe("notified");
  });
});

describe("background: notifications.onClicked・onClosed", () => {
  it("onClickedは対象タブが有効ならフォーカスしレコードを削除する", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "notified" }) },
      recentlyCancelled: [],
    });
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/room", windowId: 9 }));
    await loadBackgroundFresh();

    const listener = chrome.notifications.onClicked.addListener.lastCall.args[0] as (id: string) => void;
    listener("tab-timer-notification:r1");
    await flushAsync();

    expect(chrome.windows.update.calledWith(9, { focused: true })).toBe(true);
    expect(chrome.tabs.update.calledWith(1, { active: true })).toBe(true);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1).toBeUndefined();
  });

  it("onClickedは対象タブは存在するがoriginAndPathが変わっていればフォーカスせずレコードのみ削除する", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "notified" }) },
      recentlyCancelled: [],
    });
    chrome.tabs.get.withArgs(1).resolves(fakeTab({ id: 1, url: "https://example.com/other-page", windowId: 9 }));
    await loadBackgroundFresh();

    const listener = chrome.notifications.onClicked.addListener.lastCall.args[0] as (id: string) => void;
    listener("tab-timer-notification:r1");
    await flushAsync();

    expect(chrome.windows.update.called).toBe(false);
    expect(chrome.tabs.update.called).toBe(false);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1).toBeUndefined();
  });

  it("onClosedはstatusがnotifiedの場合のみレコードを削除する", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "notified" }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.notifications.onClosed.addListener.lastCall.args[0] as (id: string) => void;
    listener("tab-timer-notification:r1");
    await flushAsync();

    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1).toBeUndefined();
  });
});

describe("background: 新しいブラウザセッションの最初のSW起動（破棄処理）", () => {
  it("セッションマーカーが無ければ、イベント種別に関わらず既存のalarm・通知・storageをすべて破棄する", async () => {
    // セッションマーカーを未設定にし、「新しいブラウザセッションの最初の
    // SW起動」を模倣する（onStartupイベント自体の発火有無には依存せず、
    // どのイベント経由でensureReconciled()が呼ばれても同じ判定になる
    // ことを検証するため、あえてtabs.onRemovedイベント経由で起動する）。
    chromeExtra.storage.session.get.callsFake(() => Promise.resolve({}));
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    chrome.alarms.getAll.resolves([{ name: "tab-timer:r1" }]);
    chrome.notifications.getAll.resolves({ "tab-timer-notification:r1": true });
    await loadBackgroundFresh();

    const listener = chrome.tabs.onRemoved.addListener.lastCall.args[0] as (tabId: number) => void;
    listener(999); // r1とは無関係なタブの削除イベント
    await flushAsync();

    expect(chrome.alarms.clear.calledWith("tab-timer:r1")).toBe(true);
    expect(chrome.notifications.clear.calledWith("tab-timer-notification:r1")).toBe(true);
    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(Object.keys(stored.timerState.timersById)).toHaveLength(0);
  });

  it("セッションマーカーが設定済みなら破棄せず通常整合のみ行う", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1 }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    await dispatchMessage<GetStateResponse>({ type: "GET_STATE" });

    const stored = (await chrome.storage.local.get("timerState")) as { timerState: TimerState };
    expect(stored.timerState.timersById.r1).toBeDefined();
  });
});

describe("background: notifiedレコードの再発火を防ぐ（Stage5実装レビューで発見されたblockerの回帰テスト）", () => {
  it("notifiedレコードには整合処理でalarmを再作成しない", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "notified" }) },
      recentlyCancelled: [],
    });
    chrome.alarms.getAll.resolves([]); // 一回限りalarmは発火後に自動削除され既に存在しない
    await loadBackgroundFresh();

    await dispatchMessage<GetStateResponse>({ type: "GET_STATE" });

    expect(chrome.alarms.create.called).toBe(false);
    expect(chrome.notifications.create.called).toBe(false);
  });

  it("notifiedレコードのalarm名でonAlarmが発火しても再通知しない", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: { r1: fakeRecord({ id: "r1", tabId: 1, status: "notified" }) },
      recentlyCancelled: [],
    });
    await loadBackgroundFresh();

    const listener = chrome.alarms.onAlarm.addListener.lastCall.args[0] as (alarm: { name: string }) => void;
    listener({ name: "tab-timer:r1" });
    await flushAsync();

    expect(chrome.notifications.create.called).toBe(false);
  });
});

describe("background: GET_STATE", () => {
  it("現在タブのタイマー・全タイマー一覧（終了時刻順）を返す", async () => {
    await seedState({
      schemaVersion: 1,
      timersById: {
        r1: fakeRecord({ id: "r1", tabId: 1, fireAt: Date.now() + 20_000 }),
        r2: fakeRecord({ id: "r2", tabId: 2, fireAt: Date.now() + 10_000 }),
      },
      recentlyCancelled: [],
    });
    chrome.tabs.query.withArgs({ active: true, currentWindow: true }).resolves([fakeTab({ id: 1, url: "https://example.com/room" })]);
    await loadBackgroundFresh();

    const response = await dispatchMessage<GetStateResponse>({ type: "GET_STATE" });

    expect(response.currentTabId).toBe(1);
    expect(response.currentTabTimer?.id).toBe("r1");
    expect(response.allTimers.map((t) => t.id)).toEqual(["r2", "r1"]);
  });
});
