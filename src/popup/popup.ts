import type { ActionRequest, ActionResponse, GetStateResponse, Request } from "../shared/messages";

const errorEl = document.getElementById("error") as HTMLElement;
const cancelledBannerEl = document.getElementById("cancelled-banner") as HTMLElement;
const currentTabTitleEl = document.getElementById("current-tab-title") as HTMLElement;
const noTimerFormEl = document.getElementById("no-timer-form") as HTMLElement;
const existingTimerEl = document.getElementById("existing-timer") as HTMLElement;
const existingTimerInfoEl = document.getElementById("existing-timer-info") as HTMLElement;
const customDatetimeEl = document.getElementById("custom-datetime") as HTMLInputElement;
const changeDatetimeEl = document.getElementById("change-datetime") as HTMLInputElement;
const setCustomButton = document.getElementById("set-custom-button") as HTMLButtonElement;
const changeButton = document.getElementById("change-button") as HTMLButtonElement;
const cancelButton = document.getElementById("cancel-button") as HTMLButtonElement;
const timerListEl = document.getElementById("timer-list") as HTMLElement;
const timerListEmptyEl = document.getElementById("timer-list-empty") as HTMLElement;

let latestState: GetStateResponse | undefined;

function showError(text: string): void {
  errorEl.textContent = text;
  errorEl.hidden = false;
}

function hideError(): void {
  errorEl.hidden = true;
}

function toDatetimeLocalValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDatetimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

async function sendRequest<T>(request: Request): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

function render(state: GetStateResponse): void {
  latestState = state;

  if (state.currentTabCancelledReason === "url-changed") {
    cancelledBannerEl.textContent = "このタブのタイマーはページの遷移により解除されました。";
    cancelledBannerEl.hidden = false;
  } else {
    cancelledBannerEl.hidden = true;
  }

  if (state.currentTabId === undefined) {
    currentTabTitleEl.textContent = "現在のタブを取得できません。";
    noTimerFormEl.hidden = true;
    existingTimerEl.hidden = true;
  } else if (state.currentTabTimer) {
    currentTabTitleEl.textContent = state.currentTabTitle ?? "";
    noTimerFormEl.hidden = true;
    existingTimerEl.hidden = false;
    existingTimerInfoEl.textContent = `終了日時：${formatDateTime(state.currentTabTimer.fireAt)}`;
    changeDatetimeEl.value = toDatetimeLocalValue(state.currentTabTimer.fireAt);
  } else {
    currentTabTitleEl.textContent = state.currentTabTitle ?? "";
    noTimerFormEl.hidden = false;
    existingTimerEl.hidden = true;
  }

  timerListEl.innerHTML = "";
  if (state.allTimers.length === 0) {
    timerListEmptyEl.hidden = false;
  } else {
    timerListEmptyEl.hidden = true;
    for (const timer of state.allTimers) {
      const li = document.createElement("li");
      const isCurrent = timer.tabId === state.currentTabId;
      li.textContent = `${timer.title}（${formatDateTime(timer.fireAt)}）${isCurrent ? "・現在のタブ" : ""}`;
      timerListEl.appendChild(li);
    }
  }
}

async function loadState(): Promise<void> {
  try {
    const state = await sendRequest<GetStateResponse>({ type: "GET_STATE" });
    render(state);
  } catch {
    showError("状態の取得に失敗しました。");
  }
}

async function runAction(request: ActionRequest): Promise<void> {
  try {
    const response = await sendRequest<ActionResponse>(request);
    if (response.ok) {
      hideError();
    } else {
      showError(response.reason);
    }
  } catch {
    showError("操作に失敗しました。");
  } finally {
    // render()はエラー表示を消さない（B-8で確立したパターンを踏襲。
    // 直後のGET_STATE再取得でアクションのエラーメッセージが消えないように
    // している）。
    await loadState();
  }
}

function setTimerForCurrentTab(fireAt: number): void {
  if (latestState?.currentTabId === undefined) return;
  void runAction({ type: "SET_TIMER", tabId: latestState.currentTabId, fireAt });
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".preset-button")) {
  button.addEventListener("click", () => {
    const minutes = Number(button.dataset.minutes);
    setTimerForCurrentTab(Date.now() + minutes * 60_000);
  });
}

setCustomButton.addEventListener("click", () => {
  const fireAt = parseDatetimeLocalValue(customDatetimeEl.value);
  if (fireAt === null) {
    showError("日時を指定してください。");
    return;
  }
  setTimerForCurrentTab(fireAt);
});

changeButton.addEventListener("click", () => {
  const fireAt = parseDatetimeLocalValue(changeDatetimeEl.value);
  if (fireAt === null) {
    showError("日時を指定してください。");
    return;
  }
  setTimerForCurrentTab(fireAt);
});

cancelButton.addEventListener("click", () => {
  if (latestState?.currentTabId === undefined) return;
  void runAction({ type: "CANCEL_TIMER", tabId: latestState.currentTabId });
});

void loadState();
