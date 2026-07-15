import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import app from "../index";
import { reorderTasks } from "../db/tasks";
import type { Env } from "../env";
import { createTaskSchema, taskIdParamSchema, taskOrderSchema, updateTaskSchema } from "./tasks";

const taskRouteEnv = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret"
};

interface CapturedTaskStatement {
  sql: string;
  values: unknown[];
}

function createTaskOrderEnv(database: DatabaseSync): { env: Env; statements: CapturedTaskStatement[] } {
  const statements: CapturedTaskStatement[] = [];
  const execute = (statement: CapturedTaskStatement) => {
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
          },
          async all() {
            return { results: database.prepare(sql).all(...(this.values as SQLInputValue[])) };
          }
        };
        statements.push(statement);
        return statement;
      },
      async batch(batch: CapturedTaskStatement[]) {
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

function createTaskOrderDatabase(): DatabaseSync {
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
    CREATE TABLE task_orders (
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, task_id)
    );
  `);
  return database;
}

describe("taskOrderSchema", () => {
  it("accepts ordered task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-b"] }).success).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-a"] }).success).toBe(false);
  });
});

describe("set-based task ordering", () => {
  it("keeps the accepted 200-task route at two statements including authentication", async () => {
    const prepared: CapturedTaskStatement[] = [];
    const env = {
      ...taskRouteEnv,
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
        async batch(statements: CapturedTaskStatement[]) {
          const ids = JSON.parse(String(statements[0]?.values[1])) as string[];
          return [{ success: true, results: ids.map((task_id) => ({ task_id })) }];
        }
      }
    } as unknown as Env;
    const taskIds = Array.from({ length: 200 }, (_, index) => `task-${index}`);

    const response = await app.request("/api/tasks/order", {
      method: "PATCH",
      headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ taskIds })
    }, env);

    expect(response.status).toBe(200);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]?.sql).toContain("FROM sessions");
    expect(prepared[1]?.sql).toContain("json_each(?2)");
    expect(prepared.every((statement) => statement.values.length < 100)).toBe(true);
  });

  it("orders the 200-task schema maximum in one bounded JSON statement", async () => {
    const database = createTaskOrderDatabase();
    try {
      const insert = database.prepare("INSERT INTO tasks (id, is_template) VALUES (?, 1)");
      for (let index = 0; index < 200; index += 1) insert.run(`task-${index}`);
      const taskIds = Array.from({ length: 200 }, (_, index) => `task-${199 - index}`);
      const { env, statements } = createTaskOrderEnv(database);

      await expect(reorderTasks(env, "user-1", taskIds)).resolves.toBe(true);

      expect(statements).toHaveLength(1);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("INSERT INTO task_orders"))).toHaveLength(1);
      expect(statements.some((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(database.prepare("SELECT task_id FROM task_orders ORDER BY sort_order").all().map((row) => row.task_id))
        .toEqual(taskIds);
    } finally {
      database.close();
    }
  });

  it("rejects the whole order when one task is unavailable", async () => {
    const database = createTaskOrderDatabase();
    try {
      database.prepare("INSERT INTO tasks (id, is_template) VALUES ('task-1', 1), ('task-2', 1)").run();
      database.prepare("INSERT INTO task_overrides (user_id, task_id, enabled) VALUES ('user-1', 'task-2', 0)").run();
      const { env } = createTaskOrderEnv(database);

      await expect(reorderTasks(env, "user-1", ["task-1", "task-2"])).resolves.toBe(false);
      expect(database.prepare("SELECT COUNT(*) AS count FROM task_orders").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("does no D1 work for an empty task order", async () => {
    const database = createTaskOrderDatabase();
    try {
      const { env, statements } = createTaskOrderEnv(database);
      await expect(reorderTasks(env, "user-1", [])).resolves.toBe(true);
      expect(statements).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate task order RETURNING ids", async () => {
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
          return [{ results: [{ task_id: "task-1" }, { task_id: "task-1" }] }];
        }
      }
    } as unknown as Env;

    await expect(reorderTasks(env, "user-1", ["task-1", "task-2"]))
      .rejects.toThrow("Task order did not return every task");
  });
});

describe("createTaskSchema", () => {
  it("defaults new tasks to character scope", () => {
    expect(createTaskSchema.parse({ name: "쿠르잔 전선", resetType: "daily" })).toMatchObject({
      name: "쿠르잔 전선",
      scope: "character",
      resetType: "daily"
    });
    expect(createTaskSchema.parse({ name: "쿠르잔 전선🔥", resetType: "daily" })).toMatchObject({
      name: "쿠르잔 전선🔥",
      scope: "character",
      resetType: "daily"
    });
    expect(createTaskSchema.parse({ name: "메모", resetType: "none" })).toMatchObject({
      name: "메모",
      scope: "character",
      resetType: "none"
    });
  });

  it("accepts a bounded create request id for idempotent task creation", () => {
    expect(createTaskSchema.parse({ name: "쿠르잔 전선", resetType: "daily", requestId: "task-create-1" })).toMatchObject({
      requestId: "task-create-1"
    });
    expect(createTaskSchema.safeParse({ name: "쿠르잔 전선", resetType: "daily", requestId: "task🙂" }).success).toBe(false);
  });

  it("accepts normalized task colors for board task creation", () => {
    expect(createTaskSchema.parse({ name: "쿠르잔 전선", resetType: "daily", color: "#BE123C" })).toMatchObject({
      color: "#be123c"
    });
    expect(createTaskSchema.safeParse({ name: "쿠르잔 전선", resetType: "daily", color: "red" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ name: "쿠르잔 전선", resetType: "daily", color: "#12345g" }).success).toBe(false);
  });

  it("rejects roster as a special task scope", () => {
    expect(createTaskSchema.safeParse({ name: "세르카", scope: "roster", resetType: "daily" }).success).toBe(false);
  });

  it("rejects unsafe task names", () => {
    expect(createTaskSchema.safeParse({ name: "쿠르잔\u200B전선", resetType: "daily" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ name: "쿠르잔\u0301전선", resetType: "daily" }).success).toBe(false);
  });
});

describe("updateTaskSchema", () => {
  it("accepts editable task name and reset type", () => {
    expect(updateTaskSchema.parse({ name: "에브니 큐브", resetType: "weekly" })).toMatchObject({
      name: "에브니 큐브",
      resetType: "weekly"
    });
    expect(updateTaskSchema.parse({ name: "에브니 큐브🙂", resetType: "weekly" })).toMatchObject({
      name: "에브니 큐브🙂",
      resetType: "weekly"
    });
    expect(updateTaskSchema.parse({ name: "메모", resetType: "none" })).toMatchObject({
      name: "메모",
      resetType: "none"
    });
  });

  it("rejects empty task names", () => {
    expect(updateTaskSchema.safeParse({ name: "", resetType: "daily" }).success).toBe(false);
  });

  it("rejects whitespace-only task names", () => {
    expect(updateTaskSchema.safeParse({ name: "   ", resetType: "daily" }).success).toBe(false);
  });

  it("normalizes safe task names", () => {
    expect(updateTaskSchema.parse({ name: "  ４막: 아르모체  ", resetType: "weekly" })).toMatchObject({
      name: "4막: 아르모체"
    });
  });
});

describe("taskIdParamSchema", () => {
  it("accepts non-empty task ids", () => {
    expect(taskIdParamSchema.safeParse({ id: "task-1" }).success).toBe(true);
  });

  it("rejects empty task ids", () => {
    expect(taskIdParamSchema.safeParse({ id: "" }).success).toBe(false);
  });
});
