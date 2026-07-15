import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCharacter,
  updateCharacterDetails,
  updateCharacterDisplayName,
  updateCharacterFromLostArk
} from "./characters";
import { searchRosterCharacters } from "../lostark/client";
import type { Env } from "../env";

vi.mock("../lostark/client", () => ({
  searchRosterCharacters: vi.fn()
}));

interface FakeCharacterRow {
  id: string;
  name: string;
  server_name: string;
  source: string;
  last_refresh_attempt_at: string | null;
}

function createEnv(current: FakeCharacterRow | null) {
  const runs: Array<{ sql: string; bindings: unknown[] }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: unknown[]) {
            return {
              async first() {
                if (sql.includes("FROM characters")) return current;
                return null;
              },
              async run() {
                runs.push({ sql, bindings });
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    }
  } as unknown as Env;
  return { env, runs };
}

interface SqliteD1Statement {
  sql: string;
  values: unknown[];
  bind(...values: unknown[]): SqliteD1Statement;
}

function createCharacterDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      server_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      display_name TEXT,
      item_level TEXT NOT NULL,
      combat_power TEXT,
      memo TEXT,
      source TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      last_refresh_attempt_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sheets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE board_tables (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL
    );
    CREATE TABLE board_axis_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      character_id TEXT,
      visible INTEGER NOT NULL DEFAULT 1
    );
  `);
  return database;
}

function createSqliteEnv(database: DatabaseSync): { env: Env; batches: SqliteD1Statement[][] } {
  const batches: SqliteD1Statement[][] = [];

  const execute = (statement: SqliteD1Statement) => {
    const values = statement.values as SQLInputValue[];
    const returnsRows = /\bRETURNING\b/i.test(statement.sql);
    if (returnsRows) {
      const rows = database.prepare(statement.sql).all(...values) as Record<string, unknown>[];
      return { success: true, meta: { changes: rows.length }, results: rows };
    }
    const result = database.prepare(statement.sql).run(...values);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  };

  const env = {
    DB: {
      prepare(sql: string) {
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async first() {
            return database.prepare(sql).get(...(this.values as SQLInputValue[])) ?? null;
          },
          async run() {
            return execute(this);
          }
        };
      },
      async batch(statements: SqliteD1Statement[]) {
        batches.push(statements);
        database.exec("BEGIN");
        try {
          const results = statements.map(execute);
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    }
  } as unknown as Env;

  return { env, batches };
}

function insertCharacter(
  database: DatabaseSync,
  id: string,
  options: { userId?: string; source?: "lostark" | "manual"; enabled?: number; deletedAt?: string | null } = {}
): void {
  database.prepare(
    `INSERT INTO characters (
       id, user_id, name, server_name, class_name, item_level, combat_power, source, enabled, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options.userId ?? "user-1",
    `name-${id}`,
    "아만",
    "브레이커",
    "1,640.00",
    "2,500.00",
    options.source ?? "lostark",
    options.enabled ?? 1,
    options.deletedAt ?? null
  );
}

function insertProjection(database: DatabaseSync, characterId: string): void {
  database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?)")
    .run("sheet-1", "user-1", "sheet-2", "user-1");
  database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)")
    .run(
      "table-1", "user-1", "sheet-1",
      "table-1-duplicate", "user-1", "sheet-1",
      "table-2", "user-1", "sheet-2"
    );
  database.prepare(
    "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)"
  ).run(
    "axis-1", "user-1", "table-1", characterId,
    "axis-1-duplicate", "user-1", "table-1-duplicate", characterId,
    "axis-2", "user-1", "table-2", characterId
  );
}

