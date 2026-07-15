import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as CharacterDb from "./characters";
import * as LostArkClient from "../lostark/client";
import type { ImportedCharacterCandidate } from "../lostark/normalize";
import { ApiError } from "../http/errors";

const {
  deleteCharacter,
  reorderCharacters,
  saveSelectedCharacters,
  updateCharacterDetails,
  updateCharacterDisplayName
} = CharacterDb;
import type { Env } from "../env";

vi.mock("../lostark/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lostark/client")>();
  return {
    ...actual,
    fetchLostArkCharacterProfile: vi.fn(),
    searchRosterCharacters: vi.fn()
  };
});

type CharacterRefreshBatchItem =
  | { id: string; status: "updated"; character: CharacterSnapshot }
  | { id: string; status: "manual" | "not_found" | "not_available" }
  | { id: string; status: "rate_limited"; retryAfterSeconds: number }
  | { id: string; status: "failed"; code: string };

interface CharacterSnapshot {
  id?: string;
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

type RefreshCharactersFromLostArk = (
  env: Env,
  userId: string,
  characterIds: string[]
) => Promise<{
  results: CharacterRefreshBatchItem[];
  versions: { sheets: Array<{ id: string; version: number }> };
}>;

function getRefreshCharactersFromLostArk(): RefreshCharactersFromLostArk {
  const candidate = (CharacterDb as unknown as {
    refreshCharactersFromLostArk?: RefreshCharactersFromLostArk;
  }).refreshCharactersFromLostArk;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("refreshCharactersFromLostArk is unavailable");
  return candidate;
}

function profileMock() {
  const candidate = (LostArkClient as unknown as {
    fetchLostArkCharacterProfile?: (
      env: Env,
      characterName: string
    ) => Promise<ImportedCharacterCandidate | null>;
  }).fetchLostArkCharacterProfile;
  expect(candidate).toBeTypeOf("function");
  if (!candidate) throw new Error("fetchLostArkCharacterProfile mock is unavailable");
  return vi.mocked(candidate);
}

function createBatchResultEnv(batchResults: unknown[]): Env {
  return {
    LOSTARK_API_KEY: "lostark-key",
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
        return batchResults;
      }
    }
  } as unknown as Env;
}

