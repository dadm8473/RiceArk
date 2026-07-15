import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import app from "../index";
import { saveCompletionPatches } from "../db/completions";
import type { Env } from "../env";
import { completionPatchSchema } from "./dashboard";

const completionRouteEnv = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret"
};

interface CapturedCompletionStatement {
  sql: string;
  values: unknown[];
}

function createCompletionDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_template INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_overrides (
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, task_id)
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE completions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      character_id TEXT,
      target_key TEXT NOT NULL,
      period_key TEXT NOT NULL,
      completed INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, task_id, target_key, period_key)
    );
  `);
  return database;
}

function createCompletionEnv(database: DatabaseSync): { env: Env; statements: CapturedCompletionStatement[] } {
  const statements: CapturedCompletionStatement[] = [];
  const execute = (statement: CapturedCompletionStatement) => {
    const values = statement.values as SQLInputValue[];
    if (/\bRETURNING\b/i.test(statement.sql)) {
      const rows = database.prepare(statement.sql).all(...values);
      return { success: true, meta: { changes: rows.length }, results: rows };
    }
    const result = database.prepare(statement.sql).run(...values);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  };
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          }
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch: CapturedCompletionStatement[]) {
        database.exec("BEGIN");
        try {
          const results = batch.map(execute);
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    }
  } as unknown as Env;
  return { env, statements };
}

describe("completionPatchSchema", () => {
  it("accepts reset period completion patches", () => {
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "template-kurzan-front",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized or unsafe completion patch identifiers", () => {
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "task🙂",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(false);
    expect(
      completionPatchSchema.safeParse({
        patches: [
          {
            taskId: "task-1",
            characterId: "character-1",
            periodKey: "daily:" + "1".repeat(10_000),
            completed: true
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("set-based legacy completions", () => {
  it("keeps the accepted 200-patch route at two statements including authentication", async () => {
    const prepared: CapturedCompletionStatement[] = [];
    const env = {
      ...completionRouteEnv,
      DB: {
        prepare(sql: string) {
          const statement = {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              this.values = values;
              return this;
            },
            async first() {
              return sql.includes("FROM sessions")
                ? { id: "user-1", display_name: "Tester", avatar_url: null }
                : null;
            }
          };
          prepared.push(statement);
          return statement;
        },
        async batch(statements: CapturedCompletionStatement[]) {
          const rows = JSON.parse(String(statements[0]?.values[1])) as Array<{
            taskId: string;
            targetKey: string;
            periodKey: string;
          }>;
          return [{
            success: true,
            results: rows.map((row) => ({
              task_id: row.taskId,
              target_key: row.targetKey,
              period_key: row.periodKey
            }))
          }];
        }
      }
    } as unknown as Env;
    const patches = Array.from({ length: 200 }, (_, index) => ({
      taskId: "task-1",
      characterId: `character-${index}`,
      periodKey: "daily:2026-06-01",
      completed: index % 2 === 0
    }));

    const response = await app.request("/api/completions", {
      method: "PATCH",
      headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ patches })
    }, env);

    expect(response.status).toBe(200);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("FROM sessions");
    expect(prepared[1]?.sql).toContain("json_each(?2)");
    expect(prepared.every((statement) => statement.values.length < 100)).toBe(true);
  });

  it("saves the 200-patch schema maximum in one bounded JSON statement", async () => {
    const database = createCompletionDatabase();
    try {
      database.prepare("INSERT INTO tasks (id, is_template) VALUES ('task-1', 1)").run();
      const insertCharacter = database.prepare("INSERT INTO characters (id, user_id) VALUES (?, 'user-1')");
      for (let index = 0; index < 200; index += 1) insertCharacter.run(`character-${index}`);
      const patches = Array.from({ length: 200 }, (_, index) => ({
        taskId: "task-1",
        characterId: `character-${index}`,
        periodKey: `custom:2026-06-${String(index + 1).padStart(3, "0")}`,
        completed: index % 2 === 0
      }));
      const { env, statements } = createCompletionEnv(database);

      await saveCompletionPatches(env, "user-1", patches);

      expect(statements).toHaveLength(1);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("INSERT INTO completions"))).toHaveLength(1);
      expect(statements.some((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM completions").get()).toEqual({ count: 200 });
    } finally {
      database.close();
    }
  });

  it("rejects every completion when one character is not owned and active", async () => {
    const database = createCompletionDatabase();
    try {
      database.prepare("INSERT INTO tasks (id, is_template) VALUES ('task-1', 1)").run();
      database.prepare("INSERT INTO characters (id, user_id) VALUES ('character-owned', 'user-1'), ('character-foreign', 'user-2')").run();
      const { env } = createCompletionEnv(database);

      await expect(saveCompletionPatches(env, "user-1", [
        { taskId: "task-1", characterId: "character-owned", periodKey: "daily:2026-06-01", completed: true },
        { taskId: "task-1", characterId: "character-foreign", periodKey: "daily:2026-06-01", completed: true }
      ])).rejects.toThrow("Completion patch targets are unavailable");
      expect(database.prepare("SELECT COUNT(*) AS count FROM completions").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("does no D1 work for an empty completion array", async () => {
    const database = createCompletionDatabase();
    try {
      const { env, statements } = createCompletionEnv(database);
      await saveCompletionPatches(env, "user-1", []);
      expect(statements).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate completion RETURNING keys", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              this.values = values;
              return this;
            }
          };
        },
        async batch() {
          return [{
            results: [
              { task_id: "task-1", target_key: "character-1", period_key: "daily:2026-06-01" },
              { task_id: "task-1", target_key: "character-1", period_key: "daily:2026-06-01" }
            ]
          }];
        }
      }
    } as unknown as Env;

    await expect(saveCompletionPatches(env, "user-1", [
      { taskId: "task-1", characterId: "character-1", periodKey: "daily:2026-06-01", completed: true },
      { taskId: "task-1", characterId: "character-2", periodKey: "daily:2026-06-01", completed: true }
    ])).rejects.toThrow("Completion patch write did not return every patch");
  });
});
