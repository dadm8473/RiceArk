import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHEET_NAME,
  DEFAULT_TABLE_NAME,
  buildBoardCompletionPatchesFromLegacy,
  buildDefaultAxisItemSeeds,
  buildMissingDefaultAxisItemSeeds,
  buildManualBoardAxisItemDraft,
  buildBoardAxisItemTransposePlan,
  boardRolesForTableOrientation,
  canApplyBoardTableSettingsUpdate,
  createBoardAxisItem,
  createBoardNote,
  createBoardSheet,
  createBoardTable,
  addBoardShareFavorite,
  createManualBoardCharacterForTable,
  createBoardTaskForTable,
  defaultBoardRolesForOrientation,
  defaultOrientationForTableRoles,
  deleteBoardTable,
  deleteBoardNote,
  deleteBoardSheet,
  deleteBoardShareFavorite,
  ensureDefaultBoard,
  getCurrentBoardCompletionPeriodKeys,
  findBoardCellStatePatchesOutsideCurrentPeriod,
  findUnauthorizedBoardCellStatePatches,
  resolveExpiredBoardCellStateRows,
  findUnauthorizedBoardCompletionPatches,
  findBoardCompletionPatchesOutsideCurrentPeriod,
  listBoardShareFavorites,
  listBoardShares,
  loadBoard,
  loadBoardVersionSummary,
  loadSharedBoard,
  loadSharedBoardVersionSummary,
  hideBoardAxisItem,
  importBoardCharactersForTable,
  startBoardSheetShare,
  stopBoardSheetShare,
  mergeBoardCellStatePatches,
  mergeBoardCompletionPatches,
  reorderBoardAxisItems,
  saveBoardCellStatePatches,
  saveBoardCompletionPatches,
  transposeBoardTable,
  transposeBoardRoles,
  updateBoardAxisItem,
  updateBoardTableSettings,
  updateBoardTableLayout,
  updateBoardNote,
  updateBoardNoteLayout,
  updateBoardSheet
} from "./board";

interface MutationStatement {
  sql: string;
  values: unknown[];
}

function successfulVersionedMutationBatch(
  statements: MutationStatement[],
  captured: MutationStatement[] = []
): Array<{ success: true; results: Array<{ id: string; version?: number }> }> {
  captured.push(...statements);
  return statements.map((statement) => {
    if (statement.sql.includes("UPDATE sheets")) {
      return { success: true, results: [{ id: "sheet-1", version: 4 }] };
    }
    if (statement.sql.includes("UPDATE board_tables")) {
      return { success: true, results: [{ id: "table-1" }] };
    }
    if (statement.sql.includes("RETURNING id")) {
      return { success: true, results: [{ id: String(statement.values[0]) }] };
    }
    return { success: true, results: [] };
  });
}

interface MutationState {
  manifestVersion: number;
  sheets: Map<string, { userId: string; name: string; version: number; isDefault: number }>;
  notes: Map<string, { userId: string; sheetId: string }>;
}

function cloneMutationState(state: MutationState): MutationState {
  return {
    manifestVersion: state.manifestVersion,
    sheets: new Map([...state.sheets].map(([id, sheet]) => [id, { ...sheet }])),
    notes: new Map([...state.notes].map(([id, note]) => [id, { ...note }]))
  };
}

function createAtomicMutationEnv() {
  const state: MutationState = {
    manifestVersion: 7,
    sheets: new Map([
      ["sheet-1", { userId: "user-1", name: "Main", version: 3, isDefault: 1 }],
      ["sheet-2", { userId: "user-1", name: "Other", version: 5, isDefault: 0 }]
    ]),
    notes: new Map([["note-1", { userId: "user-1", sheetId: "sheet-1" }]])
  };
  const batches: MutationStatement[][] = [];
  const preparedSql: string[] = [];

  const execute = (statement: MutationStatement, target: MutationState) => {
    const sql = statement.sql.replace(/\s+/g, " ").trim();
    const returnsRows = /\bRETURNING\b/i.test(sql) || sql.startsWith("SELECT");
    const result = (rows: Record<string, unknown>[], changes: number) => ({
      success: true,
      meta: { changes },
      results: returnsRows ? rows : []
    });

    if (sql.includes("INSERT INTO board_manifest_versions")) {
      const conditionalSheetId = sql.includes("WHERE EXISTS") ? String(statement.values[1]) : null;
      const conditionalUserId = sql.includes("WHERE EXISTS") ? String(statement.values[2]) : null;
      if (conditionalSheetId) {
        const sheet = target.sheets.get(conditionalSheetId);
        if (!sheet || sheet.userId !== conditionalUserId) return result([], 0);
        if (
          sql.includes("other.id <> target.id") &&
          ![...target.sheets].some(
            ([id, other]) => id !== conditionalSheetId && other.userId === String(statement.values[3])
          )
        ) {
          return result([], 0);
        }
      }
      target.manifestVersion += 1;
      return result([{ user_id: String(statement.values[0]), version: target.manifestVersion }], 1);
    }

    if (sql.startsWith("INSERT INTO sheets")) {
      const [id, userId, name] = statement.values.map(String);
      if ([...target.sheets.values()].some((sheet) => sheet.userId === userId && sheet.name === name)) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: sheets.user_id, sheets.name");
      }
      target.sheets.set(id!, { userId: userId!, name: name!, version: 0, isDefault: 0 });
      return result([{ id }], 1);
    }

    if (sql.startsWith("UPDATE sheets") && sql.includes("SET name =")) {
      const [name, sheetId, userId] = statement.values.map(String);
      const sheet = target.sheets.get(sheetId!);
      if (!sheet || sheet.userId !== userId) return result([], 0);
      if ([...target.sheets].some(([id, candidate]) => id !== sheetId && candidate.userId === userId && candidate.name === name)) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: sheets.user_id, sheets.name");
      }
      sheet.name = name!;
      return result([{ id: sheetId }], 1);
    }

    if (sql.startsWith("UPDATE sheets") && sql.includes("content_version = content_version + 1")) {
      let sheetId: string | undefined;
      if (sql.includes("FROM board_notes")) {
        const note = target.notes.get(String(statement.values[1]));
        if (note?.userId === String(statement.values[0]) && note.userId === String(statement.values[2])) sheetId = note.sheetId;
      } else {
        const candidate = target.sheets.get(String(statement.values[0]));
        if (candidate?.userId === String(statement.values[1])) sheetId = String(statement.values[0]);
      }
      const sheet = sheetId ? target.sheets.get(sheetId) : null;
      if (!sheet) return result([], 0);
      sheet.version += 1;
      return result([{ id: sheetId, version: sheet.version }], 1);
    }

    if (sql.startsWith("UPDATE sheets") && sql.includes("SET is_default = CASE")) {
      const targetSheetId = String(statement.values[1]);
      const userId = String(statement.values[2]);
      const targetSheet = target.sheets.get(targetSheetId);
      const otherSheetId = [...target.sheets].find(([id, sheet]) => id !== targetSheetId && sheet.userId === userId)?.[0];
      if (!targetSheet || targetSheet.userId !== userId || targetSheet.isDefault !== 1 || !otherSheetId) return result([], 0);
      for (const [id, sheet] of target.sheets) {
        if (sheet.userId === userId) sheet.isDefault = id === otherSheetId ? 1 : 0;
      }
      return result([], 1);
    }

    if (sql.startsWith("DELETE FROM sheets")) {
      const [sheetId, userId] = statement.values.map(String);
      const sheet = target.sheets.get(sheetId!);
      if (!sheet || sheet.userId !== userId) return result([], 0);
      if (
        sql.includes("other.id <> sheets.id") &&
        ![...target.sheets].some(([id, other]) => id !== sheetId && other.userId === String(statement.values[2]))
      ) {
        return result([], 0);
      }
      target.sheets.delete(sheetId!);
      return result([{ id: sheetId }], 1);
    }

    if (sql.startsWith("SELECT CASE") && sql.includes("FROM sheets WHERE id = ? AND user_id = ?")) {
      const [sheetId, userId] = statement.values.map(String);
      const sheet = target.sheets.get(sheetId!);
      return result([{ type: sheet?.userId === userId ? "last_sheet" : "not_found" }], 0);
    }

    if (sql.startsWith("INSERT INTO board_tables")) {
      const [id, userId, sheetId] = statement.values.map(String);
      const sheet = target.sheets.get(sheetId!);
      if (!sheet || sheet.userId !== userId) return result([], 0);
      return result([{ id }], 1);
    }

    if (sql.startsWith("INSERT INTO board_notes")) {
      const [id, userId, sheetId] = statement.values.map(String);
      const sheet = target.sheets.get(sheetId!);
      if (!sheet || sheet.userId !== userId) return result([], 0);
      target.notes.set(id!, { userId: userId!, sheetId: sheetId! });
      return result([{ id }], 1);
    }

    if (sql.startsWith("UPDATE board_notes")) {
      const noteId = String(statement.values.at(-3));
      const userId = String(statement.values.at(-2));
      const sheetUserId = String(statement.values.at(-1));
      const note = target.notes.get(noteId);
      const sheet = note ? target.sheets.get(note.sheetId) : null;
      return note?.userId === userId && sheet?.userId === sheetUserId ? result([{ id: noteId }], 1) : result([], 0);
    }

    if (sql.startsWith("DELETE FROM board_notes") && sql.includes("WHERE id = ? AND user_id = ?")) {
      const [noteId, userId] = statement.values.map(String);
      const note = target.notes.get(noteId!);
      const sheet = note ? target.sheets.get(note.sheetId) : null;
      if (!note || note.userId !== userId || sheet?.userId !== String(statement.values[2])) return result([], 0);
      target.notes.delete(noteId!);
      return result([{ id: noteId }], 1);
    }

    return result([], 1);
  };

  const env = {
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            return { ...this, values };
          },
          async first() {
            if (sql.includes("SELECT id FROM board_tables WHERE user_id = ? LIMIT 1")) return { id: "table-existing" };
            if (sql.includes("SELECT id, is_default FROM sheets")) {
              const sheet = state.sheets.get(String(this.values[0]));
              if (!sheet || sheet.userId !== this.values[1]) return null;
              return { id: this.values[0], is_default: sheet.isDefault };
            }
            if (sql.includes("SELECT COUNT(*) AS count FROM sheets")) {
              return { count: [...state.sheets.values()].filter((sheet) => sheet.userId === this.values[0]).length };
            }
            if (sql.includes("SELECT id FROM sheets WHERE user_id = ? AND name = ?")) {
              const match = [...state.sheets].find(([, sheet]) => sheet.userId === this.values[0] && sheet.name === this.values[1]);
              return match ? { id: match[0] } : null;
            }
            if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) {
              const sheet = state.sheets.get(String(this.values[0]));
              return sheet?.userId === this.values[1] ? { id: this.values[0] } : null;
            }
            if (sql.includes("MAX(sort_order)")) {
              return sql.includes("board_notes")
                ? { maxSortOrder: 10, noteCount: state.notes.size }
                : { maxSortOrder: 10, tableCount: 1 };
            }
            return null;
          },
          async run() {
            return execute(this, state);
          }
        };
      },
      async batch(statements: MutationStatement[]) {
        batches.push(statements);
        const transaction = cloneMutationState(state);
        const results = statements.map((statement) => execute(statement, transaction));
        state.manifestVersion = transaction.manifestVersion;
        state.sheets = transaction.sheets;
        state.notes = transaction.notes;
        return results;
      }
    }
  } as unknown as Parameters<typeof createBoardSheet>[0];

  return { env, state, batches, preparedSql };
}

interface SqliteD1Statement {
  sql: string;
  values: SQLInputValue[];
}

function createBoardMutationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      checklist_orientation TEXT
    );
    CREATE TABLE sheets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      content_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name)
    );
    CREATE TABLE board_manifest_versions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_tables (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Table',
      x INTEGER NOT NULL DEFAULT 0,
      y INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      row_role TEXT NOT NULL DEFAULT 'task',
      column_role TEXT NOT NULL DEFAULT 'character',
      task_axis TEXT NOT NULL DEFAULT 'rows',
      default_row_height INTEGER NOT NULL DEFAULT 40,
      default_column_width INTEGER NOT NULL DEFAULT 132,
      display_options_json TEXT,
      event_options_json TEXT,
      template_type TEXT NOT NULL DEFAULT 'custom',
      locked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      server_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      item_level TEXT NOT NULL,
      combat_power TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      source TEXT NOT NULL DEFAULT 'lostark',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name, server_name)
    );
    CREATE TABLE board_axis_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
      axis TEXT NOT NULL DEFAULT 'row',
      kind TEXT NOT NULL DEFAULT 'custom',
      visible INTEGER NOT NULL DEFAULT 1,
      character_id TEXT,
      task_id TEXT,
      task_scope TEXT,
      task_reset_type TEXT,
      task_reset_rule_json TEXT,
      task_color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      size_px INTEGER,
      cross_size_px INTEGER,
      label TEXT NOT NULL DEFAULT '',
      separator_json TEXT,
      display_options_json TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_cell_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
      row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
      column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
      checkbox_visible INTEGER NOT NULL DEFAULT 1,
      mark_type TEXT NOT NULL DEFAULT 'default',
      mark_icon TEXT,
      memo TEXT,
      mark_period_key TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (table_id, row_item_id, column_item_id)
    );
    CREATE TABLE board_cell_completions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
      row_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
      column_item_id TEXT NOT NULL REFERENCES board_axis_items(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL DEFAULT 'none:permanent',
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, table_id, row_item_id, column_item_id, period_key)
    );
    CREATE TABLE board_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
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
    CREATE TABLE board_shares (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL UNIQUE
    );
  `);
  return database;
}

function seedSqliteBoard(database: DatabaseSync, sheetIds: string[]): void {
  database.prepare("INSERT INTO users (id) VALUES (?)").run("user-1");
  sheetIds.forEach((sheetId, index) => {
    database.prepare("INSERT INTO sheets (id, user_id, name, sort_order, is_default) VALUES (?, ?, ?, ?, ?)")
      .run(sheetId, "user-1", sheetId, index * 10, index === 0 ? 1 : 0);
    database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)")
      .run(`table-${sheetId}`, "user-1", sheetId);
    database.prepare("INSERT INTO board_notes (id, user_id, sheet_id, title, body) VALUES (?, ?, ?, ?, ?)")
      .run(`note-${sheetId}`, "user-1", sheetId, `Note ${sheetId}`, `Body ${sheetId}`);
    database.prepare("INSERT INTO board_shares (id, owner_user_id, sheet_id, share_id) VALUES (?, ?, ?, ?)")
      .run(`share-row-${sheetId}`, "user-1", sheetId, `share-${sheetId}`);
  });

  const firstSheet = sheetIds[0]!;
  database.prepare("INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, task_reset_rule_json) VALUES (?, ?, ?, 'row', 'task', ?)")
    .run("axis-row", "user-1", `table-${firstSheet}`, '{"type":"none"}');
  database.prepare("INSERT INTO board_axis_items (id, user_id, table_id, axis, kind) VALUES (?, ?, ?, 'column', 'character')")
    .run("axis-column", "user-1", `table-${firstSheet}`);
  database.prepare(
    "INSERT INTO board_cell_states (id, user_id, table_id, row_item_id, column_item_id) VALUES (?, ?, ?, ?, ?)"
  ).run("cell-state", "user-1", `table-${firstSheet}`, "axis-row", "axis-column");
  database.prepare(
    "INSERT INTO board_cell_completions (id, user_id, table_id, row_item_id, column_item_id) VALUES (?, ?, ?, ?, ?)"
  ).run("completion", "user-1", `table-${firstSheet}`, "axis-row", "axis-column");
}

function seedSqliteAxisPair(database: DatabaseSync, tableId: string, suffix: string): { rowId: string; columnId: string } {
  const rowId = `axis-row-${suffix}`;
  const columnId = `axis-column-${suffix}`;
  database.prepare(
    "INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, task_reset_rule_json) VALUES (?, 'user-1', ?, 'row', 'task', ?)"
  ).run(rowId, tableId, '{"type":"none"}');
  database.prepare(
    "INSERT INTO board_axis_items (id, user_id, table_id, axis, kind) VALUES (?, 'user-1', ?, 'column', 'character')"
  ).run(columnId, tableId);
  return { rowId, columnId };
}

function seedSqliteBulkAxisPairs(
  database: DatabaseSync,
  tableId: string,
  prefix: string,
  count: number
): Array<{ rowId: string; columnId: string }> {
  return Array.from({ length: count }, (_, index) => seedSqliteAxisPair(database, tableId, `${prefix}-${index}`));
}

function createSqliteD1Env(
  database: DatabaseSync,
  options: {
    interleaveDeletePreflights?: boolean;
    beforeBatch?: (statements: SqliteD1Statement[], database: DatabaseSync) => void;
    reverseReturningRows?: boolean;
    malformedResultIndex?: number;
    emptyResultIndex?: number;
    malformedPreflight?: boolean;
    extraBatchResult?: boolean;
    deleteReturningRows?: Array<Record<string, SQLInputValue>>;
    skipStatement?: ((statement: SqliteD1Statement, index: number) => boolean) | undefined;
  } = {}
) {
  const preparedSql: string[] = [];
  const batches: SqliteD1Statement[][] = [];
  let countPreflights = 0;
  let releasePreflights: (() => void) | null = null;
  const preflightBarrier = new Promise<void>((resolve) => {
    releasePreflights = resolve;
  });
  let batchQueue = Promise.resolve();

  const createStatement = (sql: string, values: SQLInputValue[] = []) => ({
    sql,
    values,
    bind(...boundValues: SQLInputValue[]) {
      return createStatement(sql, boundValues);
    },
    async first() {
      const row = database.prepare(sql).get(...values) ?? null;
      if (options.interleaveDeletePreflights && sql.includes("SELECT COUNT(*) AS count FROM sheets")) {
        countPreflights += 1;
        if (countPreflights === 2) releasePreflights?.();
        await preflightBarrier;
      }
      return row;
    },
    async all() {
      const results = database.prepare(sql).all(...values);
      if (options.malformedPreflight && sql.includes("SELECT input.ordinal") && results[0]) {
        results[0] = { ...results[0], tableId: "wrong-table" };
      }
      return { results };
    },
    async run() {
      const result = database.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    }
  });

  const env = {
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        return createStatement(sql);
      },
      async batch(statements: SqliteD1Statement[]) {
        batches.push(statements);
        const executeBatch = () => {
          options.beforeBatch?.(statements, database);
          database.exec("BEGIN IMMEDIATE");
          try {
            const results = statements.map((statement, index) => {
              if (options.skipStatement?.(statement, index)) {
                database.prepare("UPDATE sheets SET content_version = content_version WHERE 0").run();
                return { success: true, meta: { changes: 0 }, results: [] };
              }
              const prepared = database.prepare(statement.sql);
              if (/^\s*SELECT\b/i.test(statement.sql) || /\bRETURNING\b/i.test(statement.sql)) {
                const rows = statement.sql.includes("DELETE FROM board_cell_states") && options.deleteReturningRows
                  ? options.deleteReturningRows
                  : prepared.all(...statement.values);
                if (options.reverseReturningRows) rows.reverse();
                if (options.emptyResultIndex === index) {
                  return { success: true, meta: { changes: rows.length }, results: [] };
                }
                if (options.malformedResultIndex === index) {
                  return { success: true, meta: { changes: rows.length }, results: [{ malformed: true }] };
                }
                return { success: true, meta: { changes: rows.length }, results: rows };
              }
              const result = prepared.run(...statement.values);
              if (options.malformedResultIndex === index) {
                return { success: true, meta: { changes: Number(result.changes) }, results: [{ malformed: true }] };
              }
              return { success: true, meta: { changes: Number(result.changes) }, results: [] };
            });
            if (options.extraBatchResult) results.push({ success: true, meta: { changes: 0 }, results: [] });
            database.exec("COMMIT");
            return results;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        };
        const result = batchQueue.then(executeBatch, executeBatch);
        batchQueue = result.then(() => undefined, () => undefined);
        return result;
      }
    }
  } as unknown as Parameters<typeof deleteBoardSheet>[0];

  return { env, batches, preparedSql };
}

describe("board db defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Korean-facing default names", () => {
    expect(DEFAULT_SHEET_NAME).toBe("기본");
    expect(DEFAULT_TABLE_NAME).toBe("숙제");
  });

  it("starts sheet sharing with a fresh unguessable share id without board version bumps", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              return null;
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map((statement) => ({
            success: true,
            meta: { changes: 1 },
            results: statement.sql.includes("RETURNING id") ? [{ id: statement.values[0] }] : []
          }));
        }
      }
    } as unknown as Parameters<typeof startBoardSheetShare>[0];

    const first = await startBoardSheetShare(env, "user-1", "sheet-1");
    const second = await startBoardSheetShare(env, "user-1", "sheet-1");

    expect(first).toEqual({ shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(second).toEqual({ shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(first && second && first !== "not_found" && second !== "not_found" ? first.shareId === second.shareId : true).toBe(false);
    expect(runs).toHaveLength(0);
    expect(batches[0]?.some((statement) => statement.sql.includes("DELETE FROM board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("INSERT INTO board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(false);
    expect(batches[0]?.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(false);
  });

  it("stops sheet sharing with an ownership-guarded delete and no board version bumps", async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT share_id FROM board_shares")) return { share_id: "share-old" };
              return null;
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true, meta: { changes: 1 }, results: [{ id: "sheet-1" }] }));
        }
      }
    } as unknown as Parameters<typeof stopBoardSheetShare>[0];

    await expect(stopBoardSheetShare(env, "user-1", "sheet-1")).resolves.toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("DELETE FROM board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(false);
    expect(batches[0]?.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(false);
  });

  it.each(["create sheet", "rename sheet", "delete sheet", "create table"] as const)(
    "%s returns atomic version deltas from its mutation batch",
    async (operation) => {
      const { env, state, batches, preparedSql } = createAtomicMutationEnv();
      const initialManifestVersion = state.manifestVersion;
      const initialSheetVersion = state.sheets.get("sheet-1")!.version;

      if (operation === "create sheet") {
        await expect(createBoardSheet(env, "user-1", { name: "New" })).resolves.toEqual({
          id: expect.any(String),
          versions: { sheets: [], manifestVersion: initialManifestVersion + 1 }
        });
        expect(state.manifestVersion).toBe(initialManifestVersion + 1);
        expect(state.sheets.get("sheet-1")?.version).toBe(initialSheetVersion);
      } else if (operation === "rename sheet") {
        await expect(updateBoardSheet(env, "user-1", "sheet-1", { name: "Renamed" })).resolves.toEqual({
          type: "updated",
          result: {
            ok: true,
            versions: {
              sheets: [{ id: "sheet-1", version: initialSheetVersion + 1 }],
              manifestVersion: initialManifestVersion + 1
            }
          }
        });
        expect(state.manifestVersion).toBe(initialManifestVersion + 1);
        expect(state.sheets.get("sheet-1")?.version).toBe(initialSheetVersion + 1);
      } else if (operation === "delete sheet") {
        await expect(deleteBoardSheet(env, "user-1", "sheet-1")).resolves.toEqual({
          type: "deleted",
          result: { ok: true, versions: { sheets: [], manifestVersion: initialManifestVersion + 1 } }
        });
        expect(state.manifestVersion).toBe(initialManifestVersion + 1);
        expect(state.sheets.has("sheet-1")).toBe(false);
      } else {
        await expect(
          createBoardTable(env, "user-1", { sheetId: "sheet-1", name: "New table", orientation: "custom" })
        ).resolves.toEqual({
          id: expect.any(String),
          versions: { sheets: [{ id: "sheet-1", version: initialSheetVersion + 1 }] }
        });
        expect(state.manifestVersion).toBe(initialManifestVersion);
        expect(state.sheets.get("sheet-1")?.version).toBe(initialSheetVersion + 1);
      }

      expect(batches).toHaveLength(1);
      expect(
        preparedSql.filter(
          (sql) => /^\s*SELECT\b/i.test(sql) && (sql.includes("board_manifest_versions") || sql.includes("content_version"))
        )
      ).toEqual([]);
    }
  );

  it.each(["create", "update", "layout", "delete"] as const)(
    "%s note bumps its owning sheet exactly once and returns the batch version",
    async (operation) => {
      const { env, state, batches, preparedSql } = createAtomicMutationEnv();
      const initialVersion = state.sheets.get("sheet-1")!.version;

      if (operation === "create") {
        await expect(createBoardNote(env, "user-1", { sheetId: "sheet-1", title: "Memo", body: "Body" })).resolves.toEqual({
          id: expect.any(String),
          versions: { sheets: [{ id: "sheet-1", version: initialVersion + 1 }] }
        });
      } else if (operation === "update") {
        await expect(updateBoardNote(env, "user-1", "note-1", { body: "Updated" })).resolves.toEqual({
          type: "updated",
          result: { ok: true, versions: { sheets: [{ id: "sheet-1", version: initialVersion + 1 }] } }
        });
      } else if (operation === "layout") {
        await expect(
          updateBoardNoteLayout(env, "user-1", "note-1", { x: 10, y: 20, width: 240, height: 180 })
        ).resolves.toEqual({
          ok: true,
          versions: { sheets: [{ id: "sheet-1", version: initialVersion + 1 }] }
        });
      } else {
        await expect(deleteBoardNote(env, "user-1", "note-1")).resolves.toEqual({
          ok: true,
          versions: { sheets: [{ id: "sheet-1", version: initialVersion + 1 }] }
        });
      }

      expect(state.sheets.get("sheet-1")?.version).toBe(initialVersion + 1);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.filter((statement) => statement.sql.includes("content_version = content_version + 1"))).toHaveLength(1);
      expect(
        preparedSql.filter((sql) => /^\s*SELECT\b/i.test(sql) && sql.includes("content_version"))
      ).toEqual([]);
    }
  );

  it("keeps rejected sheet and note mutations from changing version state", async () => {
    const cases: Array<{
      name: string;
      arrange?: (state: MutationState) => void;
      mutate: (env: Parameters<typeof createBoardSheet>[0]) => Promise<unknown>;
      expected: unknown;
    }> = [
      {
        name: "create sheet name conflict",
        mutate: (env) => createBoardSheet(env, "user-1", { name: "Other" }),
        expected: null
      },
      {
        name: "rename not found",
        mutate: (env) => updateBoardSheet(env, "user-1", "missing", { name: "Missing" }),
        expected: { type: "not_found" }
      },
      {
        name: "rename conflict",
        mutate: (env) => updateBoardSheet(env, "user-1", "sheet-1", { name: "Other" }),
        expected: { type: "name_conflict" }
      },
      {
        name: "delete not found",
        mutate: (env) => deleteBoardSheet(env, "user-1", "missing"),
        expected: { type: "not_found" }
      },
      {
        name: "delete last sheet",
        arrange: (state) => state.sheets.delete("sheet-2"),
        mutate: (env) => deleteBoardSheet(env, "user-1", "sheet-1"),
        expected: { type: "last_sheet" }
      },
      {
        name: "create table missing sheet",
        mutate: (env) => createBoardTable(env, "user-1", { sheetId: "missing", name: "Table", orientation: "custom" }),
        expected: null
      },
      {
        name: "create note missing sheet",
        mutate: (env) => createBoardNote(env, "user-1", { sheetId: "missing", title: "Memo", body: "" }),
        expected: null
      },
      {
        name: "update note not found",
        mutate: (env) => updateBoardNote(env, "user-1", "missing", { body: "Nope" }),
        expected: { type: "not_found" }
      },
      {
        name: "layout note not found",
        mutate: (env) => updateBoardNoteLayout(env, "user-1", "missing", { x: 0, y: 0, width: 220, height: 160 }),
        expected: null
      },
      {
        name: "delete note not found",
        mutate: (env) => deleteBoardNote(env, "user-1", "missing"),
        expected: null
      }
    ];

    for (const testCase of cases) {
      const { env, state } = createAtomicMutationEnv();
      testCase.arrange?.(state);
      const before = cloneMutationState(state);

      await expect(testCase.mutate(env), testCase.name).resolves.toEqual(testCase.expected);
      expect(state.manifestVersion, testCase.name).toBe(before.manifestVersion);
      expect(state.sheets, testCase.name).toEqual(before.sheets);
    }
  });

  it("orders guarded version rows around destructive writes and uses RETURNING for parsed domain writes", async () => {
    const noteHarness = createAtomicMutationEnv();
    await deleteBoardNote(noteHarness.env, "user-1", "note-1");
    expect(noteHarness.batches[0]?.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("content_version = content_version + 1"),
      expect.stringMatching(/DELETE FROM board_notes[\s\S]*RETURNING id/)
    ]);

    const sheetHarness = createAtomicMutationEnv();
    await deleteBoardSheet(sheetHarness.env, "user-1", "sheet-1");
    const sheetStatements = sheetHarness.batches[0] ?? [];
    expect(sheetStatements.map((statement) => statement.sql)).toEqual([
      expect.stringMatching(/board_manifest_versions[\s\S]*other\.id <> target\.id/),
      expect.stringMatching(/UPDATE sheets[\s\S]*target\.is_default = 1[\s\S]*other\.id <> target\.id/),
      expect.stringMatching(/DELETE FROM sheets[\s\S]*other\.id <> sheets\.id[\s\S]*RETURNING id/),
      expect.stringMatching(/SELECT CASE[\s\S]*THEN 'last_sheet'[\s\S]*ELSE 'not_found'/)
    ]);

    const renameHarness = createAtomicMutationEnv();
    await updateBoardSheet(renameHarness.env, "user-1", "sheet-1", { name: "Renamed" });
    expect(renameHarness.batches[0]?.map((statement) => statement.sql)).toEqual([
      expect.stringMatching(/UPDATE sheets[\s\S]*RETURNING id/),
      expect.stringContaining("content_version = content_version + 1"),
      expect.stringContaining("board_manifest_versions")
    ]);
  });

  it("serializes stale deletion attempts through guarded batches without deleting the last sheet", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const { env, batches, preparedSql } = createSqliteD1Env(database, { interleaveDeletePreflights: true });

      const [deleteA, deleteB] = await Promise.all([
        deleteBoardSheet(env, "user-1", "A"),
        deleteBoardSheet(env, "user-1", "B")
      ]);

      expect(deleteA).toEqual({
        type: "deleted",
        result: { ok: true, versions: { sheets: [], manifestVersion: 1 } }
      });
      expect(deleteB).toEqual({ type: "last_sheet" });
      expect(database.prepare("SELECT id, is_default FROM sheets ORDER BY sort_order").all()).toEqual([
        { id: "B", is_default: 1 }
      ]);
      expect(database.prepare("SELECT id FROM board_tables ORDER BY id").all()).toEqual([{ id: "table-B" }]);
      expect(database.prepare("SELECT id FROM board_notes ORDER BY id").all()).toEqual([{ id: "note-B" }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_axis_items").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_states").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_completions").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")).toEqual({ version: 1 });

      const beforeDuplicate = {
        sheets: database.prepare("SELECT id, is_default FROM sheets ORDER BY sort_order").all(),
        tables: database.prepare("SELECT id FROM board_tables ORDER BY id").all(),
        notes: database.prepare("SELECT id FROM board_notes ORDER BY id").all(),
        manifest: database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")
      };
      await expect(deleteBoardSheet(env, "user-1", "A")).resolves.toEqual({ type: "not_found" });
      expect({
        sheets: database.prepare("SELECT id, is_default FROM sheets ORDER BY sort_order").all(),
        tables: database.prepare("SELECT id FROM board_tables ORDER BY id").all(),
        notes: database.prepare("SELECT id FROM board_notes ORDER BY id").all(),
        manifest: database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")
      }).toEqual(beforeDuplicate);

      expect(preparedSql.some((sql) => sql.includes("SELECT id, is_default FROM sheets"))).toBe(false);
      expect(preparedSql.some((sql) => sql.includes("SELECT COUNT(*) AS count FROM sheets"))).toBe(false);
      expect(batches).toHaveLength(3);
      expect(
        batches.every((statements) =>
          statements.every(
            (statement) =>
              !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(statement.sql) ||
              (statement.sql.includes("sheets") && statement.sql.includes("EXISTS"))
          )
        )
      ).toBe(true);
      expect(batches.every((statements) => statements.at(-1)?.sql.includes("SELECT CASE"))).toBe(true);
      expect(
        batches.some((statements) => statements.some((statement) => /DELETE FROM board_(notes|tables|axis|cell)/.test(statement.sql)))
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("reassigns the current default on each guarded deletion in a three-sheet board", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B", "C"]);
      const { env } = createSqliteD1Env(database);

      await expect(deleteBoardSheet(env, "user-1", "A")).resolves.toEqual({
        type: "deleted",
        result: { ok: true, versions: { sheets: [], manifestVersion: 1 } }
      });
      expect(database.prepare("SELECT id, is_default FROM sheets ORDER BY sort_order").all()).toEqual([
        { id: "B", is_default: 1 },
        { id: "C", is_default: 0 }
      ]);

      await expect(deleteBoardSheet(env, "user-1", "B")).resolves.toEqual({
        type: "deleted",
        result: { ok: true, versions: { sheets: [], manifestVersion: 2 } }
      });
      expect(database.prepare("SELECT id, is_default FROM sheets ORDER BY sort_order").all()).toEqual([
        { id: "C", is_default: 1 }
      ]);
      expect(database.prepare("SELECT id FROM board_tables ORDER BY id").all()).toEqual([{ id: "table-C" }]);
      expect(database.prepare("SELECT id FROM board_notes ORDER BY id").all()).toEqual([{ id: "note-C" }]);
      expect(database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")).toEqual({ version: 2 });
    } finally {
      database.close();
    }
  });

  it("rejects note writes when the note user and sheet owner do not match", async () => {
    const database = createBoardMutationDatabase();
    try {
      database.prepare("INSERT INTO users (id) VALUES (?), (?)").run("user-1", "user-2");
      database.prepare("INSERT INTO sheets (id, user_id, name, is_default) VALUES (?, ?, ?, 1)")
        .run("foreign-sheet", "user-2", "Foreign");
      database.prepare("INSERT INTO board_notes (id, user_id, sheet_id, title, body) VALUES (?, ?, ?, ?, ?)")
        .run("malformed-note", "user-1", "foreign-sheet", "Original", "Original body");
      const { env } = createSqliteD1Env(database);

      await expect(updateBoardNote(env, "user-1", "malformed-note", { body: "Mutated" })).resolves.toEqual({ type: "not_found" });
      await expect(
        updateBoardNoteLayout(env, "user-1", "malformed-note", { x: 10, y: 20, width: 240, height: 180 })
      ).resolves.toBeNull();
      await expect(deleteBoardNote(env, "user-1", "malformed-note")).resolves.toBeNull();

      expect(
        database.prepare("SELECT title, body, x, y, width, height FROM board_notes WHERE id = ?").get("malformed-note")
      ).toEqual({ title: "Original", body: "Original body", x: 0, y: 0, width: 220, height: 160 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("foreign-sheet")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("lists owner shares and user share favorites", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async all() {
              if (sql.includes("FROM board_shares") && sql.includes("JOIN sheets")) {
                return {
                  results: [{ sheet_id: "sheet-1", sheet_name: "숙제", share_id: "share-1", created_at: "2026-06-05 00:00:00" }]
                };
              }
              if (sql.includes("FROM board_share_favorites")) {
                return {
                  results: [
                    {
                      share_id: "share-1",
                      sheet_id: "sheet-1",
                      sheet_name: "숙제",
                      owner_display_name: "냠수",
                      created_at: "2026-06-05 00:00:00"
                    }
                  ]
                };
              }
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof listBoardShares>[0];

    await expect(listBoardShares(env, "user-1")).resolves.toEqual([
      { sheetId: "sheet-1", sheetName: "숙제", shareId: "share-1", createdAt: "2026-06-05 00:00:00" }
    ]);
    await expect(listBoardShareFavorites(env, "viewer-1")).resolves.toEqual([
      {
        shareId: "share-1",
        sheetId: "sheet-1",
        sheetName: "숙제",
        ownerDisplayName: "냠수",
        createdAt: "2026-06-05 00:00:00"
      }
    ]);
  });

  it("adds and removes share favorites only for active shares", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT share_id FROM board_shares")) return { share_id: "share-1" };
              return null;
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
    } as unknown as Parameters<typeof addBoardShareFavorite>[0];

    await expect(addBoardShareFavorite(env, "viewer-1", "share-1")).resolves.toEqual({ shareId: "share-1" });
    await expect(deleteBoardShareFavorite(env, "viewer-1", "share-1")).resolves.toBe(true);
    expect(runs.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO board_share_favorites"))).toBe(true);
    expect(runs.some((statement) => statement.sql.includes("DELETE FROM board_share_favorites"))).toBe(true);
  });

  it("loads a shared board with pure read queries and no default seeding", async () => {
    const preparedSql: string[] = [];
    const axisItems = [
      {
        id: "row-task-1",
        user_id: "owner-1",
        table_id: "table-1",
        axis: "row",
        kind: "task",
        label: "일간",
        character_id: null,
        task_id: "task-1",
        task_scope: "character",
        task_reset_type: "daily",
        task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
        task_color: "#2563eb",
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      },
      {
        id: "column-character-1",
        user_id: "owner-1",
        table_id: "table-1",
        axis: "column",
        kind: "character",
        label: "냠수나이스1",
        character_id: "character-1",
        task_id: null,
        task_scope: null,
        task_reset_type: null,
        task_reset_rule_json: null,
        task_color: null,
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      }
    ];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_shares") && sql.includes("share_id = ?")) {
                return { owner_user_id: "owner-1", sheet_id: "sheet-1" };
              }
              if (sql.includes("FROM user_settings")) return null;
              return null;
            },
            async all() {
              if (sql.includes("FROM sheets")) {
                return { results: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1, content_version: 0 }] };
              }
              if (sql.includes("FROM board_tables")) {
                return {
                  results: [
                    {
                      id: "table-1",
                      user_id: "owner-1",
                      sheet_id: "sheet-1",
                      name: "숙제",
                      sort_order: 0,
                      x: 0,
                      y: 0
                    }
                  ]
                };
              }
              if (sql.includes("FROM board_notes")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) return { results: axisItems };
              if (sql.includes("FROM board_cell_states")) return { results: [] };
              if (sql.includes("FROM board_cell_completions")) {
                return {
                  results: [
                    {
                      table_id: "table-1",
                      row_item_id: "row-task-1",
                      column_item_id: "column-character-1",
                      period_key: "daily:2026-06-05",
                      completed: 1
                    }
                  ]
                };
              }
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadSharedBoard>[0];

    await expect(loadSharedBoard(env, "share-1", new Date("2026-06-05T03:00:00.000Z"))).resolves.toMatchObject({
      shareId: "share-1",
      readOnly: true,
      userId: "owner-1",
      sheets: [{ id: "sheet-1", name: "숙제" }],
      tables: [{ id: "table-1", sheet_id: "sheet-1" }],
      completions: [{ period_key: "daily:2026-06-05", completed: 1 }]
    });
    expect(preparedSql.some((sql) => sql.includes("SELECT checklist_orientation"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO board_tables"))).toBe(false);
  });

  it("loads owner board manifest metadata without scanning axis items on every poll", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              throw new Error("owner version summary should use one all() statement");
            },
            async all() {
              if (sql.includes("WITH manifest AS")) {
                return {
                  results: [
                    {
                      manifest_version: 3,
                      show_display_name: 1,
                      show_server_name: 0,
                      show_class_name: 0,
                      show_item_level: 1,
                      show_combat_power: 0,
                      id: "sheet-1",
                      name: "숙제",
                      sort_order: 10,
                      is_default: 1,
                      version: 5
                    }
                  ]
                };
              }
              if (sql.includes("FROM board_axis_items")) throw new Error("versions should not scan axis items");
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadBoardVersionSummary>[0];

    await expect(loadBoardVersionSummary(env, "user-1", new Date("2026-06-05T03:00:00.000Z"))).resolves.toEqual({
      manifestVersion: 3,
      sheets: [{ id: "sheet-1", name: "숙제", sort_order: 10, is_default: 1, version: 5 }],
      periodFingerprint: "",
      settings: {
        show_display_name: 1,
        show_server_name: 0,
        show_class_name: 0,
        show_item_level: 1,
        show_combat_power: 0
      }
    });
    const sheetQuery = preparedSql[0];
    expect(sheetQuery).toContain("name");
    expect(sheetQuery).toContain("sort_order");
    expect(sheetQuery).toContain("is_default");
    expect(sheetQuery).toContain("content_version AS version");
    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toContain("WITH manifest AS");
    expect(preparedSql.some((sql) => sql.includes("FROM board_axis_items"))).toBe(false);
  });

  it("loads shared board versions only when the share is active without scanning axis items", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_shares")) {
                return { owner_user_id: "owner-1", sheet_id: "sheet-1", content_version: 7 };
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM board_axis_items")) throw new Error("shared versions should not scan axis items");
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadSharedBoardVersionSummary>[0];

    await expect(loadSharedBoardVersionSummary(env, "AbCdEfGhIjKlMnOpQrStUv", new Date("2026-06-05T03:00:00.000Z"))).resolves.toEqual({
      shareId: "AbCdEfGhIjKlMnOpQrStUv",
      sheetId: "sheet-1",
      version: 7,
      periodFingerprint: ""
    });
    expect(preparedSql.some((sql) => sql.includes("FROM board_axis_items"))).toBe(false);
  });

  it("bumps the owning sheet version when saving completion and cell visibility patches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT locked FROM board_tables")) return { locked: 0 };
              return null;
            },
            async all() {
              if (sql.includes("SELECT input.ordinal")) return {
                results: (JSON.parse(String(this.values[1])) as Array<Record<string, unknown>>).map((row, ordinal) => ({
                  ordinal,
                  tableId: row.table_id,
                  rowItemId: row.row_item_id,
                  columnItemId: row.column_item_id,
                  eligible: 1,
                  sheetId: "sheet-1",
                  rowKind: "task",
                  columnKind: "character",
                  rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
                  columnTaskResetRuleJson: null
                }))
              };
              return { results: [] };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map((statement) => {
            const rows = JSON.parse(String(statement.values[1])) as Array<Record<string, unknown>>;
            const keyRows = rows.map((row) => ({
              tableId: row.table_id,
              rowItemId: row.row_item_id,
              columnItemId: row.column_item_id,
              ...(row.period_key ? { periodKey: row.period_key } : {})
            }));
            const results = statement.sql.includes("UPDATE sheets")
              ? [{ id: "sheet-1", version: 4 }]
              : statement.sql.includes("INSERT INTO board_cell_completions") && statement.sql.includes("RETURNING")
                ? keyRows
                : statement.sql.includes("INSERT INTO board_cell_states")
                  ? keyRows.filter((_, index) => rows[index]?.delete_state === 0)
                  : [];
            return { success: true, meta: { changes: results.length }, results };
          });
        }
      }
    } as unknown as Parameters<typeof saveBoardCompletionPatches>[0];

    await expect(
      saveBoardCompletionPatches(env, "user-1", [
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          periodKey: "daily:2026-06-05",
          completed: true
        }
      ])
    ).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } });
    await expect(
      saveBoardCellStatePatches(env, "user-1", [
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          markType: "disabled",
          memo: null
        }
      ])
    ).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
    expect(batches[1]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
  });

  it("maps existing orientation to board roles", () => {
    expect(defaultBoardRolesForOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(defaultBoardRolesForOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
  });

  it("maps creatable table orientations to board roles", () => {
    expect(boardRolesForTableOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(boardRolesForTableOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(boardRolesForTableOrientation("custom")).toMatchObject({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("transposes board table roles without changing custom semantics", () => {
    expect(transposeBoardRoles({ rowRole: "task", columnRole: "character", taskAxis: "rows" })).toEqual({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(transposeBoardRoles({ rowRole: "custom", columnRole: "custom", taskAxis: "none" })).toEqual({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("allows locked board table settings only when structure is unchanged", () => {
    const current = {
      name: "숙제",
      default_row_height: 40,
      default_column_width: 132,
      display_options_json: null,
      event_options_json: null,
      template_type: "custom" as const,
      locked: 1
    };

    expect(
      canApplyBoardTableSettingsUpdate(current, {
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        displaySettings: undefined
      })
    ).toBe(true);
    expect(
      canApplyBoardTableSettingsUpdate(current, {
        name: "주간 숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 1,
        displaySettings: undefined
      })
    ).toBe(false);
    expect(
      canApplyBoardTableSettingsUpdate({ ...current, locked: 0 }, {
        name: "주간 숙제",
        defaultRowHeight: 44,
        defaultColumnWidth: 144,
        locked: 1,
        displaySettings: {
          show_display_name: 1,
          show_server_name: 1,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      })
    ).toBe(true);
  });

  it("plans axis transposition with temporary sort orders to avoid unique collisions", () => {
    expect(
      buildBoardAxisItemTransposePlan([
        { id: "row-task-1", axis: "row", sort_order: 0, size_px: 40, cross_size_px: 180 },
        { id: "row-task-2", axis: "row", sort_order: 10, size_px: 52, cross_size_px: 180 },
        { id: "column-character-1", axis: "column", sort_order: 0, size_px: 132, cross_size_px: 30 },
        { id: "column-character-2", axis: "column", sort_order: 10, size_px: 148, cross_size_px: 30 }
      ])
    ).toEqual([
      {
        id: "row-task-1",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000010,
        finalSortOrder: 0,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "row-task-2",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000020,
        finalSortOrder: 10,
        finalSizePx: 148,
        finalCrossSizePx: 30
      },
      {
        id: "column-character-1",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000010,
        finalSortOrder: 0,
        finalSizePx: 40,
        finalCrossSizePx: 180
      },
      {
        id: "column-character-2",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000020,
        finalSortOrder: 10,
        finalSizePx: 52,
        finalCrossSizePx: 180
      }
    ]);
  });

  it("keeps destination row and column dimensions when transposing uneven axes", () => {
    expect(
      buildBoardAxisItemTransposePlan([
        { id: "row-task-1", axis: "row", sort_order: 0, size_px: 40, cross_size_px: 180 },
        { id: "row-task-2", axis: "row", sort_order: 10, size_px: 52, cross_size_px: 180 },
        { id: "column-character-1", axis: "column", sort_order: 0, size_px: 132, cross_size_px: 30 }
      ])
    ).toEqual([
      {
        id: "row-task-1",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000010,
        finalSortOrder: 0,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "row-task-2",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000020,
        finalSortOrder: 10,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "column-character-1",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000010,
        finalSortOrder: 0,
        finalSizePx: 40,
        finalCrossSizePx: 180
      }
    ]);
  });

  it("builds task-like manual axis items when the axis role is task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "task",
        label: "세르카",
        taskColorIndex: 1
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      label: "세르카",
      taskId: null,
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#13795b"
    });
  });

  it("builds free manual axis items when the axis role is not task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "column",
        axisRole: "custom",
        label: "냠1",
        taskColorIndex: 0
      })
    ).toMatchObject({
      axis: "column",
      kind: "custom",
      label: "냠1",
      taskId: null,
      characterId: null,
      taskScope: null,
      taskResetType: null,
      taskResetRuleJson: null,
      taskColor: null
    });
  });

  it("builds task-like manual rows for custom tables so their checkboxes can reset", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "custom",
        label: "필드 보스",
        taskColorIndex: 2
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#b45309"
    });
  });

  it("derives bootstrap orientation from an existing table's roles", () => {
    expect(defaultOrientationForTableRoles({ rowRole: "task", columnRole: "character" }, "tasks_columns")).toBe("tasks_rows");
    expect(defaultOrientationForTableRoles({ rowRole: "character", columnRole: "task" }, "tasks_rows")).toBe("tasks_columns");
    expect(defaultOrientationForTableRoles({ rowRole: "custom", columnRole: "custom" }, "tasks_rows")).toBe("tasks_rows");
  });

  it("keeps the latest board completion patch per semantic cell and period", () => {
    expect(
      mergeBoardCompletionPatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: true
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: false
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: false
      }
    ]);
  });

  it("keeps the latest board cell state patch per semantic cell", () => {
    expect(
      mergeBoardCellStatePatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "disabled",
          memo: null
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "fixed",
          memo: "고정파티"
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "fixed",
        memo: "고정파티"
      }
    ]);
  });

  it("builds task rows and character columns from existing checklist data", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0, taskColor: "#2563eb" },
      { axis: "column", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 }
    ]);
  });

  it("builds character rows and task columns when the user chose tasks as columns", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_columns",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: "{}",
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 },
      { axis: "column", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0 }
    ]);
  });

  it("does not keep syncing newly imported global characters into an initialized default table", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: false,
        existingAxisItems: [
          {
            axis: "row",
            kind: "task",
            task_id: "task-a",
            character_id: null,
            sort_order: 0
          }
        ],
        tasks: [],
        characters: [{ id: "character-b", name: "표비캐릭터", sortOrder: 20 }]
      })
    ).toEqual([]);
  });

  it("seeds initial default table axis items when the default table is newly created", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: true,
        existingAxisItems: [],
        tasks: [],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([{ axis: "column", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 }]);
  });

  it("does not seed an empty default table after it already existed", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: false,
        existingAxisItems: [],
        tasks: [],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toEqual([]);
  });

  it("keeps an initialized board empty instead of recreating the default table", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE user_id = ? LIMIT 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof ensureDefaultBoard>[0];

    await ensureDefaultBoard(env, "user-1");

    expect(runs.some((statement) => statement.sql.includes("INSERT INTO board_tables"))).toBe(false);
  });

  it("skips default seeding and legacy sync when any board table already exists", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_tables") && sql.includes("LIMIT 1")) return { id: "table-1" };
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          preparedSql.push(...statements.map((statement) => statement.sql));
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof ensureDefaultBoard>[0];

    await ensureDefaultBoard(env, "user-1");

    expect(preparedSql.some((sql) => sql.includes("FROM tasks"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("FROM characters"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("FROM completions"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO board_axis_items"))).toBe(false);
  });

  it("creates only the requested table after every existing table was deleted", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE user_id = ? LIMIT 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: -10, tableCount: 0 };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map((statement) => ({
            success: true,
            results: statement.sql.includes("INSERT INTO board_tables")
              ? [{ id: statement.values[0] }]
              : [{ id: "sheet-1", version: 1 }]
          }));
        }
      }
    } as unknown as Parameters<typeof createBoardTable>[0];

    await expect(
      createBoardTable(env, "user-1", {
        sheetId: "sheet-1",
        name: "새 표",
        orientation: "custom"
      })
    ).resolves.toEqual({
      id: expect.any(String),
      versions: { sheets: [{ id: "sheet-1", version: 1 }] }
    });

    const tableInserts = runs.filter((statement) => statement.sql.includes("INSERT INTO board_tables"));
    expect(tableInserts).toHaveLength(1);
    expect(tableInserts[0]?.values[3]).toBe("새 표");
  });

  it("places newly added board tables near the top-left even when the sheet already has tables", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE user_id = ? LIMIT 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 70, tableCount: 8 };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map((statement) => ({
            success: true,
            results: statement.sql.includes("INSERT INTO board_tables")
              ? [{ id: statement.values[0] }]
              : [{ id: "sheet-1", version: 1 }]
          }));
        }
      }
    } as unknown as Parameters<typeof createBoardTable>[0];

    await expect(
      createBoardTable(env, "user-1", {
        sheetId: "sheet-1",
        name: "겹쳐서 추가",
        orientation: "tasks_columns"
      })
    ).resolves.toEqual({
      id: expect.any(String),
      versions: { sheets: [{ id: "sheet-1", version: 1 }] }
    });

    const tableInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_tables"));
    expect(tableInsert?.values.slice(4, 7)).toEqual([80, 24, 24]);
  });

  it("reorders visible axis items when hidden items remain in the table", async () => {
    const axisItems = [
      { id: "row-a", visible: 1 },
      { id: "row-hidden", visible: 0 },
      { id: "row-b", visible: 1 }
    ];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              return { id: "table-1", locked: 0 };
            },
            async all() {
              const results = sql.includes("visible = 1") ? axisItems.filter((item) => item.visible === 1) : axisItems;
              return { results: results.map((item) => ({ id: item.id, visible: item.visible })) };
            },
            async run() {
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map((statement) => ({
            success: true,
            results: statement.sql.includes("UPDATE sheets")
              ? [{ id: "sheet-1", version: 4 }]
              : axisItems.map((item) => ({ id: item.id }))
          }));
        }
      }
    } as unknown as Parameters<typeof reorderBoardAxisItems>[0];

    await expect(
      reorderBoardAxisItems(env, "user-1", {
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-b", "row-a"]
      })
    ).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } });
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]?.[0]?.values[0]).toBe(JSON.stringify(["row-b", "row-a"]));
    expect(batches[0]?.[1]?.values[0]).toBe(JSON.stringify(["row-b", "row-a"]));
  });

  it("preserves hidden axis order while applying one visible reorder with 10-step sort orders", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      const tableId = "table-sheet-1";
      const insert = database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order, visible)
         VALUES (?, 'user-1', ?, 'row', 'custom', ?, ?, ?)`
      );
      insert.run("row-a", tableId, "Row A", 10, 1);
      insert.run("row-hidden-a", tableId, "Hidden A", 20, 0);
      insert.run("row-hidden-b", tableId, "Hidden B", 30, 0);
      insert.run("row-b", tableId, "Row B", 40, 1);
      database.exec("CREATE UNIQUE INDEX test_axis_sort ON board_axis_items(table_id, axis, sort_order)");
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(reorderBoardAxisItems(env, "user-1", {
        tableId,
        axis: "row",
        axisItemIds: ["row-b", "axis-row", "row-a"]
      })).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "sheet-1", version: 1 }] } });

      expect(database.prepare(
        `SELECT id, visible, sort_order
         FROM board_axis_items
         WHERE table_id = ? AND axis = 'row'
         ORDER BY sort_order`
      ).all(tableId)).toEqual([
        { id: "row-b", visible: 1, sort_order: 0 },
        { id: "axis-row", visible: 1, sort_order: 10 },
        { id: "row-a", visible: 1, sort_order: 20 },
        { id: "row-hidden-a", visible: 0, sort_order: 30 },
        { id: "row-hidden-b", visible: 0, sort_order: 40 }
      ]);
      expect(preparedSql).toHaveLength(3);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expect(batches[0]?.every((statement) => statement.values.length === 4)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("does not toggle hidden axis order across repeated visible reorders", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      const tableId = "table-sheet-1";
      const insert = database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order, visible)
         VALUES (?, 'user-1', ?, 'row', 'custom', ?, ?, ?)`
      );
      insert.run("row-a", tableId, "Row A", 10, 1);
      insert.run("row-hidden-a", tableId, "Hidden A", 20, 0);
      insert.run("row-hidden-b", tableId, "Hidden B", 30, 0);
      insert.run("row-b", tableId, "Row B", 40, 1);
      database.exec("CREATE UNIQUE INDEX test_axis_sort ON board_axis_items(table_id, axis, sort_order)");
      const { env, batches, preparedSql } = createSqliteD1Env(database);
      const input = {
        tableId,
        axis: "row" as const,
        axisItemIds: ["row-b", "axis-row", "row-a"]
      };
      const readOrder = () => database.prepare(
        `SELECT id, visible, sort_order
         FROM board_axis_items
         WHERE table_id = ? AND axis = 'row'
         ORDER BY sort_order`
      ).all(tableId);
      const expectedOrder = [
        { id: "row-b", visible: 1, sort_order: 0 },
        { id: "axis-row", visible: 1, sort_order: 10 },
        { id: "row-a", visible: 1, sort_order: 20 },
        { id: "row-hidden-a", visible: 0, sort_order: 30 },
        { id: "row-hidden-b", visible: 0, sort_order: 40 }
      ];

      await expect(reorderBoardAxisItems(env, "user-1", input)).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "sheet-1", version: 1 }] }
      });
      expect(readOrder()).toEqual(expectedOrder);

      await expect(reorderBoardAxisItems(env, "user-1", input)).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "sheet-1", version: 2 }] }
      });
      expect(readOrder()).toEqual(expectedOrder);
      expect(preparedSql).toHaveLength(6);
      expect(batches).toHaveLength(2);
      expect(batches.every((batch) => batch.length === 3)).toBe(true);
      expect(batches.every((batch) => batch.every((statement) => statement.values.length === 4))).toBe(true);
    } finally {
      database.close();
    }
  });

  it("reorders the 300-item axis maximum with guarded bounded statements", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      const tableId = "table-sheet-1";
      const insert = database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order)
         VALUES (?, 'user-1', ?, 'row', 'custom', ?, ?)`
      );
      for (let index = 1; index < 300; index += 1) {
        insert.run(`row-${index}`, tableId, `Row ${index}`, index * 10);
      }
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order, visible)
         VALUES ('row-hidden', 'user-1', ?, 'row', 'custom', 'Hidden', 3000, 0)`
      ).run(tableId);
      database.exec("CREATE UNIQUE INDEX test_axis_sort ON board_axis_items(table_id, axis, sort_order)");
      const axisItemIds = ["axis-row", ...Array.from({ length: 299 }, (_, index) => `row-${index + 1}`)].reverse();
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(reorderBoardAxisItems(env, "user-1", { tableId, axis: "row", axisItemIds })).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "sheet-1", version: 1 }] }
      });

      expect(preparedSql).toHaveLength(3);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expect(batches[0]?.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches[0]?.every((statement) => statement.sql.includes("json_array_length"))).toBe(true);
      expect(database.prepare(
        "SELECT id FROM board_axis_items WHERE table_id = ? AND axis = 'row' AND visible = 1 ORDER BY sort_order"
      ).all(tableId).map((row) => row.id)).toEqual(axisItemIds);
      expect(database.prepare("SELECT sort_order FROM board_axis_items WHERE id = 'row-hidden'").get()).toEqual({
        sort_order: 3000
      });
    } finally {
      database.close();
    }
  });

  it("rejects a whole axis order without writes when one id is unavailable", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order)
         VALUES ('row-1', 'user-1', 'table-sheet-1', 'row', 'custom', 'Row 1', 10)`
      ).run();
      const { env } = createSqliteD1Env(database);

      await expect(reorderBoardAxisItems(env, "user-1", {
        tableId: "table-sheet-1",
        axis: "row",
        axisItemIds: ["axis-row", "missing-row"]
      })).resolves.toBeNull();
      expect(database.prepare(
        "SELECT id, sort_order FROM board_axis_items WHERE table_id = 'table-sheet-1' AND axis = 'row' ORDER BY sort_order"
      ).all()).toEqual([
        { id: "axis-row", sort_order: 0 },
        { id: "row-1", sort_order: 10 }
      ]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'sheet-1'").get()).toEqual({
        content_version: 0
      });
    } finally {
      database.close();
    }
  });

  it("does no D1 work for an empty axis order", async () => {
    const database = createBoardMutationDatabase();
    try {
      const { env, batches, preparedSql } = createSqliteD1Env(database);
      await expect(reorderBoardAxisItems(env, "user-1", {
        tableId: "missing-table",
        axis: "row",
        axisItemIds: []
      })).resolves.toEqual({ ok: true, versions: { sheets: [] } });
      expect(preparedSql).toEqual([]);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("imports 200 table characters with bounded set SQL", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      database.prepare(
        "UPDATE board_tables SET row_role = 'character', column_role = 'task', task_axis = 'columns' WHERE id = 'table-sheet-1'"
      ).run();
      const { env, batches, preparedSql } = createSqliteD1Env(database);
      const characters = Array.from({ length: 200 }, (_, index) => ({
        name: `캐릭터${index}`,
        serverName: index % 2 === 0 ? "아만" : "카단",
        className: "브레이커",
        itemLevel: `${1700 - index}.00`,
        combatPower: `${3000 - index}.00`
      }));

      await expect(importBoardCharactersForTable(env, "user-1", "table-sheet-1", characters)).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "sheet-1", version: 1 }] }
      });

      expect(preparedSql).toHaveLength(10);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(6);
      expect(batches[0]?.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches[0]?.filter((statement) => statement.sql.includes("INSERT INTO characters"))).toHaveLength(1);
      expect(batches[0]?.some((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM characters").get()).toEqual({ count: 200 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_axis_items WHERE character_id IS NOT NULL").get())
        .toEqual({ count: 200 });
      expect(database.prepare("SELECT row_role, column_role, task_axis FROM board_tables WHERE id = 'table-sheet-1'").get())
        .toEqual({ row_role: "task", column_role: "character", task_axis: "rows" });
    } finally {
      database.close();
    }
  });

  it("returns all distinct sheet versions when a table import changes a shared character", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1", "sheet-2"]);
      database.prepare(
        `INSERT INTO characters (
           id, user_id, name, server_name, class_name, item_level, combat_power, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("character-shared", "user-1", "공유캐릭터", "아만", "브레이커", "1,640.00", "2,500.00", "lostark");
      database.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, character_id, sort_order
         ) VALUES (?, 'user-1', ?, 'column', 'character', '공유캐릭터', 'character-shared', 10),
                  (?, 'user-1', ?, 'column', 'character', '공유캐릭터', 'character-shared', 0)`
      ).run("axis-shared-1", "table-sheet-1", "axis-shared-2", "table-sheet-2");
      const { env } = createSqliteD1Env(database);

      await expect(importBoardCharactersForTable(env, "user-1", "table-sheet-1", [{
        name: "공유캐릭터",
        serverName: "아만",
        className: "환수사",
        itemLevel: "1,700.00",
        combatPower: "3,000.00"
      }])).resolves.toEqual({
        ok: true,
        versions: {
          sheets: [
            { id: "sheet-1", version: 1 },
            { id: "sheet-2", version: 1 }
          ]
        }
      });
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 1 },
        { content_version: 1 }
      ]);
      expect(database.prepare("SELECT class_name, item_level, combat_power FROM characters WHERE id = 'character-shared'").get())
        .toEqual({ class_name: "환수사", item_level: "1,700.00", combat_power: "3,000.00" });
    } finally {
      database.close();
    }
  });

  it("rejects a table character import without its target sheet version", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["sheet-1"]);
      const { env } = createSqliteD1Env(database, { emptyResultIndex: 0 });

      await expect(importBoardCharactersForTable(env, "user-1", "table-sheet-1", [{
        name: "캐릭터",
        serverName: "아만",
        className: "브레이커",
        itemLevel: "1,700.00",
        combatPower: null
      }])).rejects.toThrow("Board mutation batch did not return every required row");
    } finally {
      database.close();
    }
  });

  it("does no D1 work for an empty table character import", async () => {
    const database = createBoardMutationDatabase();
    try {
      const { env, batches, preparedSql } = createSqliteD1Env(database);
      await expect(importBoardCharactersForTable(env, "user-1", "missing-table", [])).resolves.toEqual({
        ok: true,
        versions: { sheets: [] }
      });
      expect(preparedSql).toEqual([]);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("inherits visible axis item dimensions when creating a new manual row", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 10, taskCount: 1 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [{ axis: "row", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          inserts.push(...statements.filter((statement) => statement.sql.includes("INSERT INTO board_axis_items")));
          return successfulVersionedMutationBatch(statements);
        }
      }
    } as unknown as Parameters<typeof createBoardAxisItem>[0];

    await expect(createBoardAxisItem(env, "user-1", { tableId: "table-1", axis: "row", label: "새 숙제" })).resolves.toEqual({
      id: expect.any(String),
      versions: { sheets: [{ id: "sheet-1", version: 4 }] }
    });

    const inserted = inserts.at(-1);
    expect(inserted?.sql).toContain("size_px");
    expect(inserted?.sql).toContain("cross_size_px");
    expect(inserted?.values.slice(11, 14)).toEqual([20, 44, 180]);
  });

  it("creates a manual character and attaches it to the table character axis", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("FROM characters") && sql.includes("name = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS max_sort")) return { max_sort: -10 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              if (sql.includes("kind = 'character' AND character_id = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 10 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) return { results: [] };
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          return successfulVersionedMutationBatch(statements, runs);
        }
      }
    } as unknown as Parameters<typeof createManualBoardCharacterForTable>[0];

    await expect(
      createManualBoardCharacterForTable(env, "user-1", "table-1", {
        name: "임의캐릭터",
        serverName: "",
        className: "",
        itemLevel: "",
        combatPower: null
      })
    ).resolves.toEqual({ id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    const characterInsert = runs.find((statement) => statement.sql.includes("INSERT INTO characters"));
    const axisInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_axis_items"));
    expect(characterInsert?.sql).toContain("'manual'");
    expect(characterInsert?.values.slice(2, 7)).toEqual(["임의캐릭터", "", "", "", null]);
    expect(axisInsert?.values[3]).toBe("임의캐릭터");
    expect(axisInsert?.values[4]).toBe(20);
    expect(axisInsert?.values[7]).toEqual(expect.any(String));
  });

  it("uses the existing character axis when table roles are stale after a transpose", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("FROM characters") && sql.includes("name = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS max_sort")) return { max_sort: -10 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 48, cross_size_px: 132 };
              if (sql.includes("kind = 'character' AND character_id = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 80 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          return successfulVersionedMutationBatch(statements, runs);
        }
      }
    } as unknown as Parameters<typeof createManualBoardCharacterForTable>[0];

    await expect(
      createManualBoardCharacterForTable(env, "user-1", "table-1", {
        name: "전환후캐릭터",
        serverName: "",
        className: "",
        itemLevel: "",
        combatPower: null
      })
    ).resolves.toEqual({ id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    const axisInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_axis_items"));
    const roleRepair = runs.find((statement) => statement.sql.includes("UPDATE board_tables"));
    expect(roleRepair?.values.slice(0, 3)).toEqual(["character", "task", "columns"]);
    expect(axisInsert?.values[2]).toBe("row");
    expect(axisInsert?.values.slice(4, 7)).toEqual([90, 48, 132]);
  });

  it("inherits visible axis item dimensions when adding a task row", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 10, taskCount: 1 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [{ axis: "row", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          inserts.push(...statements.filter((statement) => statement.sql.includes("INSERT INTO board_axis_items")));
          return successfulVersionedMutationBatch(statements);
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "새 숙제",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        taskColor: "#be123c"
      })
    ).resolves.toEqual({ id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    const inserted = inserts.at(-1);
    expect(inserted?.sql).toContain("size_px");
    expect(inserted?.sql).toContain("cross_size_px");
    expect(inserted?.values.slice(7, 12)).toEqual(["#be123c", 20, 44, 180, null]);
  });

  it("adds new board tasks to the task column after a table transpose", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "character", column_role: "task" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "character", column_role: "task", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 132, cross_size_px: 48 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 30, taskCount: 4 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          inserts.push(...statements.filter((statement) => statement.sql.includes("INSERT INTO board_axis_items")));
          return successfulVersionedMutationBatch(statements);
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "전환 후 숙제",
        scope: "character",
        resetRule: { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" },
        taskColor: "#7c3aed"
      })
    ).resolves.toEqual({ id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    const inserted = inserts.at(-1);
    expect(inserted?.values[2]).toBe("column");
    expect(inserted?.values[3]).toBe("전환 후 숙제");
    expect(inserted?.values[5]).toBe("weekly");
    expect(inserted?.values.slice(7, 12)).toEqual(["#7c3aed", 40, 132, 48, null]);
  });

  it("uses the existing task axis when table roles are stale after a transpose", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const roleRepairs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 132, cross_size_px: 48 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 30, taskCount: 4 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE board_tables")) roleRepairs.push({ sql, values: this.values });
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          roleRepairs.push(...statements.filter((statement) => statement.sql.includes("UPDATE board_tables")));
          inserts.push(...statements.filter((statement) => statement.sql.includes("INSERT INTO board_axis_items")));
          return successfulVersionedMutationBatch(statements);
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "역할 불일치 방어",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" }
      })
    ).resolves.toEqual({ id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } });

    expect(roleRepairs.at(-1)?.values.slice(0, 3)).toEqual(["character", "task", "columns"]);
    expect(inserts.at(-1)?.values[2]).toBe("column");
  });

  it("reuses an existing board task created by the same request id", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("create_request_id") && sql.includes("FROM board_axis_items")) return { id: "axis-existing" };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "새 숙제",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        createRequestId: "task-create-1"
      })
    ).resolves.toEqual({ id: "axis-existing", versions: { sheets: [] } });
    expect(runs.some((statement) => statement.sql.includes("INSERT INTO board_axis_items"))).toBe(false);
  });

  function createTaskCreateRequestRaceEnv(error: Error, winnerId: string | null) {
    const preparedSql: string[] = [];
    let axisRequestReads = 0;
    let batchCalls = 0;
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("FROM board_axis_items") && sql.includes("create_request_id = ?")) {
                axisRequestReads += 1;
                return axisRequestReads === 1 || winnerId === null ? null : { id: winnerId };
              }
              if (sql.includes("SELECT id FROM tasks") && sql.includes("create_request_id = ?")) return null;
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return null;
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: -10, taskCount: 0 };
              return null;
            },
            async all() {
              return { results: [] };
            }
          };
        },
        async batch() {
          batchCalls += 1;
          throw error;
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    return {
      env,
      preparedSql,
      axisRequestReads: () => axisRequestReads,
      batchCalls: () => batchCalls
    };
  }

  it.each([
    ["task", "D1_ERROR: UNIQUE constraint failed: tasks.user_id, tasks.create_request_id"],
    ["axis item", "D1_ERROR: UNIQUE constraint failed: board_axis_items.table_id, board_axis_items.create_request_id"]
  ])("recovers the winning axis after a concurrent %s create-request conflict", async (_constraint, errorMessage) => {
    const race = createTaskCreateRequestRaceEnv(new Error(errorMessage), "axis-winner");

    await expect(
      createBoardTaskForTable(race.env, "user-1", "table-1", {
        name: "동시 생성 숙제",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        createRequestId: "task-create-race"
      })
    ).resolves.toEqual({ id: "axis-winner", versions: { sheets: [] } });

    expect(race.batchCalls()).toBe(1);
    expect(race.axisRequestReads()).toBe(2);
    expect(race.preparedSql.some((sql) => sql.startsWith("SELECT") && sql.includes("content_version"))).toBe(false);
  });

  it("rethrows an expected create-request conflict when no winning axis exists", async () => {
    const error = new Error("D1_ERROR: UNIQUE constraint failed: tasks.user_id, tasks.create_request_id");
    const race = createTaskCreateRequestRaceEnv(error, null);

    await expect(
      createBoardTaskForTable(race.env, "user-1", "table-1", {
        name: "승자 없는 충돌",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        createRequestId: "task-create-no-winner"
      })
    ).rejects.toBe(error);
    expect(race.axisRequestReads()).toBe(2);
  });

  it("rethrows unrelated batch errors without a conflict-recovery read", async () => {
    const error = new Error("D1_ERROR: database unavailable");
    const race = createTaskCreateRequestRaceEnv(error, "axis-winner");

    await expect(
      createBoardTaskForTable(race.env, "user-1", "table-1", {
        name: "무관한 오류",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        createRequestId: "task-create-unrelated-error"
      })
    ).rejects.toBe(error);
    expect(race.axisRequestReads()).toBe(1);
  });

  it("maps legacy task-character completions to board row and column item ids", () => {
    expect(
      buildBoardCompletionPatchesFromLegacy({
        tableId: "table-1",
        axisItems: [
          {
            id: "row-task-1",
            axis: "row",
            kind: "task",
            taskId: "task-1",
            characterId: null
          },
          {
            id: "column-character-1",
            axis: "column",
            kind: "character",
            taskId: null,
            characterId: "character-1"
          }
        ],
        completions: [
          {
            taskId: "task-1",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      })
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-character-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("derives only current board completion periods from task reset rules", () => {
    expect(
      getCurrentBoardCompletionPeriodKeys(
        [
          {
            kind: "task",
            task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
          },
          {
            kind: "task",
            task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}'
          },
          {
            kind: "task",
            task_reset_rule_json: '{"type":"none"}'
          },
          {
            kind: "character",
            task_reset_rule_json: null
          }
        ],
        new Date("2026-06-04T02:00:00.000Z")
      )
    ).toEqual(["daily:2026-06-04", "weekly:2026-06-03", "none:permanent"]);
  });

  it("loads only current-period board cell completions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T02:00:00.000Z"));

    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const axisItems = [
      {
        id: "row-task-1",
        user_id: "user-1",
        table_id: "table-1",
        axis: "row",
        kind: "task",
        label: "일간",
        character_id: null,
        task_id: "task-1",
        task_scope: "character",
        task_reset_type: "daily",
        task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
        task_color: "#2563eb",
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      },
      {
        id: "column-character-1",
        user_id: "user-1",
        table_id: "table-1",
        axis: "column",
        kind: "character",
        label: "냠수나이스1",
        character_id: "character-1",
        task_id: null,
        task_scope: null,
        task_reset_type: null,
        task_reset_rule_json: null,
        task_color: null,
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      }
    ];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              prepared.push({ sql, values: this.values });
              if (sql.includes("FROM board_tables") && sql.includes("LIMIT 1")) return { id: "table-1" };
              return null;
            },
            async all() {
              prepared.push({ sql, values: this.values });
              if (sql.includes("FROM board_axis_items")) return { results: axisItems };
              if (sql.includes("FROM board_cell_completions")) {
                return {
                  results: [
                    {
                      table_id: "table-1",
                      row_item_id: "row-task-1",
                      column_item_id: "column-character-1",
                      period_key: "daily:2026-06-04",
                      completed: 1
                    }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              prepared.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          prepared.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof loadBoard>[0];

    await expect(loadBoard(env, "user-1")).resolves.toMatchObject({
      completions: [{ period_key: "daily:2026-06-04", completed: 1 }]
    });

    const completionQuery = prepared.find((statement) => statement.sql.includes("FROM board_cell_completions"));
    expect(completionQuery?.sql).toContain("period_key IN (SELECT value FROM json_each(?2))");
    expect(completionQuery?.values).toEqual(["user-1", JSON.stringify(["daily:2026-06-04"])]);
  });

  it("detects board completion patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCompletionPatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("detects board completion patches outside the server-derived KST period", () => {
    expect(
      findBoardCompletionPatchesOutsideCurrentPeriod(
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-05-28",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            periodKey: "daily:2026-05-29",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          }
        ],
        new Date("2026-05-28T20:59:00.000Z")
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-2",
        periodKey: "daily:2026-05-29",
        completed: true
      }
    ]);
  });

  it("detects board cell state patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCellStatePatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            markType: "disabled",
            memo: null
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            markType: "default",
            memo: null
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        markType: "default",
        memo: null
      }
    ]);
  });

  it("rejects reserved cell marks whose period key is not current", () => {
    const target = {
      tableId: "table-1",
      rowItemId: "row-task-1",
      columnItemId: "column-character-1",
      rowKind: "task" as const,
      columnKind: "character" as const,
      rowTaskResetRuleJson: JSON.stringify({ type: "daily", hour: 6, timezone: "Asia/Seoul" }),
      columnTaskResetRuleJson: null
    };
    const now = new Date("2026-06-11T12:00:00+09:00");
    const base = { tableId: "table-1", rowItemId: "row-task-1", columnItemId: "column-character-1" };

    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod(
        [{ ...base, markType: "reserved", memo: "약속", periodKey: "daily:2026-06-11" }],
        [target],
        now
      )
    ).toEqual([]);
    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod(
        [{ ...base, markType: "reserved", memo: "약속", periodKey: "daily:2026-06-10" }],
        [target],
        now
      )
    ).toHaveLength(1);
    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod([{ ...base, markType: "fixed", memo: "고정" }], [target], now)
    ).toEqual([]);
  });

  it("drops expired reserved cell marks while keeping fixed and disabled marks", () => {
    const axisItems = [
      {
        id: "row-task-1",
        kind: "task",
        task_reset_rule_json: JSON.stringify({ type: "daily", hour: 6, timezone: "Asia/Seoul" })
      },
      { id: "column-character-1", kind: "character", task_reset_rule_json: null }
    ];
    const now = new Date("2026-06-11T12:00:00+09:00");
    const base = { row_item_id: "row-task-1", column_item_id: "column-character-1" };

    expect(
      resolveExpiredBoardCellStateRows(
        [
          { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-11" },
          { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-10" },
          { ...base, mark_type: "reserved", mark_period_key: null },
          { ...base, mark_type: "fixed", mark_period_key: null },
          { ...base, mark_type: "disabled", mark_period_key: null }
        ],
        axisItems,
        now
      )
    ).toEqual([
      { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-11" },
      { ...base, mark_type: "fixed", mark_period_key: null },
      { ...base, mark_type: "disabled", mark_period_key: null }
    ]);
  });

  it("batches a table layout write with its owning-sheet version and validates both returned rows", async () => {
    const batches: MutationStatement[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          batches.push(statements);
          return statements.map((statement) =>
            statement.sql.includes("UPDATE sheets")
              ? { success: true, results: [{ id: "sheet-1", version: 4 }] }
              : { success: true, results: [{ id: "table-1" }] }
          );
        }
      }
    } as unknown as Parameters<typeof updateBoardTableLayout>[0];

    await expect(
      updateBoardTableLayout(env, "user-1", "table-1", { x: 10, y: 20, width: 320, height: 180 })
    ).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.sql).toContain("UPDATE board_tables");
    expect(batches[0]?.[0]?.sql).toContain("RETURNING id");
    expect(batches[0]?.[1]?.sql).toContain("UPDATE sheets");

    const partialEnv = {
      DB: {
        prepare: env.DB.prepare,
        async batch(statements: MutationStatement[]) {
          return statements.map((statement) =>
            statement.sql.includes("UPDATE sheets")
              ? { success: true, results: [{ id: "sheet-1", version: 5 }] }
              : { success: true, results: [] }
          );
        }
      }
    } as unknown as Parameters<typeof updateBoardTableLayout>[0];
    await expect(
      updateBoardTableLayout(partialEnv, "user-1", "table-1", { x: 1, y: 2, width: null, height: null })
    ).rejects.toThrow("did not return every required row");
  });

  it("bumps the owning sheet before deleting a table and validates the table delete row", async () => {
    const batches: MutationStatement[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              return { id: "table-1", locked: 0 };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          batches.push(statements);
          return statements.map((statement) => {
            if (statement.sql.includes("UPDATE sheets")) {
              return { success: true, results: [{ id: "sheet-1", version: 6 }] };
            }
            if (statement.sql.includes("DELETE FROM board_tables")) {
              return { success: true, results: [{ id: "table-1" }] };
            }
            return { success: true, results: [] };
          });
        }
      }
    } as unknown as Parameters<typeof deleteBoardTable>[0];

    await expect(deleteBoardTable(env, "user-1", "table-1")).resolves.toEqual({
      ok: true,
      versions: { sheets: [{ id: "sheet-1", version: 6 }] }
    });
    expect(batches[0]?.[0]?.sql).toContain("UPDATE sheets");
    expect(batches[0]?.at(-1)?.sql).toContain("DELETE FROM board_tables");
    expect(batches[0]?.at(-1)?.sql).toContain("RETURNING id");
  });

  it("resolves an axis sheet before hiding the item and fails closed on partial success", async () => {
    const batches: MutationStatement[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          batches.push(statements);
          return statements.map((statement) =>
            statement.sql.includes("UPDATE sheets")
              ? { success: true, results: [{ id: "sheet-1", version: 9 }] }
              : { success: true, results: [{ id: "axis-1" }] }
          );
        }
      }
    } as unknown as Parameters<typeof hideBoardAxisItem>[0];

    await expect(hideBoardAxisItem(env, "user-1", "axis-1")).resolves.toEqual({
      ok: true,
      versions: { sheets: [{ id: "sheet-1", version: 9 }] }
    });
    expect(batches[0]?.[0]?.sql).toContain("UPDATE sheets");
    expect(batches[0]?.[1]?.sql).toContain("SET visible = 0");
    expect(batches[0]?.[1]?.sql).toContain("RETURNING id");

    const partialEnv = {
      DB: {
        prepare: env.DB.prepare,
        async batch(statements: MutationStatement[]) {
          return statements.map((statement) =>
            statement.sql.includes("UPDATE sheets")
              ? { success: true, results: [] }
              : { success: true, results: [{ id: "axis-1" }] }
          );
        }
      }
    } as unknown as Parameters<typeof hideBoardAxisItem>[0];
    await expect(hideBoardAxisItem(partialEnv, "user-1", "axis-1")).rejects.toThrow(
      "did not return every required row"
    );
  });

  it("returns empty version metadata for accepted empty completion and cell-state batches without writing", async () => {
    let batchCalls = 0;
    const env = {
      DB: {
        prepare() {
          throw new Error("empty batches must not prepare SQL");
        },
        async batch() {
          batchCalls += 1;
          return [];
        }
      }
    } as unknown as Parameters<typeof saveBoardCompletionPatches>[0];

    await expect(saveBoardCompletionPatches(env, "user-1", [])).resolves.toEqual({
      ok: true,
      versions: { sheets: [] }
    });
    await expect(saveBoardCellStatePatches(env, "user-1", [])).resolves.toEqual({
      ok: true,
      versions: { sheets: [] }
    });
    expect(batchCalls).toBe(0);
  });

  it("writes 200 completion patches across two sheets with four DB statements and one version per sheet", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const pairs = [
        ...seedSqliteBulkAxisPairs(database, "table-A", "A", 100),
        ...seedSqliteBulkAxisPairs(database, "table-B", "B", 100)
      ];
      const patches = pairs.map((pair, index) => ({
        tableId: index < 100 ? "table-A" : "table-B",
        rowItemId: pair.rowId,
        columnItemId: pair.columnId,
        periodKey: "none:permanent",
        completed: index % 2 === 0
      }));
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(saveBoardCompletionPatches(env, "user-1", patches)).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }, { id: "B", version: 1 }] }
      });

      expect(preparedSql).toHaveLength(4);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_completions").get()).toEqual({ count: 201 });
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "A", content_version: 1 },
        { id: "B", content_version: 1 }
      ]);
    } finally {
      database.close();
    }
  });

  it("returns only the invalid completion key and performs no batch writes", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const pairs = seedSqliteBulkAxisPairs(database, "table-A", "bulk", 200);
      database.prepare("UPDATE board_axis_items SET visible = 0 WHERE id = ?").run(pairs[137]!.columnId);
      const patches = pairs.map((pair, index) => ({
        tableId: "table-A",
        rowItemId: pair.rowId,
        columnItemId: pair.columnId,
        periodKey: "none:permanent",
        completed: true
      }));
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(saveBoardCompletionPatches(env, "user-1", patches)).resolves.toEqual({
        ok: false,
        rejectedKeys: [{
          tableId: "table-A",
          rowItemId: pairs[137]!.rowId,
          columnItemId: pairs[137]!.columnId,
          periodKey: "none:permanent"
        }]
      });
      expect(preparedSql).toHaveLength(1);
      expect(batches).toHaveLength(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_completions").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("handles mixed cell-state delete, absent delete, and upsert with five DB statements", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const [absent, upsert] = seedSqliteBulkAxisPairs(database, "table-A", "mixed", 2);
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(saveBoardCellStatePatches(env, "user-1", [
        { tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column", markType: "default", memo: null },
        { tableId: "table-A", rowItemId: absent!.rowId, columnItemId: absent!.columnId, markType: "default", memo: "" },
        { tableId: "table-A", rowItemId: upsert!.rowId, columnItemId: upsert!.columnId, markType: "reserved", markIcon: "clock", memo: "soon", periodKey: "none:permanent" }
      ])).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "A", version: 1 }] } });

      expect(preparedSql).toHaveLength(5);
      expect(batches[0]).toHaveLength(4);
      expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
      expect(database.prepare(
        "SELECT row_item_id, mark_type, mark_icon, memo, mark_period_key FROM board_cell_states ORDER BY row_item_id"
      ).all()).toEqual([{ row_item_id: upsert!.rowId, mark_type: "reserved", mark_icon: "clock", memo: "soon", mark_period_key: "none:permanent" }]);
    } finally {
      database.close();
    }
  });

  it("accepts a delete returning a requested key inserted after preflight", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("DELETE FROM board_cell_states").run();
      const { env, batches, preparedSql } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          currentDatabase.prepare(
            `INSERT INTO board_cell_states
               (id, user_id, table_id, row_item_id, column_item_id, mark_type)
             VALUES ('raced-state', 'user-1', 'table-A', 'axis-row', 'axis-column', 'fixed')`
          ).run();
        }
      });

      await expect(saveBoardCellStatePatches(env, "user-1", [{
        tableId: "table-A",
        rowItemId: "axis-row",
        columnItemId: "axis-column",
        markType: "default",
        memo: null
      }])).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "A", version: 1 }] } });

      expect(database.prepare("SELECT id FROM board_cell_states").all()).toEqual([]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 1 });
      expect(preparedSql).toHaveLength(5);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(4);
      expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("accepts a requested delete as a no-op when another writer deletes after preflight", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const { env, batches, preparedSql } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          currentDatabase.prepare("DELETE FROM board_cell_states WHERE id = 'cell-state'").run();
        }
      });

      await expect(saveBoardCellStatePatches(env, "user-1", [{
        tableId: "table-A",
        rowItemId: "axis-row",
        columnItemId: "axis-column",
        markType: "default",
        memo: null
      }])).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "A", version: 1 }] } });

      expect(database.prepare("SELECT id FROM board_cell_states").all()).toEqual([]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 1 });
      expect(preparedSql).toHaveLength(5);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(4);
      expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("requires DELETE RETURNING keys to be a unique subset of all requested delete keys", async () => {
    const malformedRows = [
      [{ tableId: "table-A", rowItemId: "other-row", columnItemId: "axis-column" }],
      [
        { tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column" },
        { tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column" }
      ]
    ];

    for (const deleteReturningRows of malformedRows) {
      const database = createBoardMutationDatabase();
      try {
        seedSqliteBoard(database, ["A"]);
        const { env } = createSqliteD1Env(database, { deleteReturningRows });

        await expect(saveBoardCellStatePatches(env, "user-1", [{
          tableId: "table-A",
          rowItemId: "axis-row",
          columnItemId: "axis-column",
          markType: "default",
          memo: null
        }])).rejects.toThrow("did not return every required row");
      } finally {
        database.close();
      }
    }
  });

  it("applies only the latest duplicate logical key", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const { env, batches } = createSqliteD1Env(database);

      await expect(saveBoardCompletionPatches(env, "user-1", [
        { tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column", periodKey: "none:permanent", completed: false },
        { tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column", periodKey: "none:permanent", completed: true }
      ])).resolves.toEqual({ ok: true, versions: { sheets: [{ id: "A", version: 1 }] } });

      expect(JSON.parse(String(batches[0]?.[0]?.values[1]))).toHaveLength(1);
      expect(database.prepare("SELECT completed FROM board_cell_completions").get()).toEqual({ completed: 1 });
    } finally {
      database.close();
    }
  });

  it("writes 200 cell-state patches across two sheets with five DB statements", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const pairs = [
        ...seedSqliteBulkAxisPairs(database, "table-A", "state-A", 100),
        ...seedSqliteBulkAxisPairs(database, "table-B", "state-B", 100)
      ];
      const { env, batches, preparedSql } = createSqliteD1Env(database, { reverseReturningRows: true });
      const patches = pairs.map((pair, index) => ({
        tableId: index < 100 ? "table-A" : "table-B",
        rowItemId: pair.rowId,
        columnItemId: pair.columnId,
        markType: "fixed" as const,
        memo: `memo-${index}`
      }));

      await expect(saveBoardCellStatePatches(env, "user-1", patches)).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }, { id: "B", version: 1 }] }
      });
      expect(preparedSql).toHaveLength(5);
      expect(batches[0]).toHaveLength(4);
      expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_states").get()).toEqual({ count: 201 });
    } finally {
      database.close();
    }
  });

  it("rejects locked, foreign-sheet, deleted, moved, hidden, and swapped-axis targets before writing", async () => {
    const cases: Array<{ name: string; mutate: (database: DatabaseSync) => void }> = [
      { name: "locked", mutate: (database) => database.prepare("UPDATE board_tables SET locked = 1 WHERE id = 'table-A'").run() },
      { name: "foreign sheet", mutate: (database) => {
        database.prepare("INSERT INTO users (id) VALUES ('user-2')").run();
        database.prepare("UPDATE sheets SET user_id = 'user-2' WHERE id = 'A'").run();
      } },
      { name: "deleted", mutate: (database) => database.prepare("DELETE FROM board_axis_items WHERE id = 'axis-row'").run() },
      { name: "moved", mutate: (database) => database.prepare("UPDATE board_axis_items SET table_id = 'table-B' WHERE id = 'axis-row'").run() },
      { name: "hidden", mutate: (database) => database.prepare("UPDATE board_axis_items SET visible = 0 WHERE id = 'axis-column'").run() },
      { name: "swapped", mutate: (database) => {
        database.prepare("UPDATE board_axis_items SET axis = 'column' WHERE id = 'axis-row'").run();
        database.prepare("UPDATE board_axis_items SET axis = 'row' WHERE id = 'axis-column'").run();
      } }
    ];

    for (const testCase of cases) {
      const database = createBoardMutationDatabase();
      try {
        seedSqliteBoard(database, ["A", "B"]);
        testCase.mutate(database);
        const { env, batches, preparedSql } = createSqliteD1Env(database);
        await expect(saveBoardCompletionPatches(env, "user-1", [{
          tableId: "table-A",
          rowItemId: "axis-row",
          columnItemId: "axis-column",
          periodKey: "none:permanent",
          completed: true
        }]), testCase.name).resolves.toEqual({
          ok: false,
          rejectedKeys: [{ tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column", periodKey: "none:permanent" }]
        });
        expect(preparedSql, testCase.name).toHaveLength(1);
        expect(batches, testCase.name).toHaveLength(0);
      } finally {
        database.close();
      }
    }
  });

  it("returns precise stale completion and reserved-state keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T03:00:00.000Z"));
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET task_reset_rule_json = ? WHERE id = 'axis-row'")
        .run('{"type":"daily","hour":6,"timezone":"Asia/Seoul"}');
      const { env, batches } = createSqliteD1Env(database);

      await expect(saveBoardCompletionPatches(env, "user-1", [{
        tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
        periodKey: "daily:2026-07-14", completed: true
      }])).resolves.toEqual({
        ok: false,
        rejectedKeys: [{ tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column", periodKey: "daily:2026-07-14" }]
      });
      await expect(saveBoardCellStatePatches(env, "user-1", [{
        tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
        markType: "reserved", memo: null, periodKey: "daily:2026-07-14"
      }])).resolves.toEqual({
        ok: false,
        rejectedKeys: [{ tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column" }]
      });
      expect(batches).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back when a reset-rule snapshot changes before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          currentDatabase.prepare("UPDATE board_axis_items SET task_reset_rule_json = ? WHERE id = 'axis-row'")
            .run('{"type":"daily","hour":6,"timezone":"Asia/Seoul"}');
        }
      });

      await expect(saveBoardCompletionPatches(env, "user-1", [{
        tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
        periodKey: "none:permanent", completed: true
      }])).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT completed FROM board_cell_completions").get()).toEqual({ completed: 0 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back after the preflight reset boundary expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T03:00:00.000Z"));
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET task_reset_rule_json = ? WHERE id = 'axis-row'")
        .run('{"type":"daily","hour":6,"timezone":"Asia/Seoul"}');
      const { env } = createSqliteD1Env(database);

      await expect(saveBoardCompletionPatches(env, "user-1", [{
        tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
        periodKey: "daily:2020-01-01", completed: true
      }])).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT completed FROM board_cell_completions").get()).toEqual({ completed: 0 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("treats malformed mutation and version results as incomplete batches", async () => {
    for (const malformedResultIndex of [0, 1, 2]) {
      const database = createBoardMutationDatabase();
      try {
        seedSqliteBoard(database, ["A"]);
        const { env } = createSqliteD1Env(database, { malformedResultIndex });
        await expect(saveBoardCompletionPatches(env, "user-1", [{
          tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
          periodKey: "none:permanent", completed: true
        }])).rejects.toThrow("did not return every required row");
      } finally {
        database.close();
      }
    }
  });

  it("treats mismatched preflight keys and extra batch results as incomplete", async () => {
    for (const options of [{ malformedPreflight: true }, { extraBatchResult: true }]) {
      const database = createBoardMutationDatabase();
      try {
        seedSqliteBoard(database, ["A"]);
        const { env } = createSqliteD1Env(database, options);
        await expect(saveBoardCompletionPatches(env, "user-1", [{
          tableId: "table-A", rowItemId: "axis-row", columnItemId: "axis-column",
          periodKey: "none:permanent", completed: true
        }])).rejects.toThrow("did not return every required row");
      } finally {
        database.close();
      }
    }
  });

  it("executes non-default cell-state insert and upsert bindings in SQLite", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("DELETE FROM board_cell_states").run();
      const { env } = createSqliteD1Env(database);
      const patch = {
        tableId: "table-A",
        rowItemId: "axis-row",
        columnItemId: "axis-column",
        markType: "fixed" as const,
        memo: "first"
      };

      await expect(saveBoardCellStatePatches(env, "user-1", [patch])).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }] }
      });
      expect(
        database.prepare(
          "SELECT table_id, row_item_id, column_item_id, mark_type, memo FROM board_cell_states"
        ).all()
      ).toEqual([
        {
          table_id: "table-A",
          row_item_id: "axis-row",
          column_item_id: "axis-column",
          mark_type: "fixed",
          memo: "first"
        }
      ]);

      await expect(saveBoardCellStatePatches(env, "user-1", [{ ...patch, memo: "second" }])).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 2 }] }
      });
      expect(database.prepare("SELECT COUNT(*) AS count, MAX(memo) AS memo FROM board_cell_states").get()).toEqual({
        count: 1,
        memo: "second"
      });
    } finally {
      database.close();
    }
  });

  it("updates 97 visible table axis items with bounded set SQL and one sheet bump", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const insert = database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order)
         VALUES (?, 'user-1', 'table-A', ?, ?, ?, ?)`
      );
      for (let index = 0; index < 95; index += 1) {
        insert.run(
          `bulk-axis-${index}`,
          index % 2 === 0 ? "row" : "column",
          index % 3 === 0 ? "character" : "custom",
          `Axis ${index}`,
          (index + 1) * 10
        );
      }
      database.prepare(
        `INSERT INTO board_axis_items (
           id, user_id, table_id, axis, kind, label, visible, size_px, separator_json, display_options_json
         ) VALUES ('hidden-character', 'user-1', 'table-A', 'row', 'character', 'Hidden', 0, 7, 'hidden-separator', 'hidden-display')`
      ).run();
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM board_axis_items WHERE table_id = 'table-A' AND visible = 1"
      ).get()).toEqual({ count: 97 });

      const tableDisplaySettings = {
        show_display_name: 1 as const,
        show_server_name: 0 as const,
        show_class_name: 0 as const,
        show_item_level: 1 as const,
        show_combat_power: 0 as const
      };
      const characterDisplaySettings = {
        ...tableDisplaySettings,
        show_server_name: 1 as const,
        show_class_name: 1 as const
      };
      const characterSeparator = { widthPx: 4, style: "dashed" as const, color: "#334455" };
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Weekly",
        defaultRowHeight: 52,
        defaultColumnWidth: 148,
        locked: 0,
        displaySettings: tableDisplaySettings,
        applyRowSize: true,
        applyColumnSize: true,
        characterSeparator,
        characterDisplaySettings
      })).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }] }
      });

      expect(preparedSql).toHaveLength(8);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(7);
      expect(batches[0]?.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE sheets"))).toHaveLength(1);
      expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE board_axis_items"))).toHaveLength(1);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM board_axis_items WHERE table_id = 'table-A' AND visible = 1 AND axis = 'row' AND size_px IS NOT 52"
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM board_axis_items WHERE table_id = 'table-A' AND visible = 1 AND axis = 'column' AND size_px IS NOT 148"
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT DISTINCT separator_json, display_options_json
         FROM board_axis_items
         WHERE table_id = 'table-A' AND visible = 1 AND kind = 'character'`
      ).all()).toEqual([{
        separator_json: JSON.stringify(characterSeparator),
        display_options_json: JSON.stringify(characterDisplaySettings)
      }]);
      expect(database.prepare(
        "SELECT size_px, separator_json, display_options_json FROM board_axis_items WHERE id = 'hidden-character'"
      ).get()).toEqual({ size_px: 7, separator_json: "hidden-separator", display_options_json: "hidden-display" });
      expect(database.prepare(
        `SELECT name, default_row_height, default_column_width, display_options_json, locked
         FROM board_tables WHERE id = 'table-A'`
      ).get()).toEqual({
        name: "Weekly",
        default_row_height: 52,
        default_column_width: 148,
        display_options_json: JSON.stringify(tableDisplaySettings),
        locked: 0
      });
    } finally {
      database.close();
    }
  });

  it("allows only a lock-state change on a locked table and never propagates from it", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_tables SET locked = 1 WHERE id = 'table-A'").run();
      database.prepare("UPDATE board_axis_items SET size_px = 31 WHERE id = 'axis-row'").run();
      const { env, batches } = createSqliteD1Env(database);

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Table",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: false
      })).resolves.toBe("locked");
      expect(batches).toEqual([]);
      expect(database.prepare("SELECT locked FROM board_tables WHERE id = 'table-A'").get()).toEqual({ locked: 1 });
      expect(database.prepare("SELECT size_px FROM board_axis_items WHERE id = 'axis-row'").get()).toEqual({ size_px: 31 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Table",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: false,
        applyColumnSize: false
      })).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }] }
      });
      expect(batches).toHaveLength(1);
      expect(batches[0]?.some((statement) => statement.sql.includes("UPDATE board_axis_items"))).toBe(false);
      expect(database.prepare("SELECT locked FROM board_tables WHERE id = 'table-A'").get()).toEqual({ locked: 0 });
      expect(database.prepare("SELECT size_px FROM board_axis_items WHERE id = 'axis-row'").get()).toEqual({ size_px: 31 });
    } finally {
      database.close();
    }
  });

  it("returns not_found when a table is deleted after the settings pre-read", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("DELETE FROM board_tables WHERE id = 'table-A'").run();
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Changed",
        defaultRowHeight: 52,
        defaultColumnWidth: 148,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: true
      })).resolves.toBe("not_found");
      expect(database.prepare("SELECT id FROM board_tables WHERE id = 'table-A'").get()).toBeUndefined();
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("returns locked when an unlocked table locks after the settings pre-read", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET size_px = 31 WHERE id = 'axis-row'").run();
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = 'table-A'").run();
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Changed",
        defaultRowHeight: 52,
        defaultColumnWidth: 148,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: true
      })).resolves.toBe("locked");
      expect(database.prepare(
        "SELECT name, default_row_height, default_column_width, locked FROM board_tables WHERE id = 'table-A'"
      ).get()).toEqual({ name: "Table", default_row_height: 40, default_column_width: 132, locked: 1 });
      expect(database.prepare("SELECT size_px FROM board_axis_items WHERE id = 'axis-row'").get()).toEqual({ size_px: 31 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("returns conflict when a locked table unlocks after the settings pre-read", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_tables SET locked = 1 WHERE id = 'table-A'").run();
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 0 WHERE id = 'table-A'").run();
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Table",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: false,
        applyColumnSize: false
      })).resolves.toBe("conflict");
      expect(database.prepare(
        "SELECT name, default_row_height, default_column_width, locked FROM board_tables WHERE id = 'table-A'"
      ).get()).toEqual({ name: "Table", default_row_height: 40, default_column_width: 132, locked: 0 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rethrows unrelated table settings batch errors without race remapping", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const { env } = createSqliteD1Env(database, {
        beforeBatch() {
          throw new Error("D1 unavailable");
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Changed",
        defaultRowHeight: 52,
        defaultColumnWidth: 148,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: true
      })).rejects.toThrow("D1 unavailable");
      expect(database.prepare(
        "SELECT name, default_row_height, default_column_width FROM board_tables WHERE id = 'table-A'"
      ).get()).toEqual({ name: "Table", default_row_height: 40, default_column_width: 132 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back a partially applied multi-row table propagation", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order, size_px)
         VALUES ('axis-row-peer', 'user-1', 'table-A', 'row', 'custom', 'Peer', 20, 31),
                ('axis-row-ignored', 'user-1', 'table-A', 'row', 'custom', 'Ignored', 30, 31)`
      ).run();
      database.prepare("UPDATE board_axis_items SET size_px = 31 WHERE id = 'axis-row'").run();
      const attemptedAxisUpdates: string[] = [];
      database.function("record_table_size_update", (id) => {
        attemptedAxisUpdates.push(String(id));
        return 0;
      });
      database.exec(`
        CREATE TRIGGER record_table_size_update
        AFTER UPDATE OF size_px ON board_axis_items
        WHEN NEW.table_id = 'table-A' AND NEW.axis = 'row'
        BEGIN
          SELECT record_table_size_update(NEW.id);
        END;
        CREATE TEMP TRIGGER ignore_one_table_size_update
        BEFORE UPDATE OF size_px ON board_axis_items
        WHEN OLD.id = 'axis-row-ignored'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const { env } = createSqliteD1Env(database);

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Changed",
        defaultRowHeight: 52,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: false
      })).rejects.toThrow("did not return every required row");
      expect(attemptedAxisUpdates.sort()).toEqual(["axis-row", "axis-row-peer"]);
      expect(database.prepare(
        "SELECT name, default_row_height, default_column_width FROM board_tables WHERE id = 'table-A'"
      ).get()).toEqual({ name: "Table", default_row_height: 40, default_column_width: 132 });
      expect(database.prepare(
        `SELECT id, size_px FROM board_axis_items
         WHERE id IN ('axis-row', 'axis-row-peer', 'axis-row-ignored') ORDER BY id`
      ).all()).toEqual([
        { id: "axis-row", size_px: 31 },
        { id: "axis-row-ignored", size_px: 31 },
        { id: "axis-row-peer", size_px: 31 }
      ]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back an idempotent table propagation when its guarded update is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET size_px = 52 WHERE id = 'axis-row'").run();
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("axis = 'row'") && statement.sql.includes("SET size_px");
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Table",
        defaultRowHeight: 52,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: false
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT default_row_height FROM board_tables WHERE id = 'table-A'").get()).toEqual({
        default_row_height: 40
      });
      expect(database.prepare("SELECT size_px FROM board_axis_items WHERE id = 'axis-row'").get()).toEqual({ size_px: 52 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back an idempotent table update when its guarded write is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("UPDATE board_tables") && statement.sql.includes("SET name = ?");
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Table",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        applyRowSize: false,
        applyColumnSize: false
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back table settings when the sheet version bump is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET size_px = 31 WHERE id = 'axis-row'").run();
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("UPDATE sheets");
        }
      });

      await expect(updateBoardTableSettings(env, "user-1", "table-A", {
        name: "Changed",
        defaultRowHeight: 52,
        defaultColumnWidth: 148,
        locked: 0,
        applyRowSize: true,
        applyColumnSize: false
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare(
        "SELECT name, default_row_height, default_column_width FROM board_tables WHERE id = 'table-A'"
      ).get()).toEqual({ name: "Table", default_row_height: 40, default_column_width: 132 });
      expect(database.prepare("SELECT size_px FROM board_axis_items WHERE id = 'axis-row'").get()).toEqual({ size_px: 31 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("updates one axis item and propagates cross size to 97 visible peers only", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const insert = database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order)
         VALUES (?, 'user-1', 'table-A', 'row', 'custom', ?, ?)`
      );
      for (let index = 0; index < 96; index += 1) {
        insert.run(`row-peer-${index}`, `Peer ${index}`, (index + 1) * 10);
      }
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, visible, cross_size_px)
         VALUES ('row-hidden', 'user-1', 'table-A', 'row', 'custom', 'Hidden', 0, 77),
                ('row-other-table', 'user-1', 'table-B', 'row', 'custom', 'Other', 1, 66)`
      ).run();
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM board_axis_items WHERE table_id = 'table-A' AND axis = 'row' AND visible = 1"
      ).get()).toEqual({ count: 97 });
      const { env, batches, preparedSql } = createSqliteD1Env(database);

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Updated",
        taskColor: "#334455",
        sizePx: 44,
        crossSizePx: 96
      })).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }] }
      });

      expect(preparedSql).toHaveLength(8);
      expect(preparedSql.some((sql) => /^\s*SELECT\b/i.test(sql))).toBe(false);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(8);
      expect(batches[0]?.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE board_axis_items"))).toHaveLength(2);
      expect(database.prepare(
        "SELECT label, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-row'"
      ).get()).toEqual({ label: "Updated", size_px: 44, cross_size_px: 96 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM board_axis_items WHERE table_id = 'table-A' AND axis = 'row' AND visible = 1 AND cross_size_px IS NOT 96"
      ).get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT cross_size_px FROM board_axis_items WHERE id = 'axis-column'").get()).toEqual({ cross_size_px: null });
      expect(database.prepare("SELECT cross_size_px FROM board_axis_items WHERE id = 'row-hidden'").get()).toEqual({ cross_size_px: 77 });
      expect(database.prepare("SELECT cross_size_px FROM board_axis_items WHERE id = 'row-other-table'").get()).toEqual({ cross_size_px: 66 });
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "A", content_version: 1 },
        { id: "B", content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("accepts a size-only non-task axis patch without overwriting details", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        `UPDATE board_axis_items
         SET label = 'Original', task_color = '#112233', size_px = 40, cross_size_px = 80
         WHERE id = 'axis-column'`
      ).run();
      const { env } = createSqliteD1Env(database);

      await expect(updateBoardAxisItem(env, "user-1", "axis-column", {
        sizePx: 44,
        crossSizePx: 96
      })).resolves.toEqual({
        ok: true,
        versions: { sheets: [{ id: "A", version: 1 }] }
      });
      expect(database.prepare(
        "SELECT label, task_color, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-column'"
      ).get()).toEqual({ label: "Original", task_color: "#112233", size_px: 44, cross_size_px: 96 });
    } finally {
      database.close();
    }
  });

  it("rejects task-only fields on a visible non-task axis without bumping its sheet", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        `UPDATE board_axis_items
         SET label = 'Character', task_color = NULL, task_reset_type = NULL, task_reset_rule_json = NULL
         WHERE id = 'axis-column'`
      ).run();
      const { env } = createSqliteD1Env(database);

      await expect(updateBoardAxisItem(env, "user-1", "axis-column", {
        taskColor: "#334455"
      })).resolves.toBe("invalid_task_fields");
      await expect(updateBoardAxisItem(env, "user-1", "axis-column", {
        taskResetRule: { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" }
      })).resolves.toBe("invalid_task_fields");

      expect(database.prepare(
        `SELECT label, task_color, task_reset_type, task_reset_rule_json
         FROM board_axis_items WHERE id = 'axis-column'`
      ).get()).toEqual({
        label: "Character",
        task_color: null,
        task_reset_type: null,
        task_reset_rule_json: null
      });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back axis details and version after a partially applied multi-row cross-size propagation", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        "UPDATE board_axis_items SET label = 'Original', size_px = 40, cross_size_px = 80 WHERE id = 'axis-row'"
      ).run();
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, axis, kind, label, sort_order, cross_size_px)
         VALUES ('cross-row-peer', 'user-1', 'table-A', 'row', 'custom', 'Peer', 20, 80),
                ('cross-row-ignored', 'user-1', 'table-A', 'row', 'custom', 'Ignored', 30, 80)`
      ).run();
      const attemptedCrossUpdates: string[] = [];
      database.function("record_cross_size_update", (id) => {
        attemptedCrossUpdates.push(String(id));
        return 0;
      });
      database.exec(`
        CREATE TRIGGER record_cross_size_update
        AFTER UPDATE OF cross_size_px ON board_axis_items
        WHEN NEW.table_id = 'table-A' AND NEW.axis = 'row'
        BEGIN
          SELECT record_cross_size_update(NEW.id);
        END;
        CREATE TEMP TRIGGER ignore_one_cross_size_update
        BEFORE UPDATE OF cross_size_px ON board_axis_items
        WHEN OLD.id = 'cross-row-ignored'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const { env } = createSqliteD1Env(database);

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Changed",
        sizePx: 44,
        crossSizePx: 96
      })).rejects.toThrow("did not return every required row");
      expect(attemptedCrossUpdates.sort()).toEqual(["axis-row", "cross-row-peer"]);
      expect(database.prepare(
        "SELECT label, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-row'"
      ).get()).toEqual({ label: "Original", size_px: 40, cross_size_px: 80 });
      expect(database.prepare(
        `SELECT id, cross_size_px FROM board_axis_items
         WHERE id IN ('axis-row', 'cross-row-peer', 'cross-row-ignored') ORDER BY id`
      ).all()).toEqual([
        { id: "axis-row", cross_size_px: 80 },
        { id: "cross-row-ignored", cross_size_px: 80 },
        { id: "cross-row-peer", cross_size_px: 80 }
      ]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back an idempotent target update when its guarded write is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET label = 'Original', size_px = 40 WHERE id = 'axis-row'").run();
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("SET label = CASE");
        }
      });

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Original",
        sizePx: 40
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back an idempotent cross-size propagation when its guarded update is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        "UPDATE board_axis_items SET label = 'Original', size_px = 40, cross_size_px = 96 WHERE id = 'axis-row'"
      ).run();
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("SET cross_size_px");
        }
      });

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Changed",
        sizePx: 44,
        crossSizePx: 96
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare(
        "SELECT label, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-row'"
      ).get()).toEqual({ label: "Original", size_px: 40, cross_size_px: 96 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rolls back axis details when the sheet version bump is not accepted", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare(
        "UPDATE board_axis_items SET label = 'Original', size_px = 40, cross_size_px = 80 WHERE id = 'axis-row'"
      ).run();
      const { env } = createSqliteD1Env(database, {
        skipStatement(statement) {
          return statement.sql.includes("UPDATE sheets");
        }
      });

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Changed",
        sizePx: 44,
        crossSizePx: 96
      })).rejects.toThrow("did not return every required row");
      expect(database.prepare(
        "SELECT label, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-row'"
      ).get()).toEqual({ label: "Original", size_px: 40, cross_size_px: 80 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("returns null for missing or newly locked axis targets without a version-only mutation", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      database.prepare("UPDATE board_axis_items SET label = 'Original', size_px = 40, cross_size_px = 80 WHERE id = 'axis-row'").run();
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = 'table-A'").run();
        }
      });

      await expect(updateBoardAxisItem(env, "user-1", "axis-row", {
        label: "Changed",
        sizePx: 44,
        crossSizePx: 96
      })).resolves.toBeNull();
      await expect(updateBoardAxisItem(env, "user-1", "missing-axis", {
        label: "Changed",
        sizePx: 44,
        crossSizePx: 96
      })).resolves.toBeNull();
      expect(database.prepare(
        "SELECT label, size_px, cross_size_px FROM board_axis_items WHERE id = 'axis-row'"
      ).get()).toEqual({ label: "Original", size_px: 40, cross_size_px: 80 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = 'A'").get()).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("rejects a version-only axis mutation result as incomplete", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          return statements.map((statement) =>
            statement.sql.includes("UPDATE sheets")
              ? { success: true, results: [{ id: "A", version: 1 }] }
              : { success: true, results: [] }
          );
        }
      }
    } as unknown as Parameters<typeof updateBoardAxisItem>[0];

    await expect(updateBoardAxisItem(env, "user-1", "axis-1", {
      label: "Changed",
      sizePx: 44,
      crossSizePx: 96
    })).rejects.toThrow("did not return every required row");
  });

  it("keeps layout and versions unchanged when the table locks before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-A");
        }
      });

      await expect(
        updateBoardTableLayout(env, "user-1", "table-A", { x: 40, y: 50, width: 320, height: 180 })
      ).resolves.toBeNull();
      expect(database.prepare("SELECT x, y, width, height, locked FROM board_tables WHERE id = ?").get("table-A")).toEqual({
        x: 0,
        y: 0,
        width: null,
        height: null,
        locked: 1
      });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("A")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps table children and versions unchanged when delete races with a lock", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-A");
        }
      });

      await expect(deleteBoardTable(env, "user-1", "table-A")).resolves.toBeNull();
      expect(database.prepare("SELECT id, locked FROM board_tables WHERE id = ?").get("table-A")).toEqual({
        id: "table-A",
        locked: 1
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_axis_items").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_states").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM board_cell_completions").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("A")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps transpose children and versions unchanged when the table locks before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      const beforeAxes = database.prepare(
        "SELECT id, axis, sort_order, size_px, cross_size_px FROM board_axis_items ORDER BY id"
      ).all();
      const beforeCells = database.prepare(
        "SELECT row_item_id, column_item_id FROM board_cell_states"
      ).all();
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-A");
        }
      });

      await expect(transposeBoardTable(env, "user-1", "table-A")).resolves.toBeNull();
      expect(database.prepare(
        "SELECT id, axis, sort_order, size_px, cross_size_px FROM board_axis_items ORDER BY id"
      ).all()).toEqual(beforeAxes);
      expect(database.prepare("SELECT row_item_id, column_item_id FROM board_cell_states").all()).toEqual(beforeCells);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("A")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps completion batches all-or-none when one table locks before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const second = seedSqliteAxisPair(database, "table-B", "B");
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-B");
        }
      });

      await expect(
        saveBoardCompletionPatches(env, "user-1", [
          {
            tableId: "table-A",
            rowItemId: "axis-row",
            columnItemId: "axis-column",
            periodKey: "none:permanent",
            completed: true
          },
          {
            tableId: "table-B",
            rowItemId: second.rowId,
            columnItemId: second.columnId,
            periodKey: "none:permanent",
            completed: true
          }
        ])
      ).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT table_id, completed FROM board_cell_completions ORDER BY table_id").all()).toEqual([
        { table_id: "table-A", completed: 0 }
      ]);
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "A", content_version: 0 },
        { id: "B", content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps cell-state batches all-or-none when one table locks before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A", "B"]);
      const second = seedSqliteAxisPair(database, "table-B", "B");
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-B");
        }
      });

      await expect(
        saveBoardCellStatePatches(env, "user-1", [
          {
            tableId: "table-A",
            rowItemId: "axis-row",
            columnItemId: "axis-column",
            markType: "fixed",
            memo: "changed"
          },
          {
            tableId: "table-B",
            rowItemId: second.rowId,
            columnItemId: second.columnId,
            markType: "fixed",
            memo: "new"
          }
        ])
      ).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT table_id, mark_type, memo FROM board_cell_states ORDER BY table_id").all()).toEqual([
        { table_id: "table-A", mark_type: "default", memo: null }
      ]);
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "A", content_version: 0 },
        { id: "B", content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps default cell-state delete and versions unchanged when the table locks before the batch", async () => {
    const database = createBoardMutationDatabase();
    try {
      seedSqliteBoard(database, ["A"]);
      let raced = false;
      const { env } = createSqliteD1Env(database, {
        beforeBatch(_statements, currentDatabase) {
          if (raced) return;
          raced = true;
          currentDatabase.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-A");
        }
      });

      await expect(
        saveBoardCellStatePatches(env, "user-1", [
          {
            tableId: "table-A",
            rowItemId: "axis-row",
            columnItemId: "axis-column",
            markType: "default",
            memo: null
          }
        ])
      ).rejects.toThrow("did not return every required row");
      expect(database.prepare("SELECT id FROM board_cell_states").all()).toEqual([{ id: "cell-state" }]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("A")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps share start and stop ownership-guarded without board version statements", async () => {
    const batches: MutationStatement[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM sheets")) return { id: "sheet-1" };
              if (sql.includes("FROM board_shares")) return { share_id: "share-old" };
              return null;
            }
          };
        },
        async batch(statements: MutationStatement[]) {
          batches.push(statements);
          return statements.map((statement) => ({
            success: true,
            results: statement.sql.includes("RETURNING")
              ? [{ id: statement.sql.includes("DELETE FROM board_shares") ? "sheet-1" : String(statement.values[0] ?? "share-row") }]
              : []
          }));
        }
      }
    } as unknown as Parameters<typeof startBoardSheetShare>[0];

    await expect(startBoardSheetShare(env, "user-1", "sheet-1")).resolves.toEqual({
      shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/)
    });
    await expect(stopBoardSheetShare(env, "user-1", "sheet-1")).resolves.toBe(true);

    const statements = batches.flat();
    expect(statements.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(false);
    expect(statements.some((statement) => statement.sql.includes("content_version"))).toBe(false);
    const shareInsert = statements.find((statement) => statement.sql.includes("INSERT INTO board_shares"));
    const shareDelete = statements.find(
      (statement) => statement.sql.includes("DELETE FROM board_shares") && statement.sql.includes("RETURNING")
    );
    expect(shareInsert?.sql).toContain("SELECT");
    expect(shareInsert?.sql).toContain("FROM sheets");
    expect(shareInsert?.sql).toContain("sheets.user_id =");
    expect(shareInsert?.sql).toContain("RETURNING");
    expect(shareDelete?.sql).toContain("EXISTS");
    expect(shareDelete?.sql).toContain("FROM sheets");
    expect(shareDelete?.sql).toContain("RETURNING");
  });
});
