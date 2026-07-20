import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildBoardMutationVersions,
  bumpBoardManifestVersionForDeletableSheetStatement,
  bumpBoardManifestVersionForOwnedSheetStatement,
  bumpBoardManifestVersionStatement,
  bumpBoardSheetVersionForNoteStatement,
  bumpBoardSheetVersionForAxisItemStatement,
  bumpBoardSheetVersionForTableAtExpectedLockStatement,
  bumpBoardSheetVersionStatement,
  bumpBoardSheetVersionsForCharacterImportStatement,
  bumpBoardSheetVersionsForCharacterStatement,
  bumpBoardSheetVersionsForTablesStatement
} from "./boardVersions";

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function createEnv(): { env: Parameters<typeof bumpBoardManifestVersionStatement>[0]; statements: CapturedStatement[] } {
  const statements: CapturedStatement[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const statement: CapturedStatement = { sql, values: [] };
        statements.push(statement);
        return {
          bind(...values: unknown[]) {
            statement.values = values;
            return this;
          }
        };
      }
    }
  } as Parameters<typeof bumpBoardManifestVersionStatement>[0];

  return { env, statements };
}

function createVersionDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE board_manifest_versions (
      user_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
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
      sheet_id TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE board_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      server_name TEXT NOT NULL DEFAULT '',
      class_name TEXT NOT NULL DEFAULT '',
      item_level TEXT NOT NULL DEFAULT '',
      combat_power TEXT,
      item_level_pinned INTEGER NOT NULL DEFAULT 0 CHECK (item_level_pinned IN (0, 1)),
      combat_power_pinned INTEGER NOT NULL DEFAULT 0 CHECK (combat_power_pinned IN (0, 1)),
      source TEXT NOT NULL DEFAULT 'lostark',
      enabled INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
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

function executeStatement(database: DatabaseSync, statement: CapturedStatement): Record<string, unknown>[] {
  return database.prepare(statement.sql).all(...(statement.values as string[]));
}

function captureStatement(
  build: (env: Parameters<typeof bumpBoardManifestVersionStatement>[0]) => void
): CapturedStatement {
  const { env, statements } = createEnv();
  build(env);
  return statements[0]!;
}

function withVersionDatabase(test: (database: DatabaseSync) => void): void {
  const database = createVersionDatabase();
  try {
    test(database);
  } finally {
    database.close();
  }
}

describe("board mutation versions", () => {
  it("returns the bumped manifest version", () => {
    const { env, statements } = createEnv();

    bumpBoardManifestVersionStatement(env, "user-1");

    expect(statements).toEqual([
      expect.objectContaining({
        values: ["user-1"],
        sql: expect.stringContaining("RETURNING user_id, version")
      })
    ]);
    expect(statements[0]?.sql).toContain("board_manifest_versions.version + 1");
  });

  it("conditionally bumps the manifest only while the owned sheet exists", () => {
    withVersionDatabase((database) => {
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
      const owned = captureStatement((env) => bumpBoardManifestVersionForOwnedSheetStatement(env, "user-1", "sheet-1"));
      const foreign = captureStatement((env) => bumpBoardManifestVersionForOwnedSheetStatement(env, "user-2", "sheet-1"));

      expect(owned.values).toEqual(["user-1", "sheet-1", "user-1"]);
      expect(owned.sql).toContain("WHERE EXISTS");
      expect(owned.sql).toContain("SELECT 1 FROM sheets WHERE id = ? AND user_id = ?");
      expect(executeStatement(database, owned)).toEqual([{ user_id: "user-1", version: 1 }]);
      expect(executeStatement(database, foreign)).toEqual([]);
      expect(database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")).toEqual({
        version: 1
      });
      expect(database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-2")).toBeUndefined();
    });
  });

  it("conditionally bumps the manifest only while the owned sheet is deletable", () => {
    withVersionDatabase((database) => {
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?)")
        .run("sheet-1", "user-1", "sheet-2", "user-1");
      const statement = captureStatement((env) =>
        bumpBoardManifestVersionForDeletableSheetStatement(env, "user-1", "sheet-1")
      );

      expect(statement.values).toEqual(["user-1", "sheet-1", "user-1", "user-1"]);
      expect(statement.sql).toContain("other.user_id = ?");
      expect(statement.sql).toContain("other.id <> target.id");
      expect(executeStatement(database, statement)).toEqual([{ user_id: "user-1", version: 1 }]);

      database.prepare("DELETE FROM sheets WHERE id = ?").run("sheet-2");
      expect(executeStatement(database, statement)).toEqual([]);
      expect(database.prepare("SELECT version FROM board_manifest_versions WHERE user_id = ?").get("user-1")).toEqual({ version: 1 });
    });
  });

  it("returns an owned bumped sheet version", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionStatement(env, "user-1", "sheet-1");

    expect(statements[0]).toMatchObject({ values: ["sheet-1", "user-1"] });
    expect(statements[0]?.sql).toContain("WHERE id = ? AND user_id = ?");
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("updates each sheet once only when every table target is owned and unlocked", () => {
    const { env, statements } = createEnv();
    const tableIds = Array.from({ length: 200 }, (_, index) => `table-${index % 100}`);

    bumpBoardSheetVersionsForTablesStatement(env, "user-1", tableIds);

    expect(statements[0]).toMatchObject({
      values: ["user-1", "user-1", JSON.stringify(Array.from({ length: 100 }, (_, index) => `table-${index}`))]
    });
    expect(statements[0]?.values).toHaveLength(3);
    expect(statements[0]?.sql).toContain("SELECT DISTINCT sheet_id");
    expect(statements[0]?.sql).toContain("json_each(?3)");
    expect(statements[0]?.sql).toContain("NOT EXISTS");
    expect(statements[0]?.sql).toContain("locked = 0");
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("matches a single table's expected lock state for settings writes", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionForTableAtExpectedLockStatement(env, "user-1", "table-1", 1);

    expect(statements[0]).toMatchObject({ values: ["user-1", "table-1", 1] });
    expect(statements[0]?.sql).toContain("board_tables.locked = ?");
    expect(statements[0]?.sql).toContain("board_tables.user_id = sheets.user_id");
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("returns the owned note sheet version with ownership in the outer query and subquery", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionForNoteStatement(env, "user-1", "note-1");

    expect(statements[0]).toMatchObject({ values: ["user-1", "note-1", "user-1"] });
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(2);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("finds an owned sheet through an axis item with full ownership guards", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionForAxisItemStatement(env, "user-1", "axis-1");

    expect(statements[0]).toMatchObject({ values: ["user-1", "axis-1", "user-1", "user-1"] });
    expect(statements[0]?.sql).toContain("JOIN board_tables");
    expect(statements[0]?.sql).toContain("board_axis_items.table_id = board_tables.id");
    expect(statements[0]?.sql).toContain("board_axis_items.user_id = board_tables.user_id");
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(3);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("finds distinct owned sheets through active character axis items including hidden references", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-1");

    expect(statements[0]).toMatchObject({ values: ["user-1", "user-1", "user-1", "character-1"] });
    expect(statements[0]?.sql).toContain("JOIN board_axis_items");
    expect(statements[0]?.sql).toContain("JOIN characters");
    expect(statements[0]?.sql).toContain("board_axis_items.character_id = ?");
    expect(statements[0]?.sql).not.toContain("board_axis_items.visible = 1");
    expect(statements[0]?.sql).toContain("characters.enabled = 1");
    expect(statements[0]?.sql).toContain("characters.deleted_at IS NULL");
    expect(statements[0]?.sql).toContain("SELECT DISTINCT board_tables.sheet_id");
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(3);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("bumps each sheet once for changed imported profiles plus the target table sheet", () => {
    const database = createVersionDatabase();
    try {
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?)")
        .run("sheet-1", "user-1", "sheet-2", "user-1");
      database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?), (?, ?, ?)")
        .run("table-target", "user-1", "sheet-1", "table-shared", "user-1", "sheet-2");
      database.prepare(
        `INSERT INTO characters (
           id, user_id, name, server_name, class_name, item_level, combat_power, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("character-1", "user-1", "공유캐릭터", "아만", "브레이커", "1,640.00", "2,500.00", "lostark");
      database.prepare(
        "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)"
      ).run(
        "axis-target", "user-1", "table-target", "character-1",
        "axis-shared", "user-1", "table-shared", "character-1"
      );
      const { env, statements } = createEnv();

      bumpBoardSheetVersionsForCharacterImportStatement(env, "user-1", [{
        name: "공유캐릭터",
        serverName: "아만",
        className: "환수사",
        itemLevel: "1,700.00",
        combatPower: "3,000.00"
      }], { targetTableId: "table-target", targetAxis: "column" });

      expect(statements).toHaveLength(1);
      expect(statements[0]?.values.length).toBeLessThan(100);
      expect(statements[0]?.sql).toContain("json_each");
      expect(executeStatement(database, statements[0]!)).toEqual([
        { id: "sheet-1", version: 1 },
        { id: "sheet-2", version: 1 }
      ]);
    } finally {
      database.close();
    }
  });

  it("does not bump referenced sheets for ignored pinned import values", () => {
    const database = createVersionDatabase();
    try {
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
      database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)")
        .run("table-1", "user-1", "sheet-1");
      database.prepare(
        `INSERT INTO characters (
           id, user_id, name, server_name, class_name, item_level, combat_power,
           item_level_pinned, combat_power_pinned, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`
      ).run("character-1", "user-1", "공유캐릭터", "아만", "브레이커", "1,640.00", "2,500.00", "lostark");
      database.prepare(
        "INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)"
      ).run("axis-1", "user-1", "table-1", "character-1");
      const { env, statements } = createEnv();

      bumpBoardSheetVersionsForCharacterImportStatement(env, "user-1", [{
        name: "공유캐릭터",
        serverName: "아만",
        className: "브레이커",
        itemLevel: "1,700.00",
        combatPower: "3,000.00"
      }]);

      expect(executeStatement(database, statements[0]!)).toEqual([]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1"))
        .toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  it("does not bump a sheet for an axis item that references a foreign character", () => {
    const database = createVersionDatabase();
    try {
      database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
      database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-1", "user-1", "sheet-1");
      database.prepare("INSERT INTO characters (id, user_id) VALUES (?, ?)").run("character-2", "user-2");
      database.prepare("INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)")
        .run("axis-1", "user-1", "table-1", "character-2");
      const { env, statements } = createEnv();

      bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-2");

      expect(executeStatement(database, statements[0]!)).toEqual([]);
      expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1")).toEqual({ content_version: 0 });
    } finally {
      database.close();
    }
  });

  describe("executed statements", () => {
    it("returns manifest versions 1 then 2 from the manifest UPSERT", () => {
      withVersionDatabase((database) => {
        const statement = captureStatement((env) => bumpBoardManifestVersionStatement(env, "user-1"));

        expect(executeStatement(database, statement)).toEqual([{ user_id: "user-1", version: 1 }]);
        expect(executeStatement(database, statement)).toEqual([{ user_id: "user-1", version: 2 }]);
      });
    });

    it("returns the incremented version for an owned sheet", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        const statement = captureStatement((env) => bumpBoardSheetVersionStatement(env, "user-1", "sheet-1"));

        expect(executeStatement(database, statement)).toEqual([{ id: "sheet-1", version: 1 }]);
      });
    });

    it("rejects every sheet bump when any table target is foreign, unknown, or locked", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-2", "user-2");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-1", "user-1", "sheet-1");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-2", "user-2", "sheet-2");
        const invalidTargets = captureStatement((env) =>
          bumpBoardSheetVersionsForTablesStatement(env, "user-1", ["table-1", "table-1", "table-2", "missing"])
        );
        const validTargets = captureStatement((env) =>
          bumpBoardSheetVersionsForTablesStatement(env, "user-1", ["table-1", "table-1"])
        );
        const emptyTargets = captureStatement((env) => bumpBoardSheetVersionsForTablesStatement(env, "user-1", []));

        expect(executeStatement(database, invalidTargets)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1")).toEqual({ content_version: 0 });
        expect(executeStatement(database, validTargets)).toEqual([{ id: "sheet-1", version: 1 }]);
        database.prepare("UPDATE board_tables SET locked = 1 WHERE id = ?").run("table-1");
        expect(executeStatement(database, validTargets)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-2")).toEqual({ content_version: 0 });
        expect(executeStatement(database, emptyTargets)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1")).toEqual({ content_version: 1 });
      });
    });

    it("bumps settings versions only at the expected current lock state", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id, locked) VALUES (?, ?, ?, 1)")
          .run("table-1", "user-1", "sheet-1");
        const expectLocked = captureStatement((env) =>
          bumpBoardSheetVersionForTableAtExpectedLockStatement(env, "user-1", "table-1", 1)
        );
        const expectUnlocked = captureStatement((env) =>
          bumpBoardSheetVersionForTableAtExpectedLockStatement(env, "user-1", "table-1", 0)
        );

        expect(executeStatement(database, expectUnlocked)).toEqual([]);
        expect(executeStatement(database, expectLocked)).toEqual([{ id: "sheet-1", version: 1 }]);
      });
    });

    it("updates an owned note sheet but not a foreign note sheet", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-2", "user-2");
        database.prepare("INSERT INTO board_notes (id, user_id, sheet_id) VALUES (?, ?, ?)").run("note-1", "user-1", "sheet-1");
        database.prepare("INSERT INTO board_notes (id, user_id, sheet_id) VALUES (?, ?, ?)").run("note-2", "user-2", "sheet-2");
        const ownedNote = captureStatement((env) => bumpBoardSheetVersionForNoteStatement(env, "user-1", "note-1"));
        const foreignNote = captureStatement((env) => bumpBoardSheetVersionForNoteStatement(env, "user-1", "note-2"));

        expect(executeStatement(database, ownedNote)).toEqual([{ id: "sheet-1", version: 1 }]);
        expect(executeStatement(database, foreignNote)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-2")).toEqual({ content_version: 0 });
      });
    });

    it("updates the owning sheet for an axis item without crossing user ownership", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?)")
          .run("sheet-1", "user-1", "sheet-2", "user-2");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?), (?, ?, ?)")
          .run("table-1", "user-1", "sheet-1", "table-2", "user-2", "sheet-2");
        database.prepare("INSERT INTO board_axis_items (id, user_id, table_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)")
          .run(
            "axis-1", "user-1", "table-1",
            "axis-2", "user-2", "table-2",
            "axis-malformed", "user-1", "table-2"
          );
        const ownedAxis = captureStatement((env) => bumpBoardSheetVersionForAxisItemStatement(env, "user-1", "axis-1"));
        const foreignAxis = captureStatement((env) => bumpBoardSheetVersionForAxisItemStatement(env, "user-1", "axis-2"));
        const malformedAxis = captureStatement((env) =>
          bumpBoardSheetVersionForAxisItemStatement(env, "user-1", "axis-malformed")
        );

        expect(executeStatement(database, ownedAxis)).toEqual([{ id: "sheet-1", version: 1 }]);
        expect(executeStatement(database, foreignAxis)).toEqual([]);
        expect(executeStatement(database, malformedAxis)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-2")).toEqual({ content_version: 0 });
      });
    });

    it("increments each distinct sheet once for every owned reference including hidden items", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?)")
          .run(
            "sheet-1", "user-1",
            "sheet-2", "user-1",
            "sheet-hidden", "user-1",
            "sheet-foreign", "user-2"
          );
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)")
          .run(
            "table-1", "user-1", "sheet-1",
            "table-1-duplicate", "user-1", "sheet-1",
            "table-2", "user-1", "sheet-2",
            "table-hidden", "user-1", "sheet-hidden",
            "table-foreign", "user-2", "sheet-foreign"
          );
        database.prepare("INSERT INTO characters (id, user_id) VALUES (?, ?), (?, ?), (?, ?), (?, ?)")
          .run(
            "character-1", "user-1",
            "character-no-board", "user-1",
            "character-deleted", "user-1",
            "character-foreign", "user-2"
          );
        database.prepare("UPDATE characters SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run("character-deleted");
        database.prepare(
          "INSERT INTO board_axis_items (id, user_id, table_id, character_id, visible) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)"
        ).run(
          "axis-1", "user-1", "table-1", "character-1", 1,
          "axis-1-duplicate", "user-1", "table-1", "character-1", 1,
          "axis-1-other-table", "user-1", "table-1-duplicate", "character-1", 1,
          "axis-2", "user-1", "table-2", "character-1", 1,
          "axis-hidden", "user-1", "table-hidden", "character-1", 0,
          "axis-foreign-character", "user-1", "table-1", "character-foreign", 1,
          "axis-malformed-table", "user-1", "table-foreign", "character-1", 1,
          "axis-deleted-character", "user-1", "table-1", "character-deleted", 1
        );

        const active = captureStatement((env) => bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-1"));
        const noBoard = captureStatement((env) =>
          bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-no-board")
        );
        const deleted = captureStatement((env) =>
          bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-deleted")
        );
        const foreign = captureStatement((env) =>
          bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-foreign")
        );
        const missing = captureStatement((env) =>
          bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-missing")
        );

        expect(executeStatement(database, active)).toEqual([
          { id: "sheet-1", version: 1 },
          { id: "sheet-2", version: 1 },
          { id: "sheet-hidden", version: 1 }
        ]);
        expect(executeStatement(database, noBoard)).toEqual([]);
        expect(executeStatement(database, deleted)).toEqual([]);
        expect(executeStatement(database, foreign)).toEqual([]);
        expect(executeStatement(database, missing)).toEqual([]);
        expect(database.prepare("SELECT id, content_version FROM sheets ORDER BY id").all()).toEqual([
          { id: "sheet-1", content_version: 1 },
          { id: "sheet-2", content_version: 1 },
          { id: "sheet-foreign", content_version: 0 },
          { id: "sheet-hidden", content_version: 1 }
        ]);
      });
    });
  });

  it("builds sorted deduplicated mutation versions and omits an undefined manifest version", () => {
    expect(
      buildBoardMutationVersions([
        { id: "sheet-b", version: 2 },
        { id: "sheet-a", version: 3 },
        { id: "sheet-b", version: 4 }
      ])
    ).toEqual({
      sheets: [
        { id: "sheet-a", version: 3 },
        { id: "sheet-b", version: 4 }
      ]
    });

    expect(buildBoardMutationVersions([{ id: "sheet-a", version: 3 }], 8)).toEqual({
      sheets: [{ id: "sheet-a", version: 3 }],
      manifestVersion: 8
    });
  });
});
