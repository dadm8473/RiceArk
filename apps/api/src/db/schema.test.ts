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

  it("stores per-user task ordering without mutating shared templates", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_orders");
    expect(migration).toContain("PRIMARY KEY (user_id, task_id)");
  });

  it("stores per-user task edits without mutating shared templates", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS task_overrides");
    expect(migration).toContain("PRIMARY KEY (user_id, task_id)");
    expect(migration).toContain("reset_rule_json TEXT");
  });
});