describe("updateCharacterFromLostArk", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    vi.mocked(searchRosterCharacters).mockReset();
  });

  it("blocks refresh attempts within one minute without calling Lost Ark", async () => {
    const { env, runs } = createEnv({
      id: "character-1",
      name: "냠수나이스1",
      server_name: "아만",
      source: "lostark",
      last_refresh_attempt_at: "2026-06-02T09:59:30.000Z"
    });

    await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toEqual({
      type: "rate_limited",
      retryAfterSeconds: 30
    });
    expect(searchRosterCharacters).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  it("records refresh attempts before looking up the Lost Ark roster", async () => {
    const { env, runs } = createEnv({
      id: "character-1",
      name: "냠수나이스1",
      server_name: "아만",
      source: "lostark",
      last_refresh_attempt_at: "2026-06-02T09:58:30.000Z"
    });
    vi.mocked(searchRosterCharacters).mockResolvedValue([]);

    await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toBe("not_available");
    expect(searchRosterCharacters).toHaveBeenCalledWith(env, "냠수나이스1", { bypassCache: true });
    expect(runs[0]).toMatchObject({
      bindings: ["2026-06-02T10:00:00.000Z", "character-1", "user-1"]
    });
    expect(runs[0]?.sql).toContain("last_refresh_attempt_at = ?");
  });

  it("atomically returns the refreshed character with every affected sheet version", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env, batches } = createSqliteEnv(database);
      vi.mocked(searchRosterCharacters).mockResolvedValue([
        {
          name: "name-character-1",
          serverName: "아만",
          className: "환수사",
          itemLevel: "1,700.00",
          combatPower: "3,000.00"
        }
      ]);

      await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toEqual({
        character: {
          id: "character-1",
          name: "name-character-1",
          serverName: "아만",
          className: "환수사",
          itemLevel: "1,700.00",
          combatPower: "3,000.00"
        },
        versions: {
          sheets: [
            { id: "sheet-1", version: 1 },
            { id: "sheet-2", version: 1 }
          ]
        }
      });
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(database.prepare("SELECT class_name, item_level, combat_power FROM characters WHERE id = ?").get("character-1"))
        .toEqual({ class_name: "환수사", item_level: "1,700.00", combat_power: "3,000.00" });
    } finally {
      database.close();
    }
  });

  it("does not report refresh success when the active character disappears during the external call", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env } = createSqliteEnv(database);
      vi.mocked(searchRosterCharacters).mockImplementation(async () => {
        database.prepare("UPDATE characters SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run("character-1");
        return [
          {
            name: "name-character-1",
            serverName: "아만",
            className: "환수사",
            itemLevel: "1,700.00",
            combatPower: "3,000.00"
          }
        ];
      });

      await expect(updateCharacterFromLostArk(env, "user-1", "character-1")).resolves.toBe("not_found");
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });
});

describe("character projection mutations", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("atomically updates a display name and returns additive versions for distinct sheets", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env, batches } = createSqliteEnv(database);

      await expect(updateCharacterDisplayName(env, "user-1", "character-1", "레이드")).resolves.toEqual({
        ok: true,
        versions: {
          sheets: [
            { id: "sheet-1", version: 1 },
            { id: "sheet-2", version: 1 }
          ]
        }
      });
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expect(database.prepare("SELECT display_name FROM characters WHERE id = ?").get("character-1"))
        .toEqual({ display_name: "레이드" });
    } finally {
      database.close();
    }
  });

  it("returns an empty sheet list without a manifest version when details have no board reference", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1", { source: "manual" });
      const { env, batches } = createSqliteEnv(database);

      await expect(
        updateCharacterDetails(env, "user-1", "character-1", {
          name: "수동 캐릭터",
          serverName: "",
          className: "도화가",
          displayName: "서포터",
          itemLevel: "1,650+",
          combatPower: null,
          memo: "고정 파티"
        })
      ).resolves.toEqual({ ok: true, versions: { sheets: [] } });
      expect(batches).toHaveLength(1);
      expect(database.prepare("SELECT name, class_name, display_name, item_level, memo FROM characters WHERE id = ?")
        .get("character-1")).toEqual({
        name: "수동 캐릭터",
        class_name: "도화가",
        display_name: "서포터",
        item_level: "1,650+",
        memo: "고정 파티"
      });
    } finally {
      database.close();
    }
  });

  it("bumps versions before soft-deleting so the active character remains eligible", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env, batches } = createSqliteEnv(database);

      await expect(deleteCharacter(env, "user-1", "character-1")).resolves.toEqual({
        ok: true,
        versions: {
          sheets: [
            { id: "sheet-1", version: 1 },
            { id: "sheet-2", version: 1 }
          ]
        }
      });
      expect(batches[0]?.[0]?.sql).toContain("UPDATE sheets");
      expect(batches[0]?.[1]?.sql).toContain("UPDATE characters");
      expect(database.prepare("SELECT enabled, deleted_at IS NOT NULL AS deleted FROM characters WHERE id = ?")
        .get("character-1")).toEqual({ enabled: 0, deleted: 1 });
    } finally {
      database.close();
    }
  });

  it("does not bump versions for missing or deleted mutation targets", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-deleted", { enabled: 0, deletedAt: "2026-06-01 00:00:00" });
      insertProjection(database, "character-deleted");
      const { env } = createSqliteEnv(database);

      await expect(updateCharacterDisplayName(env, "user-1", "character-deleted", "숨김")).resolves.toBeNull();
      await expect(
        updateCharacterDetails(env, "user-1", "character-missing", {
          displayName: null,
          itemLevel: "",
          combatPower: null
        })
      ).resolves.toBeNull();
      await expect(deleteCharacter(env, "user-1", "character-deleted")).resolves.toBeNull();
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back the rendered character mutation when its version statement fails", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      database.exec(`
        CREATE TRIGGER reject_character_sheet_version
        BEFORE UPDATE OF content_version ON sheets
        BEGIN
          SELECT RAISE(ABORT, 'version failure');
        END;
      `);
      const { env } = createSqliteEnv(database);

      await expect(updateCharacterDisplayName(env, "user-1", "character-1", "레이드")).rejects.toThrow("version failure");
      expect(database.prepare("SELECT display_name FROM characters WHERE id = ?").get("character-1"))
        .toEqual({ display_name: null });
    } finally {
      database.close();
    }
  });
});
