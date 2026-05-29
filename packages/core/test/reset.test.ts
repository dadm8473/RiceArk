import { describe, expect, it } from "vitest";
import { getPeriodKey } from "../src/reset";
import type { ResetRule } from "../src/types";

describe("getPeriodKey", () => {
  it("keeps daily checks in the previous KST day before 06:00", () => {
    const rule: ResetRule = { type: "daily", hour: 6, timezone: "Asia/Seoul" };
    expect(getPeriodKey(rule, new Date("2026-05-28T20:59:00.000Z"))).toBe("daily:2026-05-28");
    expect(getPeriodKey(rule, new Date("2026-05-28T21:00:00.000Z"))).toBe("daily:2026-05-29");
  });

  it("resets weekly checks on Wednesday 06:00 KST", () => {
    const rule: ResetRule = { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" };
    expect(getPeriodKey(rule, new Date("2026-05-26T20:59:00.000Z"))).toBe("weekly:2026-05-20");
    expect(getPeriodKey(rule, new Date("2026-05-26T21:00:00.000Z"))).toBe("weekly:2026-05-27");
  });

  it("uses an anchor Wednesday for biweekly checks", () => {
    const rule: ResetRule = {
      type: "biweekly",
      weekday: 3,
      hour: 6,
      timezone: "Asia/Seoul",
      anchorDate: "2026-05-27"
    };
    expect(getPeriodKey(rule, new Date("2026-06-03T12:00:00.000Z"))).toBe("biweekly:2026-05-27");
    expect(getPeriodKey(rule, new Date("2026-06-10T00:00:00.000Z"))).toBe("biweekly:2026-06-10");
  });

  it("supports custom day intervals from an anchor date", () => {
    const rule: ResetRule = {
      type: "custom",
      intervalDays: 10,
      hour: 6,
      timezone: "Asia/Seoul",
      anchorDate: "2026-05-01"
    };
    expect(getPeriodKey(rule, new Date("2026-05-20T12:00:00.000Z"))).toBe("custom:2026-05-11");
    expect(getPeriodKey(rule, new Date("2026-05-21T00:00:00.000Z"))).toBe("custom:2026-05-21");
  });
});
