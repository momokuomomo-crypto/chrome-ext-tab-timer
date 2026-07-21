import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chrome from "sinon-chrome";
import type { GetStateResponse } from "../../src/shared/messages";
import type { TimerRecord } from "../../src/shared/timer-types";

function mountPopupDom(): void {
  document.body.innerHTML = `
    <p id="error" hidden></p>
    <p id="cancelled-banner" hidden></p>
    <section id="current-tab-section">
      <p id="current-tab-title"></p>
      <div id="no-timer-form">
        <div class="presets">
          <button data-minutes="15" class="preset-button">15分</button>
          <button data-minutes="30" class="preset-button">30分</button>
          <button data-minutes="60" class="preset-button">1時間</button>
          <button data-minutes="120" class="preset-button">2時間</button>
        </div>
        <input type="datetime-local" id="custom-datetime" />
        <button id="set-custom-button">この日時で設定</button>
      </div>
      <div id="existing-timer" hidden>
        <p id="existing-timer-info"></p>
        <input type="datetime-local" id="change-datetime" />
        <button id="change-button">変更</button>
        <button id="cancel-button">キャンセル</button>
      </div>
    </section>
    <ul id="timer-list"></ul>
    <p id="timer-list-empty" hidden></p>
  `;
}

async function loadPopupFresh(): Promise<void> {
  vi.resetModules();
  mountPopupDom();
  await import("../../src/popup/popup");
  await flushMicrotasks();
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function record(overrides: Partial<TimerRecord> & Pick<TimerRecord, "id" | "tabId" | "fireAt">): TimerRecord {
  return {
    alarmName: `tab-timer:${overrides.id}`,
    notificationId: `tab-timer-notification:${overrides.id}`,
    title: "会議ページ",
    url: "https://example.com/room",
    originAndPath: "https://example.com/room",
    createdAt: 0,
    status: "scheduled",
    ...overrides,
  };
}

function baseState(overrides: Partial<GetStateResponse> = {}): GetStateResponse {
  return {
    currentTabId: 1,
    currentTabTitle: "会議ページ",
    currentTabTimer: undefined,
    currentTabCancelledReason: undefined,
    allTimers: [],
    ...overrides,
  };
}

beforeEach(() => {
  chrome.runtime.sendMessage.resolves({ ok: true });
});

afterEach(() => {
  chrome.runtime.sendMessage.reset();
});

describe("popup: 現在タブにタイマーが無い場合", () => {
  it("設定フォームを表示する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();

    expect((document.getElementById("no-timer-form") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("existing-timer") as HTMLElement).hidden).toBe(true);
  });

  it("現在タブのタイトルを表示する（Stage5実装レビューで発見された未使用UI要素の修正）", async () => {
    chrome.runtime.sendMessage
      .withArgs({ type: "GET_STATE" })
      .resolves(baseState({ currentTabTitle: "第3四半期振り返り会議" }));
    await loadPopupFresh();

    expect(document.getElementById("current-tab-title")?.textContent).toBe("第3四半期振り返り会議");
  });

  it("プリセットボタンはSET_TIMERを送信する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();

    const before = Date.now();
    const button15 = [...document.querySelectorAll<HTMLButtonElement>(".preset-button")].find(
      (b) => b.dataset.minutes === "15",
    );
    button15?.click();
    await flushMicrotasks();

    expect(chrome.runtime.sendMessage.calledWithMatch({ type: "SET_TIMER", tabId: 1 })).toBe(true);
    const call = chrome.runtime.sendMessage
      .getCalls()
      .find((c) => (c.args[0] as { type: string }).type === "SET_TIMER");
    const fireAt = (call?.args[0] as { fireAt: number }).fireAt;
    expect(fireAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  });

  it("任意日時の指定でSET_TIMERを送信する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();

    const input = document.getElementById("custom-datetime") as HTMLInputElement;
    input.value = "2026-08-01T10:00";
    (document.getElementById("set-custom-button") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(chrome.runtime.sendMessage.calledWithMatch({ type: "SET_TIMER", tabId: 1 })).toBe(true);
  });

  it("日時未入力でエラーを表示する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();

    (document.getElementById("set-custom-button") as HTMLButtonElement).click();
    await flushMicrotasks();

    const errorEl = document.getElementById("error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
  });
});

