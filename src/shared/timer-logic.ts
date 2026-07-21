import type { TimerRecord } from "./timer-types";

export const MIN_LEAD_MS = 60_000;
export const RECENTLY_CANCELLED_TTL_MS = 5 * 60_000;
// 通知後、ユーザーが一切操作しなかった（タブを閉じる／URLを変える／
// 通知をクリックまたは明示的に閉じる、のいずれも起きなかった）場合、
// notifiedレコードが無期限にstorageへ残り続けてしまう（実Chromeスモーク
// テスト監査で発見：通知が実際にOSの通知センターへ残る/残らないに関わらず、
// 拡張機能側のレコードは掃除されない）。24時間経てば不要とみなす。
export const STALE_NOTIFIED_TTL_MS = 24 * 60 * 60_000;

export function originAndPathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateFireAt(fireAt: number, now: number): ValidationResult {
  if (!Number.isFinite(fireAt)) return { ok: false, reason: "日時が不正です。" };
  if (fireAt < now + MIN_LEAD_MS) {
    return { ok: false, reason: "終了日時は現在から1分以上先を指定してください。" };
  }
  return { ok: true };
}

export function alarmNameFor(id: string): string {
  return `tab-timer:${id}`;
}

export function notificationIdFor(id: string): string {
  return `tab-timer-notification:${id}`;
}

export function idFromAlarmName(alarmName: string): string | null {
  const prefix = "tab-timer:";
  if (!alarmName.startsWith(prefix)) return null;
  return alarmName.slice(prefix.length);
}

export function isRecentlyCancelledValid(cancelledAt: number, now: number): boolean {
  return now - cancelledAt < RECENTLY_CANCELLED_TTL_MS;
}

// 期限超過（scheduledのままfireAtが過去）、またはfiring残留（通知作成前に
// Workerが停止した状態からの再開）のいずれかを「発火処理へ渡すべき」として
// 単一ルールへ統合する（Stage2で確定：従来の複数箇条を1つの判定に整理）。
export function shouldFire(record: TimerRecord, now: number): boolean {
  if (record.status === "firing") return true;
  return record.status === "scheduled" && record.fireAt <= now;
}

export function isStaleNotified(record: TimerRecord, now: number): boolean {
  return record.status === "notified" && now - record.fireAt >= STALE_NOTIFIED_TTL_MS;
}
