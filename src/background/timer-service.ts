import {
  alarmNameFor,
  idFromAlarmName,
  isRecentlyCancelledValid,
  notificationIdFor,
  originAndPathOf,
  shouldFire,
  validateFireAt,
} from "../shared/timer-logic";
import type { ActionResponse } from "../shared/messages";
import type { CancelReason, TimerRecord, TimerState } from "../shared/timer-types";
import { loadState, saveState } from "./storage";

const ALARM_PREFIX = "tab-timer:";
const NOTIFICATION_PREFIX = "tab-timer-notification:";

function findRecordByTabId(state: TimerState, tabId: number): TimerRecord | undefined {
  return Object.values(state.timersById).find((record) => record.tabId === tabId);
}

function findRecordByNotificationId(state: TimerState, notificationId: string): TimerRecord | undefined {
  return Object.values(state.timersById).find((record) => record.notificationId === notificationId);
}

function pruneRecentlyCancelled(state: TimerState, now: number): void {
  state.recentlyCancelled = state.recentlyCancelled.filter((entry) =>
    isRecentlyCancelledValid(entry.cancelledAt, now),
  );
}

export async function createTimer(
  tabId: number,
  title: string,
  url: string,
  fireAt: number,
  now: number,
): Promise<ActionResponse> {
  const validation = validateFireAt(fireAt, now);
  if (!validation.ok) return validation;

  const permissionLevel = await chrome.notifications.getPermissionLevel();
  if (permissionLevel !== "granted") {
    return { ok: false, reason: "Chromeの通知設定を有効にしてください。" };
  }

  const originAndPath = originAndPathOf(url);
  if (originAndPath === null) {
    return { ok: false, reason: "対応していないページです。" };
  }

  const state = await loadState();
  const existing = findRecordByTabId(state, tabId);
  if (existing) {
    // タブが閉じられたのではなく、同一タブへの再設定による置き換えである
    // （Stage5実装レビューで、"tab-closed"は意味的に誤りだと指摘された）。
    await cancelTimerInternal(state, existing, "replaced", now, { skipSave: true });
  }

  const id = crypto.randomUUID();
  const record: TimerRecord = {
    id,
    alarmName: alarmNameFor(id),
    notificationId: notificationIdFor(id),
    tabId,
    title,
    url,
    originAndPath,
    createdAt: now,
    fireAt,
    status: "scheduled",
  };

  state.timersById[id] = record;
  await saveState(state);

  try {
    await chrome.alarms.create(record.alarmName, { when: fireAt });
  } catch (error) {
    delete state.timersById[id];
    await saveState(state);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true };
}

// レコードのstatusに関わらず（notifiedであっても）必ず通知をclearしてから
// 削除する共通関数。recentlyCancelledへ5分TTLで追記する（Stage2で確定）。
async function cancelTimerInternal(
  state: TimerState,
  record: TimerRecord,
  reason: CancelReason,
  now: number,
  options: { skipSave?: boolean } = {},
): Promise<void> {
  try {
    await chrome.notifications.clear(record.notificationId);
  } catch {
    // 通知が既に存在しない場合等は無視する
  }
  try {
    await chrome.alarms.clear(record.alarmName);
  } catch {
    // 無視する
  }
  delete state.timersById[record.id];
  pruneRecentlyCancelled(state, now);
  state.recentlyCancelled.push({ tabId: record.tabId, reason, cancelledAt: now });

  if (!options.skipSave) {
    await saveState(state);
  }
}

export async function cancelTimer(tabId: number, reason: CancelReason, now: number): Promise<void> {
  const state = await loadState();
  const record = findRecordByTabId(state, tabId);
  if (!record) return;
  await cancelTimerInternal(state, record, reason, now);
}

export async function handleTabRemoved(tabId: number, now: number): Promise<void> {
  await cancelTimer(tabId, "tab-closed", now);
}

export async function handleTabUpdated(tabId: number, newUrl: string, now: number): Promise<void> {
  const state = await loadState();
  const record = findRecordByTabId(state, tabId);
  if (!record) return;

  const newOriginAndPath = originAndPathOf(newUrl);
  if (newOriginAndPath !== record.originAndPath) {
    await cancelTimerInternal(state, record, "url-changed", now);
  }
  // origin+pathnameが同じ（クエリ・ハッシュだけの変更）ならキャンセルしない。
}

// プリレンダリング等によるタブID差し替え。alarm名・通知IDはUUIDベースで
// tabIdに依存しないため、レコードのtabIdフィールドを書き換えるだけで
// 安全に移行できる（Stage2で確定）。
export async function handleTabReplaced(removedTabId: number, addedTabId: number): Promise<void> {
  const state = await loadState();
  const record = findRecordByTabId(state, removedTabId);
  if (!record) return;
  record.tabId = addedTabId;
  await saveState(state);
}

