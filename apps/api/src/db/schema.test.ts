import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("apps/api/migrations/0001_initial.sql", "utf8");

describe("D1 schema", () => {
  it("defines required application tables", () => {
    for (const table of [
      "users",
      "oauth_accounts",
      "sessions",
      "characters",
      "tasks",
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
});