function createScriptedRefreshEnv(batchResults: unknown[]): Env {
  const allResults: unknown[][] = [
    [{
      position: 0,
      requested_id: "character-1",
      id: "character-1",
      name: "name-character-1",
      server_name: "아만",
      class_name: "브레이커",
      item_level: "1,640.00",
      combat_power: "2,500.00",
      source: "lostark",
      last_refresh_attempt_at: null
    }],
    [{ id: "character-1" }]
  ];
  return {
    LOSTARK_API_KEY: "lostark-key",
    DB: {
      prepare(sql: string) {
        return {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            this.values = values;
            return this;
          },
          async all() {
            return { results: allResults.shift() ?? [] };
          }
        };
      },
      async batch() {
        return batchResults;
      }
    }
  } as unknown as Env;
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
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL CHECK (source IN ('lostark', 'manual')),
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      last_refresh_attempt_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, name, server_name)
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
      sheet_id TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE board_axis_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      character_id TEXT,
      axis TEXT NOT NULL DEFAULT 'column',
      kind TEXT NOT NULL DEFAULT 'character',
      visible INTEGER NOT NULL DEFAULT 1
    );
  `);
  return database;
}

function createSqliteEnv(database: DatabaseSync): {
  env: Env;
  batches: SqliteD1Statement[][];
  statements: SqliteD1Statement[];
} {
  const batches: SqliteD1Statement[][] = [];
  const statements: SqliteD1Statement[] = [];

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
    LOSTARK_API_KEY: "lostark-key",
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
            return database.prepare(sql).get(...(this.values as SQLInputValue[])) ?? null;
          },
          async all() {
            return { results: database.prepare(sql).all(...(this.values as SQLInputValue[])) };
          },
          async run() {
            return execute(this);
          }
        };
        statements.push(statement);
        return statement;
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

  return { env, batches, statements };
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

function hideProjection(database: DatabaseSync, characterId: string): void {
  database.prepare("UPDATE board_axis_items SET visible = 0 WHERE character_id = ?").run(characterId);
}

function refreshedProfile(characterId: string): ImportedCharacterCandidate {
  return {
    name: `name-${characterId}`,
    serverName: "아만",
    className: "환수사",
    itemLevel: "1,700.00",
    combatPower: "3,000.00"
  };
}

describe("set-based character arrays", () => {
  it("imports the schema maximum with bounded statements and bindings", async () => {
    const database = createCharacterDatabase();
    try {
      const { env, statements } = createSqliteEnv(database);
      const selected = Array.from({ length: 200 }, (_, index) => ({
        name: `캐릭터${index}`,
        serverName: index % 2 === 0 ? "아만" : "카단",
        className: "브레이커",
        itemLevel: `${1700 - index}.00`,
        combatPower: `${3000 - index}.00`
      }));

      await saveSelectedCharacters(env, "user-1", selected);

      expect(statements).toHaveLength(2);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("INSERT INTO characters"))).toHaveLength(1);
      expect(statements.some((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM characters").get()).toEqual({ count: 200 });
    } finally {
      database.close();
    }
  });

  it("bumps every distinct sheet that renders a changed imported character exactly once", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env } = createSqliteEnv(database);
      const changed = [{
        name: "name-character-1",
        serverName: "아만",
        className: "환수사",
        itemLevel: "1,700.00",
        combatPower: "3,000.00"
      }];

      await saveSelectedCharacters(env, "user-1", changed);

      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 1 },
        { content_version: 1 }
      ]);
      expect(database.prepare("SELECT class_name, item_level, combat_power FROM characters WHERE id = ?")
        .get("character-1")).toEqual({
        class_name: "환수사",
        item_level: "1,700.00",
        combat_power: "3,000.00"
      });

      await saveSelectedCharacters(env, "user-1", changed);
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 1 },
        { content_version: 1 }
      ]);
    } finally {
      database.close();
    }
  });

  it("reorders 100 characters in one guarded JSON statement", async () => {
    const database = createCharacterDatabase();
    try {
      for (let index = 0; index < 100; index += 1) insertCharacter(database, `character-${index}`);
      const { env, statements } = createSqliteEnv(database);
      const characterIds = Array.from({ length: 100 }, (_, index) => `character-${99 - index}`);

      await expect(reorderCharacters(env, "user-1", characterIds)).resolves.toBe(true);

      expect(statements).toHaveLength(1);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("UPDATE characters"))).toHaveLength(1);
      expect(statements.some((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(database.prepare("SELECT id FROM characters ORDER BY sort_order").all().map((row) => row.id)).toEqual(characterIds);
    } finally {
      database.close();
    }
  });

  it("does no character D1 work for empty arrays", async () => {
    const database = createCharacterDatabase();
    try {
      const { env, statements } = createSqliteEnv(database);

      await saveSelectedCharacters(env, "user-1", []);
      await expect(reorderCharacters(env, "user-1", [])).resolves.toBe(true);

      expect(statements).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects an incomplete character import RETURNING set", async () => {
    const env = createBatchResultEnv([{ results: [] }, { results: [] }]);

    await expect(saveSelectedCharacters(env, "user-1", [{
      name: "캐릭터1",
      serverName: "아만",
      className: "브레이커",
      itemLevel: "1,700.00",
      combatPower: "3,000.00"
    }])).rejects.toThrow("Character import batch did not return every character");
  });

  it("rejects duplicate character import RETURNING identities", async () => {
    const env = createBatchResultEnv([
      { results: [] },
      {
        results: [
          { id: "character-1", name: "캐릭터1", server_name: "아만" },
          { id: "character-1", name: "캐릭터1", server_name: "아만" }
        ]
      }
    ]);

    await expect(saveSelectedCharacters(env, "user-1", [
      { name: "캐릭터1", serverName: "아만", className: "브레이커", itemLevel: "1,700.00", combatPower: null },
      { name: "캐릭터2", serverName: "카단", className: "바드", itemLevel: "1,680.00", combatPower: null }
    ])).rejects.toThrow("Character import batch did not return every character");
  });

  it("rejects duplicate character order RETURNING ids", async () => {
    const env = createBatchResultEnv([{ results: [{ id: "character-1" }, { id: "character-1" }] }]);

    await expect(reorderCharacters(env, "user-1", ["character-1", "character-2"]))
      .rejects.toThrow("Character order did not return every character");
  });
});

describe("refreshCharactersFromLostArk", () => {
  beforeEach(() => {
    vi.useRealTimers();
    profileMock().mockReset();
    vi.mocked(LostArkClient.searchRosterCharacters).mockReset();
  });

  it("does no D1 or Lost Ark work for an empty internal set", async () => {
    const database = createCharacterDatabase();
    try {
      const { env, batches, statements } = createSqliteEnv(database);

      await expect(getRefreshCharactersFromLostArk()(env, "user-1", [])).resolves.toEqual({
        results: [],
        versions: { sheets: [] }
      });
      expect(statements).toEqual([]);
      expect(batches).toEqual([]);
      expect(profileMock()).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("rejects a missing API key before any non-empty refresh work", async () => {
    const prepare = vi.fn();
    const env = {
      LOSTARK_API_KEY: "",
      DB: { prepare }
    } as unknown as Env;

    await expect(
      getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
    ).rejects.toMatchObject({
      status: 500,
      code: "lostark_key_missing"
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(profileMock()).not.toHaveBeenCalled();
  });

  it("classifies manual, missing, and cooldown rows without creating attempt or mutation sets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "manual", { source: "manual" });
      insertCharacter(database, "cooldown");
      database.prepare("UPDATE characters SET last_refresh_attempt_at = ? WHERE id = ?")
        .run("2026-06-02T09:59:30.000Z", "cooldown");
      const { env, batches, statements } = createSqliteEnv(database);

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["manual", "missing", "cooldown"])
      ).resolves.toEqual({
        results: [
          { id: "manual", status: "manual" },
          { id: "missing", status: "not_found" },
          { id: "cooldown", status: "rate_limited", retryAfterSeconds: 30 }
        ],
        versions: { sheets: [] }
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("json_each");
      expect(batches).toEqual([]);
      expect(profileMock()).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("skips the mutation batch when no attempted profile succeeds", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "unavailable");
      insertCharacter(database, "failed");
      const { env, batches, statements } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => {
        if (name === "name-unavailable") return null;
        throw new ApiError(503, "lostark_api_error", "upstream unavailable");
      });

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["unavailable", "failed"])
      ).resolves.toEqual({
        results: [
          { id: "unavailable", status: "not_available" },
          { id: "failed", status: "failed", code: "lostark_api_error" }
        ],
        versions: { sheets: [] }
      });
      expect(statements).toHaveLength(2);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("does not mutate characters or versions for null and invalid direct profiles", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "unavailable");
      insertCharacter(database, "invalid");
      insertProjection(database, "unavailable");
      database.prepare(
        "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)"
      ).run("axis-invalid", "user-1", "table-1", "invalid");
      const { env, batches } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => {
        if (name === "name-unavailable") return null;
        throw new ApiError(502, "lostark_profile_invalid", "sensitive upstream profile detail");
      });

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["unavailable", "invalid"])
      ).resolves.toEqual({
        results: [
          { id: "unavailable", status: "not_available" },
          { id: "invalid", status: "failed", code: "lostark_profile_invalid" }
        ],
        versions: { sheets: [] }
      });
      expect(database.prepare(
        "SELECT id, class_name, item_level, combat_power FROM characters ORDER BY id"
      ).all()).toEqual([
        { id: "invalid", class_name: "브레이커", item_level: "1,640.00", combat_power: "2,500.00" },
        { id: "unavailable", class_name: "브레이커", item_level: "1,640.00", combat_power: "2,500.00" }
      ]);
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refreshes 20 characters in order with at most four active profiles and bounded JSON D1 work", async () => {
    const database = createCharacterDatabase();
    try {
      const characterIds = Array.from({ length: 20 }, (_, index) => `character-${index}`);
      for (const id of characterIds) insertCharacter(database, id);
      const { env, batches, statements } = createSqliteEnv(database);
      let active = 0;
      let maxActive = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      profileMock().mockImplementation(async (_env, name) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return refreshedProfile(name.replace("name-", ""));
      });

      const refresh = getRefreshCharactersFromLostArk()(env, "user-1", characterIds);
      await vi.waitFor(() => expect(profileMock()).toHaveBeenCalledTimes(4));
      expect(active).toBe(4);
      release();
      const result = await refresh;

      expect(profileMock()).toHaveBeenCalledTimes(20);
      expect(maxActive).toBe(4);
      expect(vi.mocked(LostArkClient.searchRosterCharacters)).not.toHaveBeenCalled();
      expect(result.results).toEqual(characterIds.map((id) => ({
        id,
        status: "updated",
        character: { id, ...refreshedProfile(id) }
      })));
      expect(result.versions).toEqual({ sheets: [] });
      expect(statements).toHaveLength(5);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(statements.filter((statement) => statement.sql.includes("json_each"))).toHaveLength(5);
      expect(statements.filter((statement) => statement.sql.includes("last_refresh_attempt_at"))).toHaveLength(2);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("atomically grants one cooldown claim to concurrent refresh requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      const { env, batches, statements } = createSqliteEnv(database);
      profileMock().mockResolvedValue(refreshedProfile("character-1"));

      const first = getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"]);
      const second = getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"]);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({
        results: [{
          id: "character-1",
          status: "updated",
          character: { id: "character-1", ...refreshedProfile("character-1") }
        }],
        versions: { sheets: [] }
      });
      expect(secondResult).toEqual({
        results: [{ id: "character-1", status: "rate_limited", retryAfterSeconds: 60 }],
        versions: { sheets: [] }
      });
      expect(profileMock()).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT last_refresh_attempt_at FROM characters WHERE id = ?").get("character-1"))
        .toEqual({ last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" });
      expect(statements).toHaveLength(8);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("re-reads and classifies every cooldown-claim contention result in order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      for (const id of ["manual", "recent", "disabled", "deleted", "conflict"]) insertCharacter(database, id);
      database.exec(`
        CREATE TRIGGER contend_manual_refresh
        BEFORE UPDATE OF last_refresh_attempt_at ON characters
        WHEN OLD.id = 'manual'
        BEGIN
          UPDATE characters SET source = 'manual' WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END;
        CREATE TRIGGER contend_recent_refresh
        BEFORE UPDATE OF last_refresh_attempt_at ON characters
        WHEN OLD.id = 'recent'
        BEGIN
          UPDATE characters SET last_refresh_attempt_at = '2026-06-02T10:00:00.000Z' WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END;
        CREATE TRIGGER contend_disabled_refresh
        BEFORE UPDATE OF last_refresh_attempt_at ON characters
        WHEN OLD.id = 'disabled'
        BEGIN
          UPDATE characters SET enabled = 0 WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END;
        CREATE TRIGGER contend_deleted_refresh
        BEFORE UPDATE OF last_refresh_attempt_at ON characters
        WHEN OLD.id = 'deleted'
        BEGIN
          DELETE FROM characters WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END;
        CREATE TRIGGER contend_eligible_refresh
        BEFORE UPDATE OF last_refresh_attempt_at ON characters
        WHEN OLD.id = 'conflict'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const { env, batches, statements } = createSqliteEnv(database);

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["manual", "recent", "disabled", "deleted", "conflict"])
      ).resolves.toEqual({
        results: [
          { id: "manual", status: "manual" },
          { id: "recent", status: "rate_limited", retryAfterSeconds: 60 },
          { id: "disabled", status: "not_found" },
          { id: "deleted", status: "not_found" },
          { id: "conflict", status: "failed", code: "character_refresh_conflict" }
        ],
        versions: { sheets: [] }
      });
      expect(profileMock()).not.toHaveBeenCalled();
      expect(statements).toHaveLength(3);
      expect(statements.every((statement) => statement.sql.includes("json_each"))).toBe(true);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("treats SQLite timestamps consistently and malformed cooldown timestamps as eligible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      for (const id of ["recent", "stale", "malformed"]) insertCharacter(database, id);
      database.prepare("UPDATE characters SET last_refresh_attempt_at = ? WHERE id = ?")
        .run("2026-06-02 09:59:30", "recent");
      database.prepare("UPDATE characters SET last_refresh_attempt_at = ? WHERE id = ?")
        .run("2026-06-02 09:58:59", "stale");
      database.prepare("UPDATE characters SET last_refresh_attempt_at = ? WHERE id = ?")
        .run("not-a-timestamp", "malformed");
      const { env } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => refreshedProfile(name.replace("name-", "")));

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["recent", "stale", "malformed"])
      ).resolves.toMatchObject({
        results: [
          { id: "recent", status: "rate_limited", retryAfterSeconds: 30 },
          { id: "stale", status: "updated" },
          { id: "malformed", status: "updated" }
        ]
      });
      expect(profileMock()).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("returns ordered mixed partial results and retains cooldown stamps for every upstream attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      for (const id of ["updated", "manual", "cooldown", "unavailable", "failed", "rate-seconds", "rate-date"]) {
        insertCharacter(database, id, { source: id === "manual" ? "manual" : "lostark" });
      }
      database.prepare("UPDATE characters SET last_refresh_attempt_at = ? WHERE id = ?")
        .run("2026-06-02T09:59:30.000Z", "cooldown");
      const { env } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => {
        const id = name.replace("name-", "");
        if (id === "unavailable") return null;
        if (id === "failed") throw new ApiError(503, "lostark_api_error", "upstream detail must not leak");
        if (id === "rate-seconds") {
          throw new ApiError(429, "lostark_api_error", "slow down", {
            headers: { "Retry-After": "17" }
          });
        }
        if (id === "rate-date") {
          throw new ApiError(429, "lostark_api_error", "slow down", {
            headers: { "Retry-After": "Tue, 02 Jun 2026 10:00:45 GMT" }
          });
        }
        return refreshedProfile(id);
      });
      const ids = [
        "updated",
        "manual",
        "missing",
        "cooldown",
        "unavailable",
        "failed",
        "rate-seconds",
        "rate-date"
      ];

      await expect(getRefreshCharactersFromLostArk()(env, "user-1", ids)).resolves.toEqual({
        results: [
          { id: "updated", status: "updated", character: { id: "updated", ...refreshedProfile("updated") } },
          { id: "manual", status: "manual" },
          { id: "missing", status: "not_found" },
          { id: "cooldown", status: "rate_limited", retryAfterSeconds: 30 },
          { id: "unavailable", status: "not_available" },
          { id: "failed", status: "failed", code: "lostark_api_error" },
          { id: "rate-seconds", status: "rate_limited", retryAfterSeconds: 17 },
          { id: "rate-date", status: "rate_limited", retryAfterSeconds: 45 }
        ],
        versions: { sheets: [] }
      });
      expect(profileMock()).toHaveBeenCalledTimes(5);
      expect(database.prepare(
        `SELECT id, last_refresh_attempt_at FROM characters
         WHERE id IN ('updated', 'unavailable', 'failed', 'rate-seconds', 'rate-date')
         ORDER BY id`
      ).all()).toEqual([
        { id: "failed", last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" },
        { id: "rate-date", last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" },
        { id: "rate-seconds", last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" },
        { id: "unavailable", last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" },
        { id: "updated", last_refresh_attempt_at: "2026-06-02T10:00:00.000Z" }
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["name", { name: "다른캐릭터" }],
    ["server", { serverName: "카단" }]
  ])("rejects a direct profile with a mismatched stored %s", async (_field, identityPatch) => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env, batches } = createSqliteEnv(database);
      profileMock().mockResolvedValue({ ...refreshedProfile("character-1"), ...identityPatch });

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
      ).resolves.toEqual({
        results: [{
          id: "character-1",
          status: "failed",
          code: "lostark_profile_identity_mismatch"
        }],
        versions: { sheets: [] }
      });
      expect(database.prepare(
        "SELECT name, server_name, class_name, item_level, combat_power FROM characters WHERE id = ?"
      ).get("character-1")).toEqual({
        name: "name-character-1",
        server_name: "아만",
        class_name: "브레이커",
        item_level: "1,640.00",
        combat_power: "2,500.00"
      });
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
      expect(batches).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["zero seconds", "0"],
    ["past HTTP date", "Tue, 02 Jun 2026 09:59:59 GMT"]
  ])("clamps an upstream Retry-After %s to one second", async (_description, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      const { env } = createSqliteEnv(database);
      profileMock().mockRejectedValue(new ApiError(429, "lostark_api_error", "slow down", {
        headers: { "Retry-After": retryAfter }
      }));

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
      ).resolves.toEqual({
        results: [{ id: "character-1", status: "rate_limited", retryAfterSeconds: 1 }],
        versions: { sheets: [] }
      });
    } finally {
      database.close();
    }
  });

  it("bumps hidden and shared referencing sheets once and leaves unchanged or unreferenced sheets alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T10:00:00.000Z"));
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertCharacter(database, "character-2");
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?), (?, ?)")
        .run("sheet-shared", "user-1", "sheet-hidden", "user-1", "sheet-unreferenced", "user-1");
      database.prepare(
        "INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)"
      ).run(
        "table-1", "user-1", "sheet-shared",
        "table-2", "user-1", "sheet-shared",
        "table-3", "user-1", "sheet-hidden"
      );
      database.prepare(
        `INSERT INTO board_axis_items (id, user_id, table_id, character_id, visible)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
      ).run(
        "axis-1", "user-1", "table-1", "character-1", 1,
        "axis-2", "user-1", "table-2", "character-2", 0,
        "axis-3", "user-1", "table-3", "character-2", 0
      );
      const { env, batches } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => refreshedProfile(name.replace("name-", "")));

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1", "character-2"])
      ).resolves.toMatchObject({
        versions: {
          sheets: [
            { id: "sheet-hidden", version: 1 },
            { id: "sheet-shared", version: 1 }
          ]
        }
      });
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "sheet-hidden", content_version: 1 },
        { id: "sheet-shared", content_version: 1 },
        { id: "sheet-unreferenced", content_version: 0 }
      ]);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);

      vi.setSystemTime(new Date("2026-06-02T10:01:01.000Z"));
      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1", "character-2"])
      ).resolves.toMatchObject({ versions: { sheets: [] } });
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "sheet-hidden", content_version: 1 },
        { id: "sheet-shared", content_version: 1 },
        { id: "sheet-unreferenced", content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back every profile and sheet version when one successful character update is suppressed", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertCharacter(database, "character-2");
      insertProjection(database, "character-1");
      database.prepare(
        "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)"
      ).run("axis-character-2", "user-1", "table-1", "character-2");
      database.exec(`
        CREATE TRIGGER suppress_second_character_refresh
        BEFORE UPDATE OF class_name, item_level, combat_power ON characters
        WHEN OLD.id = 'character-2' AND NEW.class_name = '환수사'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      const { env, batches } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => refreshedProfile(name.replace("name-", "")));

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1", "character-2"])
      ).resolves.toEqual({
        results: [
          { id: "character-1", status: "failed", code: "character_refresh_conflict" },
          { id: "character-2", status: "failed", code: "character_refresh_conflict" }
        ],
        versions: { sheets: [] }
      });
      expect(database.prepare(
        "SELECT id, class_name, item_level, combat_power FROM characters ORDER BY id"
      ).all()).toEqual([
        { id: "character-1", class_name: "브레이커", item_level: "1,640.00", combat_power: "2,500.00" },
        { id: "character-2", class_name: "브레이커", item_level: "1,640.00", combat_power: "2,500.00" }
      ]);
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "sheet-1", content_version: 0 },
        { id: "sheet-2", content_version: 0 }
      ]);
      expect(batches).toHaveLength(2);
      expect(batches.every((batch) => batch.length === 3)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("does not swallow an unrelated character-update trigger error", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      database.exec(`
        CREATE TRIGGER reject_character_refresh
        BEFORE UPDATE OF class_name ON characters
        WHEN OLD.id = 'character-1' AND NEW.class_name = '환수사'
        BEGIN
          SELECT RAISE(ABORT, 'unexpected character refresh trigger');
        END;
      `);
      const { env } = createSqliteEnv(database);
      profileMock().mockResolvedValue(refreshedProfile("character-1"));

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
      ).rejects.toThrow("unexpected character refresh trigger");
      expect(database.prepare("SELECT class_name FROM characters WHERE id = ?").get("character-1"))
        .toEqual({ class_name: "브레이커" });
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("does not report an update or bump a sheet when the character disappears during the profile call", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      const { env } = createSqliteEnv(database);
      profileMock().mockImplementation(async () => {
        database.prepare("UPDATE characters SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run("character-1");
        return refreshedProfile("character-1");
      });

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
      ).resolves.toEqual({
        results: [{ id: "character-1", status: "not_found" }],
        versions: { sheets: [] }
      });
      expect(database.prepare("SELECT content_version FROM sheets ORDER BY id").all()).toEqual([
        { content_version: 0 },
        { content_version: 0 }
      ]);
    } finally {
      database.close();
    }
  });

  it("retries only profiles that remain eligible after one character disappears", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertCharacter(database, "character-2");
      insertProjection(database, "character-1");
      database.prepare(
        "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)"
      ).run("axis-character-2", "user-1", "table-1", "character-2");
      const { env, batches, statements } = createSqliteEnv(database);
      profileMock().mockImplementation(async (_env, name) => {
        const id = name.replace("name-", "");
        if (id === "character-1") {
          database.prepare("UPDATE characters SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(id);
        }
        return refreshedProfile(id);
      });

      await expect(
        getRefreshCharactersFromLostArk()(env, "user-1", ["character-1", "character-2"])
      ).resolves.toEqual({
        results: [
          { id: "character-1", status: "not_found" },
          {
            id: "character-2",
            status: "updated",
            character: { id: "character-2", ...refreshedProfile("character-2") }
          }
        ],
        versions: { sheets: [{ id: "sheet-1", version: 1 }] }
      });
      expect(database.prepare("SELECT id, class_name FROM characters ORDER BY id").all()).toEqual([
        { id: "character-1", class_name: "브레이커" },
        { id: "character-2", class_name: "환수사" }
      ]);
      expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
        { id: "sheet-1", content_version: 1 },
        { id: "sheet-2", content_version: 0 }
      ]);
      expect(statements).toHaveLength(9);
      expect(statements.every((statement) => statement.values.length < 100)).toBe(true);
      expect(batches).toHaveLength(2);
      expect(batches.every((batch) => batch.length === 3)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate character ids returned by the JSON update", async () => {
    const env = createScriptedRefreshEnv([
      { results: [] },
      { results: [{ id: "character-1" }, { id: "character-1" }] }
    ]);
    profileMock().mockResolvedValue(refreshedProfile("character-1"));

    await expect(
      getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
    ).rejects.toThrow("Character refresh batch returned invalid character ids");
  });

  it("rejects duplicate sheet versions returned by the JSON update batch", async () => {
    const env = createScriptedRefreshEnv([
      { results: [{ id: "sheet-1", version: 4 }, { id: "sheet-1", version: 4 }] },
      { results: [{ id: "character-1" }] }
    ]);
    profileMock().mockResolvedValue(refreshedProfile("character-1"));

    await expect(
      getRefreshCharactersFromLostArk()(env, "user-1", ["character-1"])
    ).rejects.toThrow("Character refresh batch returned invalid sheet versions");
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

  it("bumps every hidden projection sheet when character details change", async () => {
    const database = createCharacterDatabase();
    try {
      insertCharacter(database, "character-1");
      insertProjection(database, "character-1");
      hideProjection(database, "character-1");
      const { env } = createSqliteEnv(database);

      await expect(
        updateCharacterDetails(env, "user-1", "character-1", {
          displayName: "서포터",
          itemLevel: "1,650.00",
          combatPower: "2,700.00"
        })
      ).resolves.toEqual({
        ok: true,
        versions: {
          sheets: [
            { id: "sheet-1", version: 1 },
            { id: "sheet-2", version: 1 }
          ]
        }
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
      hideProjection(database, "character-1");
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

describe("character mutation batch result validation", () => {
  it.each([
    { shape: "missing", versionResults: [] },
    {
      shape: "malformed",
      versionResults: [{ results: [{ id: "sheet-1", version: "4" }] }]
    }
  ])("rejects a $shape sheet-version result", async ({ versionResults }) => {
    const env = createBatchResultEnv([
      { results: [{ id: "character-1" }] },
      ...versionResults
    ]);

    await expect(updateCharacterDisplayName(env, "user-1", "character-1", "레이드")).rejects.toThrow(
      "Character mutation batch returned malformed version rows"
    );
  });

  it("rejects version rows without a matching mutation RETURNING row", async () => {
    const env = createBatchResultEnv([
      { results: [] },
      { results: [{ id: "sheet-1", version: 4 }] }
    ]);

    await expect(updateCharacterDisplayName(env, "user-1", "character-1", "레이드")).rejects.toThrow(
      "Character mutation batch returned versions without a character mutation"
    );
  });

  it("does not report success for a mismatched mutation RETURNING identity", async () => {
    const env = createBatchResultEnv([
      { results: [{ id: "character-2" }] },
      { results: [] }
    ]);

    await expect(updateCharacterDisplayName(env, "user-1", "character-1", "레이드")).resolves.toBeNull();
  });
});
