import { emptyState, type TimerState } from "../shared/timer-types";

const STORAGE_KEY = "timerState";

export class UnsupportedSchemaError extends Error {}

let writeQueue: Promise<unknown> = Promise.resolve();

// 同一Worker内の設定・取消・発火・整合処理を直列化する（read-modify-write
// 競合を防ぐ）。ただしこれは同一Worker生存期間内でのみ有効な補助であり、
// 二重発火防止の実効的な安全網はTimerRecord.statusの発火直前の再検証である
// （Stage2で明記）。
export function enqueueTask<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function loadState(): Promise<TimerState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as TimerState | undefined;
  if (raw === undefined) return emptyState();
  if (raw.schemaVersion !== 1) {
    throw new UnsupportedSchemaError(`Unsupported schemaVersion: ${String((raw as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return raw;
}

export async function saveState(state: TimerState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
