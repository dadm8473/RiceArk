export interface DashboardCharacter {
  id: string;
  name: string;
  display_name: string | null;
  server_name: string;
  class_name: string;
  item_level: string;
  combat_power: string | null;
}

export interface DashboardTask {
  id: string;
  name: string;
  scope: "character" | "roster";
  reset_type: "daily" | "weekly" | "biweekly" | "custom";
  reset_rule_json: string;
}

export interface DashboardPayload {
  characters: DashboardCharacter[];
  tasks: DashboardTask[];
  completions: Array<{
    task_id: string;
    character_id: string | null;
    period_key: string;
    completed: number;
  }>;
  settings: {
    density: "comfortable" | "default" | "compact";
    row_height: number;
    column_width: number;
    checklist_orientation: "tasks_rows" | "tasks_columns";
  };
}
