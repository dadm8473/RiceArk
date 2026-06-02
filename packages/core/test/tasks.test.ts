import { describe, expect, it } from "vitest";
import { buildTaskDefinition } from "../src/tasks";

describe("buildTaskDefinition", () => {
  it("creates a character daily task with the KST reset hour", () => {
    expect(buildTaskDefinition({ name: "쿠르잔 전선", scope: "character", resetType: "daily" })).toMatchObject({
      name: "쿠르잔 전선",
      scope: "character",
      resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" }
    });
  });

  it("creates weekly and no-reset tasks with explicit reset rules", () => {
    expect(buildTaskDefinition({ name: "4막", scope: "character", resetType: "weekly" })).toMatchObject({
      resetRule: { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" }
    });
    expect(buildTaskDefinition({ name: "메모", scope: "character", resetType: "none" })).toMatchObject({
      resetRule: { type: "none" }
    });
  });
});
