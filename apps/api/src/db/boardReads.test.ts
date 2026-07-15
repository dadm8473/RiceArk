import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Env } from "../env";
import type {
  BoardBootstrapPayload,
  BoardSheetManifest,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardSheetPayloadItem,
  BoardVersionSummary
} from "./boardReads";
import { loadBoardVersionSummary, type BoardVersionSummary as BoardModuleVersionSummary } from "./board";
import { loadBoardBootstrap, loadBoardManifest, loadBoardSheet } from "./boardReads";

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

function createBoardReadDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

function createSqliteReadEnv(database: DatabaseSync): { env: Env; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];

  const createStatement = (captured: CapturedStatement): SqliteD1Statement => ({
    captured,
    bind(...values) {
      captured.values = values;
      return createStatement(captured);
    },
    async first<T>() {
      return (database.prepare(captured.sql).get(...captured.values) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: database.prepare(captured.sql).all(...captured.values) as T[] };
    },
    async run() {
      const result = database.prepare(captured.sql).run(...captured.values);
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
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = batchStatements.map((statement) => {
            const prepared = database.prepare(statement.captured.sql);
            if (/\bRETURNING\b/i.test(statement.captured.sql)) {
              const rows = prepared.all(...statement.captured.values);
              return { success: true, meta: { changes: rows.length }, results: rows };
            }
            const result = prepared.run(...statement.captured.values);
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
    expectTypeOf<BoardBootstrapPayload["manifest"]["version"]>().toEqualTypeOf<
      BoardVersionSummary["manifestVersion"]
    >();
    expectTypeOf<BoardBootstrapPayload["manifest"]["sheets"]>().toEqualTypeOf<BoardVersionSummary["sheets"]>();
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
      expect(statements.length).toBeLessThanOrEqual(9);
      expect(statements.filter((statement) => statement.sql.includes("FROM user_settings"))).toHaveLength(1);

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
      expect(completionStatements[0]?.values.slice(-2)).toEqual([
        "daily:2026-06-05",
        "weekly:2026-06-03"
      ]);

      statements.length = 0;
      await expect(loadBoardSheet(env, "user-1", "sheet-foreign")).resolves.toBeNull();
      expect(statements).toHaveLength(1);
      expect(statements[0]?.values).toEqual(["sheet-foreign", "user-1"]);
    });
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
      expect(bootstrap.manifest.sheets).toHaveLength(1);
      expect(bootstrap.activeSheet.axisItems).toHaveLength(24);
      expect(bootstrap.settings).toEqual({
        show_display_name: 1,
        show_server_name: 0,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      });
      expect(statements.length).toBeLessThanOrEqual(30);
      expect(statements[0]?.sql).toContain("WITH manifest AS");
      expect(statements.filter((statement) => statement.sql.includes("WITH manifest AS"))).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("loads the canonical version summary from the same manifest mapping in one statement", async () => {
    await withEstablishedBoard(async ({ env, statements }) => {
      const manifest = await loadBoardManifest(env, "user-1");
      statements.length = 0;

      await expect(loadBoardVersionSummary(env, "user-1")).resolves.toEqual({
        manifestVersion: manifest.version,
        sheets: manifest.sheets,
        periodFingerprint: ""
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("WITH manifest AS");
      expect(statements[0]?.sql).not.toMatch(/SELECT\s+\*/i);
    });
  });
});
