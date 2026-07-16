import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Env } from "../env";
import type {
  BoardBootstrapPayload,
  BoardDisplaySettings,
  BoardSheetManifest,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardSheetPayloadItem,
  BoardVersionSummary
} from "./boardReads";
import { loadBoard, loadBoardVersionSummary, type BoardVersionSummary as BoardModuleVersionSummary } from "./board";
import {
  BoardSnapshotConflictError,
  loadBoardBootstrap,
  loadBoardManifest,
  loadBoardSheet
} from "./boardReads";

interface CapturedStatement {
  sql: string;
  values: SQLInputValue[];
}

interface SqliteD1Statement {
  captured: CapturedStatement;
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number }; results: unknown[] }>;
}

interface StatementExecution {
  statement: CapturedStatement;
  method: "first" | "all" | "run";
  executionIndex: number;
}

interface BatchStatementExecution {
  statement: CapturedStatement;
  batchIndex: number;
  statementIndex: number;
}

interface SqliteReadEnvOptions {
  afterExecute?: (execution: StatementExecution) => void | Promise<void>;
  afterBatchStatement?: (execution: BatchStatementExecution) => void;
}

function createBoardReadDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY,
      checklist_orientation TEXT NOT NULL DEFAULT 'tasks_rows',
      show_display_name INTEGER NOT NULL DEFAULT 1,
      show_server_name INTEGER NOT NULL DEFAULT 0,
      show_class_name INTEGER NOT NULL DEFAULT 0,
      show_item_level INTEGER NOT NULL DEFAULT 1,
      show_combat_power INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sheets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      content_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name)
    );
    CREATE TABLE board_manifest_versions (
      user_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_tables (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '숙제',
      sort_order INTEGER NOT NULL DEFAULT 0,
      x INTEGER NOT NULL DEFAULT 0,
      y INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      row_role TEXT NOT NULL DEFAULT 'task',
      column_role TEXT NOT NULL DEFAULT 'character',
      task_axis TEXT NOT NULL DEFAULT 'rows',
      default_row_height INTEGER NOT NULL DEFAULT 40,
      default_column_width INTEGER NOT NULL DEFAULT 132,
      locked INTEGER NOT NULL DEFAULT 0,
      display_options_json TEXT,
      event_options_json TEXT,
      template_type TEXT NOT NULL DEFAULT 'custom',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#fef3c7',
      sort_order INTEGER NOT NULL DEFAULT 0,
      x INTEGER NOT NULL DEFAULT 0,
      y INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 220,
      height INTEGER NOT NULL DEFAULT 160,
      locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      server_name TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      item_level TEXT NOT NULL DEFAULT '',
      combat_power TEXT,
      source TEXT NOT NULL DEFAULT 'lostark',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      reset_type TEXT NOT NULL,
      reset_rule_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_template INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_orders (
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, task_id)
    );
    CREATE TABLE task_overrides (
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      name TEXT,
      reset_type TEXT,
      reset_rule_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, task_id)
    );
    CREATE TABLE board_axis_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      axis TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      character_id TEXT,
      task_id TEXT,
      task_scope TEXT,
      task_reset_type TEXT,
      task_reset_rule_json TEXT,
      task_color TEXT,
      size_px INTEGER,
      cross_size_px INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      visible INTEGER NOT NULL DEFAULT 1,
      separator_json TEXT,
      display_options_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_cell_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      row_item_id TEXT NOT NULL,
      column_item_id TEXT NOT NULL,
      checkbox_visible INTEGER NOT NULL DEFAULT 1,
      mark_type TEXT NOT NULL DEFAULT 'default',
      mark_icon TEXT,
      memo TEXT,
      mark_period_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_cell_completions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      row_item_id TEXT NOT NULL,
      column_item_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      completed INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)
    );
    CREATE TABLE completions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      character_id TEXT,
      target_key TEXT NOT NULL,
      period_key TEXT NOT NULL,
      completed INTEGER NOT NULL
    );
  `);
  return database;
}

function createSqliteReadEnv(
  database: DatabaseSync,
  options: SqliteReadEnvOptions = {}
): { env: Env; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];
  let executionIndex = 0;
  let batchIndex = 0;

  const afterExecute = async (
    statement: CapturedStatement,
    method: StatementExecution["method"]
  ): Promise<void> => {
    await options.afterExecute?.({ statement, method, executionIndex });
    executionIndex += 1;
  };

  const createStatement = (captured: CapturedStatement): SqliteD1Statement => ({
    captured,
    bind(...values) {
      captured.values = values;
      return createStatement(captured);
    },
    async first<T>() {
      const result = (database.prepare(captured.sql).get(...captured.values) as T | undefined) ?? null;
      await afterExecute(captured, "first");
      return result;
    },
    async all<T>() {
      const results = database.prepare(captured.sql).all(...captured.values) as T[];
      await afterExecute(captured, "all");
      return { results };
    },
    async run() {
      const result = database.prepare(captured.sql).run(...captured.values);
      await afterExecute(captured, "run");
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    }
  });

  const env = {
    DB: {
      prepare(sql: string) {
        const captured = { sql, values: [] as SQLInputValue[] };
        statements.push(captured);
        return createStatement(captured);
      },
      async batch(batchStatements: SqliteD1Statement[]) {
        const currentBatchIndex = batchIndex;
        batchIndex += 1;
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = batchStatements.map((statement, statementIndex) => {
            const prepared = database.prepare(statement.captured.sql);
            if (/\bRETURNING\b/i.test(statement.captured.sql)) {
              const rows = prepared.all(...statement.captured.values);
              options.afterBatchStatement?.({
                statement: statement.captured,
                batchIndex: currentBatchIndex,
                statementIndex
              });
              return { success: true, meta: { changes: rows.length }, results: rows };
            }
            const result = prepared.run(...statement.captured.values);
            options.afterBatchStatement?.({
              statement: statement.captured,
              batchIndex: currentBatchIndex,
              statementIndex
            });
            return { success: true, meta: { changes: Number(result.changes) }, results: [] };
          });
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

function insertSheet(
  database: DatabaseSync,
  input: { id: string; userId: string; name: string; sortOrder: number; isDefault: number; version: number }
): void {
  database
    .prepare(
      `INSERT INTO sheets (id, user_id, name, sort_order, is_default, content_version)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.id, input.userId, input.name, input.sortOrder, input.isDefault, input.version);
}