describe("popup: 現在タブにタイマーが設定済みの場合", () => {
  const state = baseState({
    currentTabTimer: record({ id: "r1", tabId: 1, fireAt: Date.now() + 30 * 60_000 }),
  });

  it("既存タイマー情報を表示しフォームを隠す", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(state);
    await loadPopupFresh();

    expect((document.getElementById("no-timer-form") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("existing-timer") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("existing-timer-info")?.textContent).toContain("終了日時");
  });

  it("キャンセルボタンはCANCEL_TIMERを送信する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(state);
    await loadPopupFresh();

    (document.getElementById("cancel-button") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(chrome.runtime.sendMessage.calledWithMatch({ type: "CANCEL_TIMER", tabId: 1 })).toBe(true);
  });

  it("変更ボタンはSET_TIMERを送信する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(state);
    await loadPopupFresh();

    const input = document.getElementById("change-datetime") as HTMLInputElement;
    input.value = "2026-09-01T09:30";
    (document.getElementById("change-button") as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(chrome.runtime.sendMessage.calledWithMatch({ type: "SET_TIMER", tabId: 1 })).toBe(true);
  });
});

describe("popup: キャンセル通知バナー", () => {
  it("url-changedの場合のみバナーを表示する", async () => {
    chrome.runtime.sendMessage
      .withArgs({ type: "GET_STATE" })
      .resolves(baseState({ currentTabCancelledReason: "url-changed" }));
    await loadPopupFresh();

    expect((document.getElementById("cancelled-banner") as HTMLElement).hidden).toBe(false);
  });

  it("manualの場合はバナーを表示しない", async () => {
    chrome.runtime.sendMessage
      .withArgs({ type: "GET_STATE" })
      .resolves(baseState({ currentTabCancelledReason: "manual" }));
    await loadPopupFresh();

    expect((document.getElementById("cancelled-banner") as HTMLElement).hidden).toBe(true);
  });
});

describe("popup: 全タブのタイマー一覧", () => {
  it("終了時刻順に表示し現在のタブにはラベルを付ける", async () => {
    const state = baseState({
      currentTabId: 1,
      allTimers: [
        record({ id: "r2", tabId: 2, fireAt: 1000, title: "別タブ" }),
        record({ id: "r1", tabId: 1, fireAt: 2000, title: "現在のページ" }),
      ],
    });
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(state);
    await loadPopupFresh();

    const items = [...document.querySelectorAll("#timer-list li")];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("別タブ");
    expect(items[1]?.textContent).toContain("現在のページ");
    expect(items[1]?.textContent).toContain("現在のタブ");
  });

  it("タイマーが無ければ空メッセージを表示する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();

    expect((document.getElementById("timer-list-empty") as HTMLElement).hidden).toBe(false);
  });
});

describe("popup: エラー処理", () => {
  it("GET_STATE失敗時にエラーを表示する", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).rejects(new Error("boom"));
    await loadPopupFresh();

    expect((document.getElementById("error") as HTMLElement).hidden).toBe(false);
  });

  it("アクション失敗時のエラーは直後のGET_STATE再取得で消えない", async () => {
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(baseState());
    await loadPopupFresh();
    chrome.runtime.sendMessage
      .withArgs({ type: "CANCEL_TIMER", tabId: 1 })
      .resolves({ ok: false, reason: "失敗しました。" });

    // no-timer-form状態だとcancelボタンは無いため、既存タイマーがある状態で確認する。
    chrome.runtime.sendMessage.withArgs({ type: "GET_STATE" }).resolves(
      baseState({ currentTabTimer: record({ id: "r1", tabId: 1, fireAt: Date.now() + 60_000 }) }),
    );
    vi.resetModules();
    mountPopupDom();
    await import("../../src/popup/popup");
    await flushMicrotasks();

    (document.getElementById("cancel-button") as HTMLButtonElement).click();
    await flushMicrotasks();

    const errorEl = document.getElementById("error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toBe("失敗しました。");
  });
});
