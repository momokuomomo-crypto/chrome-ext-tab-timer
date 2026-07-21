import { describe, expect, it } from "vitest";
import {
  MIN_LEAD_MS,
  RECENTLY_CANCELLED_TTL_MS,
  alarmNameFor,
  idFromAlarmName,
  isRecentlyCancelledValid,
  notificationIdFor,
  originAndPathOf,
  shouldFire,
  validateFireAt,
} from "../../src/shared/timer-logic";
import type { TimerRecord } from "../../src/shared/timer-types";

describe("originAndPathOf", () => {
  it("origin+pathnameを返す（クエリ・ハッシュは含めない）", () => {
    expect(originAndPathOf("https://example.com/meeting/123?token=abc#state")).toBe(
      "https://example.com/meeting/123",
    );
  });

  it("http/https以外・不正URLはnullを返す", () => {
    expect(originAndPathOf("chrome://extensions")).toBeNull();
    expect(originAndPathOf("not a url")).toBeNull();
  });

  it("クエリ・ハッシュだけが異なる場合は同じorigin+pathnameになる", () => {
    const a = originAndPathOf("https://example.com/room?token=1");
    const b = originAndPathOf("https://example.com/room?token=2#state");
    expect(a).toBe(b);
  });

  it("パスが異なれば別のorigin+pathnameになる", () => {
    const a = originAndPathOf("https://example.com/room-a");
    const b = originAndPathOf("https://example.com/room-b");
    expect(a).not.toBe(b);
  });
});

describe("validateFireAt", () => {
  const now = 1_000_000;

  it("1分以上先の日時は妥当と判定する", () => {
    expect(validateFireAt(now + MIN_LEAD_MS, now)).toEqual({ ok: true });
    expect(validateFireAt(now + 60 * 60_000, now)).toEqual({ ok: true });
  });

  it("1分未満・過去の日時は拒否する", () => {
    expect(validateFireAt(now + 1000, now).ok).toBe(false);
    expect(validateFireAt(now - 1000, now).ok).toBe(false);
  });

  it("不正な数値（NaN等）は拒否する", () => {
    expect(validateFireAt(NaN, now).ok).toBe(false);
  });
});

describe("alarmNameFor・notificationIdFor・idFromAlarmName", () => {
  it("固定のprefixでID化する", () => {
    expect(alarmNameFor("abc")).toBe("tab-timer:abc");
    expect(notificationIdFor("abc")).toBe("tab-timer-notification:abc");
  });

  it("alarm名からIDを復元する", () => {
    expect(idFromAlarmName("tab-timer:abc-123")).toBe("abc-123");
  });

  it("prefixが無いalarm名はnullを返す", () => {
    expect(idFromAlarmName("unrelated-alarm")).toBeNull();
  });
});

describe("isRecentlyCancelledValid", () => {
  it("TTL内はtrueを返す", () => {
    const now = 1_000_000;
    expect(isRecentlyCancelledValid(now - 1000, now)).toBe(true);
  });

  it("TTLを超えるとfalseを返す", () => {
    const now = 1_000_000;
    expect(isRecentlyCancelledValid(now - RECENTLY_CANCELLED_TTL_MS - 1, now)).toBe(false);
  });
});

function record(overrides: Partial<TimerRecord>): TimerRecord {
  return {
    id: "id",
    alarmName: "tab-timer:id",
    notificationId: "tab-timer-notification:id",
    tabId: 1,
    title: "t",
    url: "https://example.com/",
    originAndPath: "https://example.com/",
    createdAt: 0,
    fireAt: 0,
    status: "scheduled",
    ...overrides,
  };
}

describe("shouldFire", () => {
  const now = 1_000_000;

  it("statusがfiringなら常にtrue", () => {
    expect(shouldFire(record({ status: "firing", fireAt: now + 100_000 }), now)).toBe(true);
  });

  it("scheduledでfireAtが過去ならtrue", () => {
    expect(shouldFire(record({ status: "scheduled", fireAt: now - 1 }), now)).toBe(true);
  });

  it("scheduledでfireAtが未来ならfalse", () => {
    expect(shouldFire(record({ status: "scheduled", fireAt: now + 1 }), now)).toBe(false);
  });

  it("notifiedなら常にfalse", () => {
    expect(shouldFire(record({ status: "notified", fireAt: now - 1 }), now)).toBe(false);
  });
});