async function fireRecord(state: TimerState, record: TimerRecord, now: number): Promise<void> {
  record.status = "firing";
  await saveState(state);

  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(record.tabId);
  } catch {
    tab = undefined;
  }

  const currentOriginAndPath = tab?.url !== undefined ? originAndPathOf(tab.url) : null;
  if (tab === undefined || currentOriginAndPath !== record.originAndPath) {
    delete state.timersById[record.id];
    await saveState(state);
    return;
  }

  await chrome.notifications.create(record.notificationId, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "タブ・タイマー終了",
    message: `「${record.title}」の設定時間になりました`,
    eventTime: record.fireAt,
  });

  record.status = "notified";
  await saveState(state);
  void now; // 現状ではeventTimeにのみ使用（将来の拡張余地として引数を残す）
}

export async function handleAlarm(alarmName: string, now: number): Promise<void> {
  const id = idFromAlarmName(alarmName);
  if (id === null) return;

  const state = await loadState();
  const record = state.timersById[id];
  if (!record) return; // 対応レコードなし。孤立alarm（無害、整合処理が別途削除する）
  // 既にnotified（通知済み）のレコードは再発火しない（Stage5実装レビューで
  // 発見されたblocker：notifiedレコードへ再作成されたalarmが発火した際、
  // statusを確認せず無条件でfireRecord()を呼ぶと同じ通知IDで再通知して
  // しまう）。
  if (record.status === "notified") return;

  await fireRecord(state, record, now);
}

export async function handleNotificationClicked(notificationId: string): Promise<void> {
  const state = await loadState();
  const record = findRecordByNotificationId(state, notificationId);
  if (!record) return;

  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(record.tabId);
  } catch {
    tab = undefined;
  }
  const currentOriginAndPath = tab?.url !== undefined ? originAndPathOf(tab.url) : null;

  if (tab !== undefined && currentOriginAndPath === record.originAndPath && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(record.tabId, { active: true });
  }

  try {
    await chrome.notifications.clear(notificationId);
  } catch {
    // 無視する
  }
  delete state.timersById[record.id];
  await saveState(state);
}

export async function handleNotificationClosed(notificationId: string): Promise<void> {
  const state = await loadState();
  const record = findRecordByNotificationId(state, notificationId);
  if (!record) return;
  if (record.status !== "notified") return;
  delete state.timersById[record.id];
  await saveState(state);
}

// ブラウザ全体の再起動（onStartup）専用パス：storageに残っている全
// TimerRecordを無条件で破棄する。タブIDが新しいブラウザセッションで
// 無関係な別タブに再利用されている可能性を排除できないため、タブID＋URL
// 一致による再バインドは一切試みない（Stage2で確定）。
export async function discardAllTimersOnBrowserRestart(): Promise<void> {
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  const notifications = await chrome.notifications.getAll();
  for (const notificationId of Object.keys(notifications)) {
    if (notificationId.startsWith(NOTIFICATION_PREFIX)) {
      await chrome.notifications.clear(notificationId);
    }
  }

  await saveState({ schemaVersion: 1, timersById: {}, recentlyCancelled: [] });
}

// 同一ブラウザセッション内での通常のSW再起動（onInstalled・モジュール
// 評価時）専用パス。storageにある未来のタイマーに対応するalarmが無ければ
// 再作成し、孤立alarmを削除し、期限超過／firing残留レコードを発火処理へ
// 渡し、タブ不在／URL不一致レコードを削除する。
export async function reconcileNormal(now: number): Promise<void> {
  const state = await loadState();
  const existingAlarms = await chrome.alarms.getAll();
  const existingAlarmNames = new Set(existingAlarms.map((alarm) => alarm.name));

  for (const record of Object.values(state.timersById)) {
    if (shouldFire(record, now)) {
      let tab: chrome.tabs.Tab | undefined;
      try {
        tab = await chrome.tabs.get(record.tabId);
      } catch {
        tab = undefined;
      }
      const currentOriginAndPath = tab?.url !== undefined ? originAndPathOf(tab.url) : null;
      if (tab === undefined || currentOriginAndPath !== record.originAndPath) {
        delete state.timersById[record.id];
        continue;
      }
      await fireRecord(state, record, now);
      continue;
    }

    // alarmの再作成は"scheduled"のレコードにのみ許可する（Stage5実装
    // レビューで発見されたblocker：notifiedレコードは一回限りalarmが
    // 発火後に自動削除され「alarm無し」の状態が自然に生じるため、ここで
    // 無条件に再作成すると過去のfireAtでalarmが即座に再発火し、
    // handleAlarm()経由で再通知されてしまう）。
    if (record.status === "scheduled" && !existingAlarmNames.has(record.alarmName)) {
      await chrome.alarms.create(record.alarmName, { when: record.fireAt });
    }
  }

  for (const alarm of existingAlarms) {
    if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
    const stillReferenced = Object.values(state.timersById).some((r) => r.alarmName === alarm.name);
    if (!stillReferenced) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  pruneRecentlyCancelled(state, now);
  await saveState(state);
}
