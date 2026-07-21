import type { CancelReason, TimerRecord } from "./timer-types";

export interface GetStateRequest {
  type: "GET_STATE";
}

export interface GetStateResponse {
  currentTabId: number | undefined;
  currentTabTitle: string | undefined;
  currentTabTimer: TimerRecord | undefined;
  // ポップアップは"url-changed"の場合のみ「ページの遷移により解除されました」
  // を表示する（"manual"はユーザー自身の操作、"tab-closed"はタブが無く
  // ポップアップを開けないため、バナー表示は不要）。
  currentTabCancelledReason: CancelReason | undefined;
  allTimers: TimerRecord[];
}

export interface SetTimerRequest {
  type: "SET_TIMER";
  tabId: number;
  fireAt: number;
}

export interface CancelTimerRequest {
  type: "CANCEL_TIMER";
  tabId: number;
}

export type ActionRequest = SetTimerRequest | CancelTimerRequest;

export type ActionResponse = { ok: true } | { ok: false; reason: string };

export type Request = GetStateRequest | ActionRequest;