function insertTable(database: DatabaseSync, id: string, userId: string, sheetId: string, name: string): void {
  database
    .prepare("INSERT INTO board_tables (id, user_id, sheet_id, name) VALUES (?, ?, ?, ?)")
    .run(id, userId, sheetId, name);
}

function insertAxisItem(
  database: DatabaseSync,
  input: {
    id: string;
    userId: string;
    tableId: string;
    axis: "row" | "column";
    kind: "task" | "character" | "custom";
    label: string;
    sortOrder: number;
    resetRule?: string;
    characterId?: string;
  }
): void {
  database
    .prepare(
      `INSERT INTO board_axis_items (
         id, user_id, table_id, axis, kind, label, character_id,
         task_reset_rule_json, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.tableId,
      input.axis,
      input.kind,
      input.label,
      input.characterId ?? null,
      input.resetRule ?? null,
      input.sortOrder
    );
}

function seedEstablishedBoard(database: DatabaseSync): void {
  database.prepare("INSERT INTO users (id, display_name) VALUES (?, ?), (?, ?)").run("user-1", "Owner", "user-2", "Other");
  database
    .prepare(
      `INSERT INTO user_settings (
         user_id, checklist_orientation, show_display_name, show_server_name,
         show_class_name, show_item_level, show_combat_power
       ) VALUES (?, 'tasks_rows', 1, 1, 0, 1, 0)`
    )
    .run("user-1");
  database.prepare("INSERT INTO board_manifest_versions (user_id, version) VALUES (?, ?)").run("user-1", 9);

  insertSheet(database, { id: "sheet-first", userId: "user-1", name: "First", sortOrder: 0, isDefault: 0, version: 2 });
  insertSheet(database, { id: "sheet-default", userId: "user-1", name: "Default", sortOrder: 10, isDefault: 1, version: 4 });
  insertSheet(database, { id: "sheet-active", userId: "user-1", name: "Active", sortOrder: 20, isDefault: 0, version: 7 });
  insertSheet(database, { id: "sheet-foreign", userId: "user-2", name: "Foreign", sortOrder: 0, isDefault: 1, version: 99 });

  insertTable(database, "table-first", "user-1", "sheet-first", "First table");
  insertTable(database, "table-default", "user-1", "sheet-default", "Default table");
  insertTable(database, "table-active", "user-1", "sheet-active", "Active table");
  insertTable(database, "table-cross", "user-1", "sheet-foreign", "Cross-sheet table");

  database
    .prepare("INSERT INTO board_notes (id, user_id, sheet_id, title, body) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)")
    .run(
      "note-active",
      "user-1",
      "sheet-active",
      "Active note",
      "Owned",
      "note-cross",
      "user-1",
      "sheet-foreign",
      "Cross note",
      "Foreign"
    );
  database
    .prepare(
      `INSERT INTO characters (
         id, user_id, name, display_name, server_name, class_name,
         item_level, combat_power, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run("character-1", "user-1", "Character", "Display", "Server", "Class", "1700", "12345", "lostark");

  const dailyRule = '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}';
  const weeklyRule = '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}';
  insertAxisItem(database, {
    id: "axis-weekly",
    userId: "user-1",
    tableId: "table-active",
    axis: "row",
    kind: "task",
    label: "Weekly",
    sortOrder: 0,
    resetRule: weeklyRule
  });
  insertAxisItem(database, {
    id: "axis-daily",
    userId: "user-1",
    tableId: "table-active",
    axis: "row",
    kind: "task",
    label: "Daily",
    sortOrder: 10,
    resetRule: dailyRule
  });
  insertAxisItem(database, {
    id: "axis-daily-copy",
    userId: "user-1",
    tableId: "table-active",
    axis: "row",
    kind: "task",
    label: "Daily copy",
    sortOrder: 20,
    resetRule: dailyRule
  });
  insertAxisItem(database, {
    id: "axis-character",
    userId: "user-1",
    tableId: "table-active",
    axis: "column",
    kind: "character",
    label: "Character",
    sortOrder: 0,
    characterId: "character-1"
  });
  insertAxisItem(database, {
    id: "axis-cross",
    userId: "user-1",
    tableId: "table-cross",
    axis: "row",
    kind: "task",
    label: "Cross",
    sortOrder: 0,
    resetRule: dailyRule
  });

  database
    .prepare(
      `INSERT INTO board_cell_states (
         id, user_id, table_id, row_item_id, column_item_id,
         mark_type, memo, mark_period_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "state-current",
      "user-1",
      "table-active",
      "axis-daily",
      "axis-character",
      "reserved",
      "current",
      "daily:2026-06-05",
      "state-expired",
      "user-1",
      "table-active",
      "axis-daily-copy",
      "axis-character",
      "reserved",
      "expired",
      "daily:2026-06-04",
      "state-fixed",
      "user-1",
      "table-active",
      "axis-weekly",
      "axis-character",
      "fixed",
      "fixed",
      null,
      "state-cross",
      "user-1",
      "table-cross",
      "axis-cross",
      "axis-character",
      "fixed",
      "cross",
      null
    );
  database
    .prepare(
      `INSERT INTO board_cell_completions (
         id, user_id, table_id, row_item_id, column_item_id, period_key, completed
       ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "completion-daily",
      "user-1",
      "table-active",
      "axis-daily",
      "axis-character",
      "daily:2026-06-05",
      1,
      "completion-weekly",
      "user-1",
      "table-active",
      "axis-weekly",
      "axis-character",
      "weekly:2026-06-03",
      1,
      "completion-stale",
      "user-1",
      "table-active",
      "axis-daily-copy",
      "axis-character",
      "daily:2026-06-04",
      1,
      "completion-cross",
      "user-1",
      "table-cross",
      "axis-cross",
      "axis-character",
      "daily:2026-06-05",
      1
    );
}

function seedDefaultTasks(database: DatabaseSync): void {
  const insert = database.prepare(
    `INSERT INTO tasks (
       id, user_id, name, scope, reset_type, reset_rule_json,
       sort_order, enabled, is_template
     ) VALUES (?, NULL, ?, 'character', ?, ?, ?, 1, 1)`
  );
  insert.run("task-daily-1", "Daily 1", "daily", '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 10);
  insert.run("task-daily-2", "Daily 2", "daily", '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}', 20);
  insert.run("task-weekly-1", "Weekly 1", "weekly", '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 30);
  insert.run("task-weekly-2", "Weekly 2", "weekly", '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}', 40);
}

function seedDefaultCharacters(database: DatabaseSync, count: number): void {
  const insert = database.prepare(
    `INSERT INTO characters (
       id, user_id, name, server_name, class_name, item_level, sort_order
     ) VALUES (?, 'user-1', ?, 'Server', 'Class', '1700', ?)`
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(`character-${index}`, `Character ${index}`, index * 10);
  }
}

async function withEstablishedBoard(
  test: (input: { database: DatabaseSync; env: Env; statements: CapturedStatement[] }) => Promise<void>
): Promise<void> {
  const database = createBoardReadDatabase();
  seedEstablishedBoard(database);
  const { env, statements } = createSqliteReadEnv(database);
  try {
    await test({ database, env, statements });
  } finally {
    database.close();
  }
}

const manifestItem = {
  id: "sheet-1",
  name: "숙제",
  sort_order: 10,
  is_default: 1,
  version: 7
} satisfies BoardSheetManifestItem;

const activeSheet = {
  sheet: {
    id: "sheet-1",
    name: "숙제",
    sort_order: 10,
    is_default: 1,
    content_version: 7
  },
  tables: [{ id: "table-1", sheet_id: "sheet-1" }],
  notes: [{ id: "note-1", sheet_id: "sheet-1" }],
  axisItems: [{ id: "axis-1", table_id: "table-1" }],
  cellStates: [{ table_id: "table-1", row_item_id: "axis-1", column_item_id: "axis-2" }],
  completions: [{ table_id: "table-1", row_item_id: "axis-1", column_item_id: "axis-2" }],
  periodFingerprint: "weekly:2026-07-15"
} satisfies BoardSheetPayload;

describe("sheet-aware board read contracts", () => {
  it("publishes the sheet-aware contracts from their dedicated read module", async () => {
    await expect(import("./boardReads")).resolves.toBeDefined();
  });

  it("carries sheet navigation metadata and its content version in each manifest item", () => {
    expectTypeOf<BoardSheetManifestItem>().toEqualTypeOf<{
      id: string;
      name: string;
      sort_order: number;
      is_default: number;
      version: number;
    }>();
    expectTypeOf<BoardSheetManifest>().toEqualTypeOf<{
      version: number;
      sheets: BoardSheetManifestItem[];
    }>();
    expect(manifestItem).toEqual({
      id: "sheet-1",
      name: "숙제",
      sort_order: 10,
      is_default: 1,
      version: 7
    });
  });

  it("defines one active sheet envelope instead of a legacy all-sheet payload", () => {
    expectTypeOf<BoardSheetPayloadItem>().toEqualTypeOf<{
      id: string;
      name: string;
      sort_order: number;
      is_default: number;
      content_version: number;
    }>();
    expectTypeOf<BoardSheetPayload>().toEqualTypeOf<{
      sheet: BoardSheetPayloadItem;
      tables: unknown[];
      notes: unknown[];
      axisItems: unknown[];
      cellStates: unknown[];
      completions: unknown[];
      periodFingerprint: string;
    }>();
    expect(Object.keys(activeSheet).sort()).toEqual([
      "axisItems",
      "cellStates",
      "completions",
      "notes",
      "periodFingerprint",
      "sheet",
      "tables"
    ]);
    expect("sheets" in activeSheet).toBe(false);
  });

  it("shares the manifest snapshot field types with bootstrap and legacy board imports", () => {
    expectTypeOf<BoardDisplaySettings>().toEqualTypeOf<{
      show_display_name: number;
      show_server_name: number;
      show_class_name: number;
      show_item_level: number;
      show_combat_power: number;
    }>();
    expectTypeOf<BoardBootstrapPayload["settings"]>().toEqualTypeOf<BoardDisplaySettings>();
    expectTypeOf<BoardBootstrapPayload["manifest"]["version"]>().toEqualTypeOf<
      BoardVersionSummary["manifestVersion"]
    >();
    expectTypeOf<BoardBootstrapPayload["manifest"]["sheets"]>().toEqualTypeOf<BoardVersionSummary["sheets"]>();
    expectTypeOf<BoardVersionSummary["settings"]>().toEqualTypeOf<BoardDisplaySettings>();
    expectTypeOf<BoardModuleVersionSummary>().toEqualTypeOf<BoardVersionSummary>();
    expectTypeOf<BoardVersionSummary["periodFingerprint"]>().toEqualTypeOf<"">();
  });
});

describe("sheet-aware board reads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the owner manifest and navigation metadata with one CTE statement", async () => {
    await withEstablishedBoard(async ({ env, statements }) => {
      await expect(loadBoardManifest(env, "user-1")).resolves.toEqual({
        version: 9,
        sheets: [
          { id: "sheet-first", name: "First", sort_order: 0, is_default: 0, version: 2 },
          { id: "sheet-default", name: "Default", sort_order: 10, is_default: 1, version: 4 },
          { id: "sheet-active", name: "Active", sort_order: 20, is_default: 0, version: 7 }
        ]
      });

      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("WITH manifest AS");
      expect(statements[0]?.sql).toContain("LEFT JOIN sheets");
      expect(statements[0]?.sql).not.toMatch(/SELECT\s+\*/i);
      expect(statements[0]?.values).toEqual(["user-1"]);
    });
  });

  it("selects requested owned sheets and falls back to default then first sorted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));

    await withEstablishedBoard(async ({ database, env, statements }) => {
      const requested = await loadBoardBootstrap(env, "user-1", "sheet-active");
      expect(requested.activeSheet.sheet.id).toBe("sheet-active");
      expect(requested.settings).toEqual({
        show_display_name: 1,
        show_server_name: 1,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      });
      expect(requested.manifest.sheets.find((sheet) => sheet.id === requested.activeSheet.sheet.id)?.version).toBe(
        requested.activeSheet.sheet.content_version
      );
      expect(statements).toHaveLength(8);
      const manifestStatements = statements.filter((statement) => statement.sql.includes("WITH manifest AS"));
      expect(manifestStatements).toHaveLength(2);
      expect(statements.filter((statement) => statement.sql.includes("user_settings"))).toEqual(manifestStatements);

      statements.length = 0;
      await expect(loadBoardBootstrap(env, "user-1", "sheet-foreign")).resolves.toMatchObject({
        activeSheet: { sheet: { id: "sheet-default" } }
      });

      statements.length = 0;
      await expect(loadBoardBootstrap(env, "user-1", "sheet-missing")).resolves.toMatchObject({
        activeSheet: { sheet: { id: "sheet-default" } }
      });
      expect(statements.some((statement) => statement.sql.includes("FROM board_cell_completions"))).toBe(false);

      database.prepare("UPDATE sheets SET is_default = 0 WHERE user_id = ?").run("user-1");
      statements.length = 0;
      await expect(loadBoardBootstrap(env, "user-1", "sheet-missing")).resolves.toMatchObject({
        activeSheet: { sheet: { id: "sheet-first" } }
      });
    });
  });

  it("returns display settings from the final bootstrap fence without a separate settings read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let changed = false;
    const { env, statements } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (changed || !statement.sql.includes("FROM board_tables\n       JOIN sheets")) return;
        changed = true;
        database
          .prepare(
            `UPDATE user_settings
             SET show_display_name = 0,
                 show_server_name = 0,
                 show_class_name = 1,
                 show_item_level = 0,
                 show_combat_power = 1
             WHERE user_id = ?`
          )
          .run("user-1");
      }
    });

    try {
      const payload = await loadBoardBootstrap(env, "user-1", "sheet-active");

      expect(payload.settings).toEqual({
        show_display_name: 0,
        show_server_name: 0,
        show_class_name: 1,
        show_item_level: 0,
        show_combat_power: 1
      });
      expect(statements).toHaveLength(8);
      const manifestStatements = statements.filter((statement) => statement.sql.includes("WITH manifest AS"));
      expect(manifestStatements).toHaveLength(2);
      expect(statements.filter((statement) => statement.sql.includes("user_settings"))).toEqual(manifestStatements);
      expect(statements.filter((statement) => statement.sql.includes("FROM board_tables\n       JOIN sheets"))).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("loads only rows reachable through the selected owned sheet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));

    await withEstablishedBoard(async ({ env, statements }) => {
      const payload = await loadBoardSheet(env, "user-1", "sheet-active");

      expect(payload).not.toBeNull();
      expect((payload?.tables as Array<{ id: string }>).map((row) => row.id)).toEqual(["table-active"]);
      expect((payload?.notes as Array<{ id: string }>).map((row) => row.id)).toEqual(["note-active"]);
      expect((payload?.axisItems as Array<{ id: string }>).map((row) => row.id)).toEqual([
        "axis-character",
        "axis-weekly",
        "axis-daily",
        "axis-daily-copy"
      ]);
      expect((payload?.cellStates as Array<{ row_item_id: string }>).map((row) => row.row_item_id).sort()).toEqual([
        "axis-daily",
        "axis-weekly"
      ]);
      expect((payload?.completions as Array<{ period_key: string }>).map((row) => row.period_key).sort()).toEqual([
        "daily:2026-06-05",
        "weekly:2026-06-03"
      ]);
      expect(payload?.periodFingerprint).toBe("daily:2026-06-05|weekly:2026-06-03");

      expect(statements).toHaveLength(7);
      expect(statements.some((statement) => statement.sql.includes("FROM user_settings"))).toBe(false);
      expect(statements.map((statement) => statement.sql).join("\n")).not.toMatch(/SELECT\s+\*/i);
      for (const tableName of [
        "board_tables",
        "board_notes",
        "board_axis_items",
        "board_cell_states",
        "board_cell_completions"
      ]) {
        const statement = statements.find((candidate) => candidate.sql.includes(`FROM ${tableName}`));
        expect(statement?.sql, tableName).toMatch(/JOIN\s+sheets/i);
        expect(statement?.values, tableName).toEqual(expect.arrayContaining(["user-1", "sheet-active"]));
      }

      const completionStatements = statements.filter((statement) => statement.sql.includes("FROM board_cell_completions"));
      expect(completionStatements).toHaveLength(1);
      expect(completionStatements[0]?.sql).toMatch(
        /board_cell_completions\.table_id IN \(SELECT value FROM json_each\(\?3\)\)/
      );
      expect(completionStatements[0]?.values).toEqual([
        "user-1",
        "sheet-active",
        JSON.stringify(["table-active"]),
        JSON.stringify(["daily:2026-06-05", "weekly:2026-06-03"])
      ]);

      statements.length = 0;
      await expect(loadBoardSheet(env, "user-1", "sheet-foreign")).resolves.toBeNull();
      expect(statements).toHaveLength(1);
      expect(statements[0]?.values).toEqual(["sheet-foreign", "user-1"]);
    });
  });

  it("retries a direct sheet read when content changes between its data queries and end fence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let changed = false;
    const { env, statements } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (changed || !statement.sql.includes("FROM board_tables\n       JOIN sheets")) return;
        changed = true;
        database.prepare("UPDATE board_tables SET name = ? WHERE id = ?").run("Active table after write", "table-active");
        database.prepare("UPDATE sheets SET content_version = content_version + 1 WHERE id = ?").run("sheet-active");
      }
    });

    try {
      const payload = await loadBoardSheet(env, "user-1", "sheet-active");

      expect(payload?.sheet.content_version).toBe(8);
      expect(payload?.tables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Active table after write" })]));
      expect(statements.filter((statement) => statement.sql.includes("FROM board_tables\n       JOIN sheets"))).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("returns null when a directly requested sheet is deleted before its end fence", async () => {
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let deleted = false;
    const { env } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (deleted || !statement.sql.includes("FROM board_cell_states\n       JOIN board_tables")) return;
        deleted = true;
        database.prepare("DELETE FROM sheets WHERE id = ?").run("sheet-active");
      }
    });

    try {
      await expect(loadBoardSheet(env, "user-1", "sheet-active")).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("bounds direct sheet retries when every attempted snapshot is superseded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    const { env, statements } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (!statement.sql.includes("FROM board_tables\n       JOIN sheets")) return;
        database.prepare("UPDATE sheets SET content_version = content_version + 1 WHERE id = ?").run("sheet-active");
      }
    });

    try {
      const conflict = loadBoardSheet(env, "user-1", "sheet-active");
      await expect(conflict).rejects.toBeInstanceOf(BoardSnapshotConflictError);
      await expect(conflict).rejects.toThrow("Unable to read a stable board sheet snapshot");
      expect(statements.filter((statement) => statement.sql.includes("FROM board_tables\n       JOIN sheets"))).toHaveLength(3);
      expect(
        statements.filter((statement) =>
          statement.sql.includes("FROM sheets\n     WHERE id = ? AND user_id = ?")
        )
      ).toHaveLength(6);
    } finally {
      database.close();
    }
  });

  it("retries bootstrap after a content write and returns one coherent snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let changed = false;
    const { env, statements } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (changed || !statement.sql.includes("FROM board_tables\n       JOIN sheets")) return;
        changed = true;
        database.prepare("UPDATE board_tables SET name = ? WHERE id = ?").run("Active table after retry", "table-active");
        database.prepare("UPDATE sheets SET content_version = content_version + 1 WHERE id = ?").run("sheet-active");
      }
    });

    try {
      const payload = await loadBoardBootstrap(env, "user-1", "sheet-active");

      expect(payload.activeSheet.sheet.content_version).toBe(8);
      expect(payload.activeSheet.tables).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Active table after retry" })])
      );
      expect(payload.manifest.sheets.find((sheet) => sheet.id === "sheet-active")?.version).toBe(8);
      expect(statements.filter((statement) => statement.sql.includes("FROM board_tables\n       JOIN sheets"))).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("bounds bootstrap retries when every attempted snapshot is superseded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    const { env, statements } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (!statement.sql.includes("FROM board_tables\n       JOIN sheets")) return;
        database.prepare("UPDATE sheets SET content_version = content_version + 1 WHERE id = ?").run("sheet-active");
      }
    });

    try {
      const conflict = loadBoardBootstrap(env, "user-1", "sheet-active");
      await expect(conflict).rejects.toBeInstanceOf(BoardSnapshotConflictError);
      await expect(conflict).rejects.toThrow("Unable to read a stable board bootstrap snapshot");
      expect(statements.filter((statement) => statement.sql.includes("FROM board_tables\n       JOIN sheets"))).toHaveLength(3);
      expect(
        statements.filter((statement) =>
          statement.sql.includes("FROM sheets\n     WHERE id = ? AND user_id = ?")
        )
      ).toHaveLength(3);
      const manifestStatements = statements.filter((statement) => statement.sql.includes("WITH manifest AS"));
      expect(manifestStatements).toHaveLength(6);
      expect(statements.filter((statement) => statement.sql.includes("user_settings"))).toEqual(manifestStatements);
    } finally {
      database.close();
    }
  });

  it("retries bootstrap after manifest metadata changes between the sheet read and final fence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let changed = false;
    const { env } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (changed || !statement.sql.includes("FROM board_notes\n       JOIN sheets")) return;
        changed = true;
        database.prepare("UPDATE sheets SET is_default = 0 WHERE user_id = ?").run("user-1");
        database
          .prepare("UPDATE sheets SET name = ?, sort_order = ?, is_default = 1 WHERE id = ?")
          .run("Renamed active", -10, "sheet-active");
        database
          .prepare(
            `INSERT INTO board_manifest_versions (user_id, version)
             VALUES (?, 1)
             ON CONFLICT(user_id) DO UPDATE SET version = version + 1`
          )
          .run("user-1");
      }
    });

    try {
      const payload = await loadBoardBootstrap(env, "user-1", "sheet-active");

      expect(payload.manifest.version).toBe(10);
      expect(payload.manifest.sheets[0]).toMatchObject({
        id: "sheet-active",
        name: "Renamed active",
        sort_order: -10,
        is_default: 1
      });
      expect(payload.activeSheet.sheet).toMatchObject({
        id: "sheet-active",
        name: "Renamed active",
        sort_order: -10,
        is_default: 1
      });
    } finally {
      database.close();
    }
  });

  it("retries bootstrap and falls back when its selected sheet is concurrently deleted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    seedEstablishedBoard(database);
    let deleted = false;
    const { env } = createSqliteReadEnv(database, {
      afterExecute({ statement }) {
        if (deleted || !statement.sql.includes("FROM board_cell_states\n       JOIN board_tables")) return;
        deleted = true;
        database.prepare("DELETE FROM sheets WHERE id = ?").run("sheet-active");
        database.prepare("UPDATE board_manifest_versions SET version = version + 1 WHERE user_id = ?").run("user-1");
      }
    });

    try {
      const payload = await loadBoardBootstrap(env, "user-1", "sheet-active");

      expect(payload.activeSheet.sheet.id).toBe("sheet-default");
      expect(payload.manifest.version).toBe(10);
      expect(payload.manifest.sheets.some((sheet) => sheet.id === "sheet-active")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("initializes one complete default board atomically under interleaved bootstrap calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "riceark-board-init-"));
    const path = join(directory, "board.sqlite");
    const database = createBoardReadDatabase(path);
    const observer = new DatabaseSync(path);
    database.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run("user-1", "Owner");
    seedDefaultTasks(database);
    seedDefaultCharacters(database, 20);
    database
      .prepare(
        `INSERT INTO completions (
           id, user_id, task_id, character_id, target_key, period_key, completed
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-completion",
        "user-1",
        "task-daily-1",
        "character-0",
        "character-0",
        "daily:2026-06-05",
        1
      );
    database
      .prepare(
        `INSERT INTO completions (
           id, user_id, task_id, character_id, target_key, period_key, completed
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-completion-historical",
        "user-1",
        "task-daily-1",
        "character-0",
        "character-0",
        "daily:2026-05-01",
        1
      );

    const visibleStates: Array<{
      sheets: number;
      tables: number;
      axes: number;
      completions: number;
      manifestVersion: number;
      sheetVersion: number;
    }> = [];
    const captureVisibleState = () => {
      const count = (table: string) =>
        Number((observer.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
      visibleStates.push({
        sheets: count("sheets"),
        tables: count("board_tables"),
        axes: count("board_axis_items"),
        completions: count("board_cell_completions"),
        manifestVersion: Number(
          (
            observer
              .prepare(
                `SELECT COALESCE(
                   (SELECT version FROM board_manifest_versions WHERE user_id = 'user-1'),
                   0
                 ) AS version`
              )
              .get() as { version: number }
          ).version
        ),
        sheetVersion: Number(
          (
            observer
              .prepare(
                `SELECT COALESCE(
                   (SELECT content_version FROM sheets WHERE user_id = 'user-1' LIMIT 1),
                   0
                 ) AS version`
              )
              .get() as { version: number }
          ).version
        )
      });
    };
    const { env } = createSqliteReadEnv(database, {
      afterExecute: captureVisibleState,
      afterBatchStatement: captureVisibleState
    });

    try {
      const [first, second] = await Promise.all([
        loadBoardBootstrap(env, "user-1"),
        loadBoardBootstrap(env, "user-1")
      ]);

      expect(
        visibleStates.filter(
          (state) =>
            state.sheets > 0 &&
            (state.tables !== 1 ||
              state.axes !== 24 ||
              state.completions !== 1 ||
              state.manifestVersion !== 1 ||
              state.sheetVersion !== 1)
        )
      ).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM sheets WHERE user_id = ?").get("user-1")).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_tables WHERE user_id = ?").get("user-1")).toEqual({
        count: 1
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_axis_items WHERE user_id = ?").get("user-1")).toEqual({
        count: 24
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM board_cell_completions WHERE user_id = ?").get("user-1")
      ).toEqual({ count: 1 });
      for (const payload of [first, second]) {
        expect(payload.manifest.version).toBe(1);
        expect(payload.manifest.sheets).toHaveLength(1);
        expect(payload.activeSheet.tables).toHaveLength(1);
        expect(payload.activeSheet.axisItems).toHaveLength(24);
        expect(payload.activeSheet.completions).toHaveLength(1);
        expect(payload.manifest.sheets[0]?.version).toBe(payload.activeSheet.sheet.content_version);
      }
    } finally {
      observer.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy completions only when both task and current period match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    database.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run("user-1", "Owner");
    seedDefaultTasks(database);
    seedDefaultCharacters(database, 1);
    const insertCompletion = database.prepare(
      `INSERT INTO completions (
         id, user_id, task_id, character_id, target_key, period_key, completed
       ) VALUES (?, 'user-1', ?, 'character-0', 'character-0', ?, 1)`
    );
    insertCompletion.run("legacy-daily-valid", "task-daily-1", "daily:2026-06-05");
    insertCompletion.run("legacy-daily-corrupt-weekly", "task-daily-1", "weekly:2026-06-03");
    insertCompletion.run("legacy-weekly-valid", "task-weekly-1", "weekly:2026-06-03");
    const { env } = createSqliteReadEnv(database);

    try {
      const payload = await loadBoardBootstrap(env, "user-1");
      const migrated = database.prepare(
        `SELECT board_cell_completions.id,
                task_items.task_id,
                board_cell_completions.period_key
         FROM board_cell_completions
         JOIN board_axis_items AS task_items
           ON task_items.id = board_cell_completions.row_item_id
          AND task_items.kind = 'task'
         ORDER BY task_items.task_id, board_cell_completions.period_key`
      ).all().map((row) => ({
        sourceId: String(row.id).split(":").at(-1),
        taskId: row.task_id,
        periodKey: row.period_key
      }));

      expect(payload.activeSheet.completions).toHaveLength(2);
      expect(migrated).toEqual([
        { sourceId: "legacy-daily-valid", taskId: "task-daily-1", periodKey: "daily:2026-06-05" },
        { sourceId: "legacy-weekly-valid", taskId: "task-weekly-1", periodKey: "weekly:2026-06-03" }
      ]);
    } finally {
      database.close();
    }
  });

  it("initializes an empty owner board within the first-load statement budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const database = createBoardReadDatabase();
    database.prepare("INSERT INTO users (id, display_name) VALUES (?, ?)").run("user-1", "Owner");
    seedDefaultTasks(database);
    seedDefaultCharacters(database, 20);
    const { env, statements } = createSqliteReadEnv(database);

    try {
      const bootstrap = await loadBoardBootstrap(env, "user-1");

      expect(bootstrap.activeSheet.sheet).toMatchObject({ name: "기본", is_default: 1 });
      expect(bootstrap.activeSheet.sheet.content_version).toBe(1);
      expect(bootstrap.manifest.version).toBe(1);
      expect(bootstrap.manifest.sheets).toHaveLength(1);
      expect(bootstrap.activeSheet.axisItems).toHaveLength(24);
      expect(bootstrap.settings).toEqual({
        show_display_name: 1,
        show_server_name: 0,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      });
      expect(statements).toHaveLength(18);
      expect(statements.length).toBeLessThanOrEqual(18);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("INSERT INTO board_axis_items"))).toHaveLength(2);
      expect(statements.some((statement) => statement.sql.includes("FROM json_each"))).toBe(true);
      expect(statements[0]?.sql).toContain("WITH manifest AS");
      expect(statements.filter((statement) => statement.sql.includes("WITH manifest AS"))).toHaveLength(3);
      expect(bootstrap.manifest.sheets[0]?.version).toBe(bootstrap.activeSheet.sheet.content_version);
    } finally {
      database.close();
    }
  });

  it("binds owned table IDs and 300 unique completion periods as JSON values in new reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    await withEstablishedBoard(async ({ database, env, statements }) => {
      const insert = database.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, task_reset_rule_json, sort_order
         ) VALUES (?, 'user-1', 'table-active', 'row', 'task', ?, ?, ?)`
      );
      for (let index = 0; index < 300; index += 1) {
        const anchor = new Date(Date.UTC(2025, 7, 1 + index)).toISOString().slice(0, 10);
        insert.run(
          `axis-custom-${index}`,
          `Custom ${index}`,
          JSON.stringify({ type: "custom", intervalDays: 365, hour: 6, timezone: "Asia/Seoul", anchorDate: anchor }),
          1000 + index * 10
        );
      }

      statements.length = 0;
      await loadBoardSheet(env, "user-1", "sheet-active", new Date("2026-06-05T03:00:00.000Z"));
      const sheetCompletionRead = statements.find((statement) =>
        statement.sql.includes("FROM board_cell_completions") && statement.sql.includes("sheets.id = ?2")
      );
      expect(sheetCompletionRead?.values.length).toBeLessThan(100);
      expect(sheetCompletionRead?.values).toHaveLength(4);
      expect(sheetCompletionRead?.values[2]).toBe(JSON.stringify(["table-active"]));
      expect(sheetCompletionRead?.sql).toContain("json_each(?3)");
      expect(sheetCompletionRead?.sql).toContain("json_each(?4)");

      statements.length = 0;
      await loadBoard(env, "user-1");
      const legacyCompletionRead = statements.find((statement) =>
        statement.sql.includes("FROM board_cell_completions") && !statement.sql.includes("JOIN board_tables")
      );
      expect(legacyCompletionRead?.values.length).toBeLessThan(100);
      expect(legacyCompletionRead?.values).toHaveLength(2);
      expect(legacyCompletionRead?.sql).toContain("json_each(?2)");
    });
  });

  it("loads the canonical version summary from the same manifest mapping in one statement", async () => {
    await withEstablishedBoard(async ({ env, statements }) => {
      const manifest = await loadBoardManifest(env, "user-1");
      statements.length = 0;

      await expect(loadBoardVersionSummary(env, "user-1")).resolves.toEqual({
        manifestVersion: manifest.version,
        sheets: manifest.sheets,
        periodFingerprint: "",
        settings: {
          show_display_name: 1,
          show_server_name: 1,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("WITH manifest AS");
      expect(statements[0]?.sql).toContain("user_settings");
      expect(statements[0]?.sql).not.toMatch(/SELECT\s+\*/i);
    });
  });

  it("uses display setting defaults in a one-statement version summary when settings are absent", async () => {
    await withEstablishedBoard(async ({ database, env, statements }) => {
      database.prepare("DELETE FROM user_settings WHERE user_id = ?").run("user-1");

      await expect(loadBoardVersionSummary(env, "user-1")).resolves.toMatchObject({
        manifestVersion: 9,
        periodFingerprint: "",
        settings: {
          show_display_name: 1,
          show_server_name: 0,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("user_settings");
      expect(statements[0]?.sql).not.toMatch(/SELECT\s+\*/i);
    });
  });
});
