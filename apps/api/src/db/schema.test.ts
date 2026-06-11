import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const migration = readdirSync("apps/api/migrations")
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(`apps/api/migrations/${file}`, "utf8"))
  .join("\n");

describe("D1 schema", () => {
  it("defines required application tables", () => {
    for (const table of [
      "users",
      "oauth_accounts",
      "sessions",
      "characters",
      "tasks",
      "task_orders",
      "task_overrides",
      "completions",
      "user_settings",
      "rate_limit_events"
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("defines completion uniqueness by user task character and period", () => {
    expect(migration).toContain("UNIQUE (user_id, task_id, character_id, period_key)");
  });

  it("stores imported character combat power", () => {
    expect(migration).toContain("combat_power TEXT");
  });

  it("stores user-managed character memo text", () => {
    expect(migration).toContain("memo TEXT");
  });

  it("stores board foundation presentation settings", () => {
    expect(migration).toContain("display_name TEXT");
    expect(migration).toContain("checklist_orientation TEXT");
  });

  it("stores board table lock state", () => {
    expect(migration).toContain("locked INTEGER NOT NULL DEFAULT 0");
  });

  it("stores board table template metadata for event tables", () => {
    expect(migration).toContain("template_type TEXT NOT NULL DEFAULT 'custom'");
    expect(migration).toContain("template_type IN ('custom', 'lostark_event')");
    expect(migration).toContain("event_options_json TEXT");
  });

  it("stores board axis cross sizes for row width and column height", () => {
    expect(migration).toContain("cross_size_px INTEGER");
  });

  it("allows tasks that do not reset automatically", () => {
    expect(migration).toContain("reset_type IN ('daily', 'weekly', 'biweekly', 'custom', 'none')");
  });

  it("stores task creation request ids for idempotent creates", () => {
    expect(migration).toContain("create_request_id TEXT");
    expect(migration).toContain("idx_tasks_user_create_request");
    expect(migration).toContain("idx_board_axis_items_table_create_request");
  });

  it("stores whether a character is from Lost Ark API or manually created", () => {
    expect(migration).toContain("source TEXT NOT NULL DEFAULT 'lostark'");
    expect(migration).toContain("source IN ('lostark', 'manual')");
  });

  it("stores the latest character refresh attempt for cooldown enforcement", () => {
    expect(migration).toContain("last_refresh_attempt_at TEXT");
  });

  it("stores board notes as positioned canvas items", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS board_notes");
    expect(migration).toContain("sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE");
    expect(migration).toContain("title TEXT NOT NULL");
    expect(migration).toContain("body TEXT NOT NULL");
    expect(migration).toContain("x INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("y INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("width INTEGER NOT NULL DEFAULT 220");
    expect(migration).toContain("height INTEGER NOT NULL DEFAULT 160");
    expect(migration).toContain("color TEXT NOT NULL DEFAULT '#fef3c7'");
    expect(migration).toContain("locked INTEGER NOT NULL DEFAULT 0");
  });

  it("stores character display visibility settings", () => {
    for (const column of [
      "show_display_name INTEGER",
      "show_server_name INTEGER",
      "show_class_name INTEGER",
      "show_item_level INTEGER",
      "show_combat_power INTEGER"
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("stores per-user task ordering without mutating shared templates", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_orders");
    expect(migration).toContain("PRIMARY KEY (user_id, task_id)");
  });

  it("stores per-user task edits without mutating shared templates", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_overrides");
    expect(migration).toContain("PRIMARY KEY (user_id, task_id)");
    expect(migration).toContain("reset_rule_json TEXT");
  });

  it("defines board builder storage tables", () => {
    for (const table of [
      "sheets",
      "board_tables",
      "board_notes",
      "board_axis_items",
      "board_cell_states",
      "board_cell_completions"
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(migration).toContain("UNIQUE (user_id, name)");
    expect(migration).toContain("UNIQUE (table_id, axis, sort_order)");
    expect(migration).toContain("UNIQUE (table_id, row_item_id, column_item_id)");
    expect(migration).toContain("UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)");
  });

  it("indexes board data by user for D1 row-read efficiency", () => {
    for (const index of [
      "idx_board_tables_user_sort ON board_tables(user_id, sort_order)",
      "idx_board_axis_items_user_table_axis_sort ON board_axis_items(user_id, table_id, axis, sort_order)",
      "idx_board_notes_user_sort ON board_notes(user_id, sort_order)",
      "idx_board_cell_states_user_table ON board_cell_states(user_id, table_id)",
      "idx_board_cell_completions_user_period ON board_cell_completions(user_id, period_key)"
    ]) {
      expect(migration).toContain(index);
    }
  });

  it("stores aggregate admin error counters without request details", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS admin_error_counters");
    expect(migration).toContain("route_group TEXT NOT NULL");
    expect(migration).toContain("PRIMARY KEY (day, status, code, route_group)");
  });

  it("stores board sync versions and shared rice bin state", () => {
    for (const fragment of [
      "content_version INTEGER NOT NULL DEFAULT 0",
      "CREATE TABLE IF NOT EXISTS board_manifest_versions",
      "CREATE TABLE IF NOT EXISTS board_shares",
      "share_id TEXT NOT NULL UNIQUE",
      "CREATE TABLE IF NOT EXISTS board_share_favorites",
      "idx_board_shares_owner_sheet ON board_shares(owner_user_id, sheet_id)",
      "idx_board_shares_share_id ON board_shares(share_id)",
      "idx_board_share_favorites_user_sort ON board_share_favorites(user_id, created_at)",
      "UNIQUE (user_id, share_id)"
    ]) {
      expect(migration).toContain(fragment);
    }
  });
});
