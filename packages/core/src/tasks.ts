import type { ResetRule, ResetType, TaskScope } from "./types";

interface BuildTaskInput {
  name: string;
  scope: TaskScope;
  resetType: ResetType;
  anchorDate?: string | undefined;
  intervalDays?: number | undefined;
}

export function buildTaskDefinition(input: BuildTaskInput) {
  const resetRule: ResetRule =
    input.resetType === "daily"
      ? { type: "daily", hour: 6, timezone: "Asia/Seoul" }
      : input.resetType === "weekly"
        ? { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" }
        : input.resetType === "biweekly"
          ? {
              type: "biweekly",
              weekday: 3,
              hour: 6,
              timezone: "Asia/Seoul",
              anchorDate: input.anchorDate ?? "2026-05-27"
            }
          : {
              type: "custom",
              intervalDays: input.intervalDays ?? 1,
              hour: 6,
              timezone: "Asia/Seoul",
              anchorDate: input.anchorDate ?? "2026-05-29"
            };

  return {
    id: crypto.randomUUID(),
    name: input.name,
    scope: input.scope,
    resetRule,
    sortOrder: 0,
    enabled: true
  };
}
