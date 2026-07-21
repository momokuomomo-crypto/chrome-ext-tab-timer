import chrome from "sinon-chrome";
import sinon from "sinon";
import { afterEach, beforeEach } from "vitest";

// sinon-chromeが提供するグローバルchrome APIフェイクを、テスト実行環境へ注入する。
(globalThis as unknown as { chrome: typeof chrome }).chrome = chrome;

// chrome.storage.local／chrome.storage.sessionの簡易フェイク。実際の
// storageは値をコピーして保存・返却する（参照共有ではない）ため、
// structuredCloneで模倣する。
let localStore: Record<string, unknown> = {};
let sessionStore: Record<string, unknown> = {};

function makeFakeGet(getStore: () => Record<string, unknown>) {
  return (keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> => {
    const store = getStore();
    if (keys === undefined) return Promise.resolve(structuredClone(store));
    const keyList = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const result: Record<string, unknown> = {};
    for (const key of keyList) {
      if (key in store) result[key] = structuredClone(store[key]);
    }
    return Promise.resolve(result);
  };
}

function makeFakeSet(getStore: () => Record<string, unknown>, setStore: (s: Record<string, unknown>) => void) {
  return (items: Record<string, unknown>): Promise<void> => {
    const store = getStore();
    for (const [key, value] of Object.entries(items)) {
      store[key] = structuredClone(value);
    }
    setStore(store);
    return Promise.resolve();
  };
}

// sinon-chrome(v3.0.1)はchrome.storage.sessionを持たない（MV3で後から
// 追加されたAPI）。手書きのsinon.stub()で補う。
export interface StorageSessionExtras {
  storage: {
    session: {
      get: sinon.SinonStub;
      set: sinon.SinonStub;
    };
  };
}

export const chromeExtra = chrome as unknown as StorageSessionExtras;
chromeExtra.storage.session = {
  get: sinon.stub(),
  set: sinon.stub(),
};

beforeEach(() => {
  chrome.flush();
  localStore = {};
  chrome.storage.local.get.callsFake(makeFakeGet(() => localStore));
  chrome.storage.local.set.callsFake(makeFakeSet(() => localStore, () => {}));

  // 既定では「同一ブラウザセッション内の通常のSW再起動」を模倣するため、
  // セッションマーカーを設定済みにしておく（大半のテストは通常整合の
  // 挙動を検証するため）。「新しいブラウザセッションの最初のSW起動
  // （破棄処理）」を検証するテストは、このマーカーを明示的にクリアする。
  sessionStore = { browserSessionMarker: true };
  chromeExtra.storage.session.get.reset();
  chromeExtra.storage.session.get.callsFake(makeFakeGet(() => sessionStore));
  chromeExtra.storage.session.set.reset();
  chromeExtra.storage.session.set.callsFake(makeFakeSet(() => sessionStore, () => {}));
});

afterEach(() => {
  chrome.flush();
});
