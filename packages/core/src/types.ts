export type ResetType = "daily" | "weekly" | "biweekly" | "custom" | "none";

export type ResetRule =
  | { type: "daily"; hour: number; timezone: "Asia/Seoul" }
  | { type: "weekly"; weekday: number; hour: number; timezone: "Asia/Seoul" }
  | { type: "biweekly"; weekday: number; hour: number; timezone: "Asia/Seoul"; anchorDate: string }
  | { type: "custom"; intervalDays: number; hour: number; timezone: "Asia/Seoul"; anchorDate: string }
  | { type: "none" };

export type TaskScope = "character" | "roster";

export interface TaskDefinition {
  id: string;
  name: string;
  scope: TaskScope;
  resetRule: ResetRule;
  sortOrder: number;
  enabled: boolean;
}

export interface CharacterSummary {
  id: string;
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface CompletionPatch {
  taskId: string;
  characterId: string | null;
  periodKey: string;
  completed: boolean;
}
