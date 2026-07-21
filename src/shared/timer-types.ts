export type TimerStatus = "scheduled" | "firing" | "notified";

export interface TimerRecord {
  id: string;
  alarmName: string;
  notificationId: string;
  tabId: number;
  title: string;
  url: string;
  // origin+pathnameだけの比較キー。クエリ・ハッシュだけの変更では
  // キャンセルしない（Stage2で確定：会議・配信アプリがUI状態やトークンを
  // クエリ/ハッシュで更新するケースで無音失効するのを防ぐため）。
  originAndPath: string;
  createdAt: number;
  fireAt: number;
  status: TimerStatus;
}

export type CancelReason = "url-changed" | "tab-closed" | "manual" | "replaced";

export interface RecentlyCancelledEntry {
  tabId: number;
  reason: CancelReason;
  cancelledAt: number;
}

export interface TimerState {
  schemaVersion: 1;
  timersById: Record<string, TimerRecord>;
  recentlyCancelled: RecentlyCancelledEntry[];
}

export function emptyState(): TimerState {
  return { schemaVersion: 1, timersById: {}, recentlyCancelled: [] };
}
