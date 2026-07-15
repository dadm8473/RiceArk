import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildBoardMutationVersions,
  bumpBoardManifestVersionForDeletableSheetStatement,
  bumpBoardManifestVersionForOwnedSheetStatement,
  bumpBoardManifestVersionStatement,
  bumpBoardSheetVersionForNoteStatement,
  bumpBoardSheetVersionStatement,
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
      sheet_id TEXT NOT NULL
    );
    CREATE TABLE board_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE board_axis_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      character_id TEXT
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

  it("updates each owned sheet for table targets once with one JSON binding", () => {
    const { env, statements } = createEnv();
    const tableIds = Array.from({ length: 200 }, (_, index) => `table-${index % 100}`);

    bumpBoardSheetVersionsForTablesStatement(env, "user-1", tableIds);

    expect(statements[0]).toMatchObject({
      values: ["user-1", "user-1", JSON.stringify(Array.from({ length: 100 }, (_, index) => `table-${index}`))]
    });
    expect(statements[0]?.values).toHaveLength(3);
    expect(statements[0]?.sql).toContain("SELECT DISTINCT sheet_id");
    expect(statements[0]?.sql).toContain("json_each(?)");
    expect(statements[0]?.sql).toContain("WHERE user_id = ?");
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(2);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("returns the owned note sheet version with ownership in the outer query and subquery", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionForNoteStatement(env, "user-1", "note-1");

    expect(statements[0]).toMatchObject({ values: ["user-1", "note-1", "user-1"] });
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(2);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
  });

  it("finds distinct owned sheets through character axis items and returns their versions", () => {
    const { env, statements } = createEnv();

    bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-1");

    expect(statements[0]).toMatchObject({ values: ["user-1", "user-1", "user-1", "character-1"] });
    expect(statements[0]?.sql).toContain("JOIN board_axis_items");
    expect(statements[0]?.sql).toContain("JOIN characters");
    expect(statements[0]?.sql).toContain("board_axis_items.character_id = ?");
    expect(statements[0]?.sql).toContain("SELECT DISTINCT board_tables.sheet_id");
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(3);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
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

    it("updates only one owned sheet for duplicate, foreign, unknown, and empty table targets", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-2", "user-2");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-1", "user-1", "sheet-1");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-2", "user-2", "sheet-2");
        const targets = captureStatement((env) =>
          bumpBoardSheetVersionsForTablesStatement(env, "user-1", ["table-1", "table-1", "table-2", "missing"])
        );
        const emptyTargets = captureStatement((env) => bumpBoardSheetVersionsForTablesStatement(env, "user-1", []));

        expect(executeStatement(database, targets)).toEqual([{ id: "sheet-1", version: 1 }]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-2")).toEqual({ content_version: 0 });
        expect(executeStatement(database, emptyTargets)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1")).toEqual({ content_version: 1 });
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

    it("updates a sheet for an owned character reference but not a malformed foreign reference", () => {
      withVersionDatabase((database) => {
        database.prepare("INSERT INTO sheets (id, user_id) VALUES (?, ?)").run("sheet-1", "user-1");
        database.prepare("INSERT INTO board_tables (id, user_id, sheet_id) VALUES (?, ?, ?)").run("table-1", "user-1", "sheet-1");
        database.prepare("INSERT INTO characters (id, user_id) VALUES (?, ?)").run("character-1", "user-1");
        database.prepare("INSERT INTO characters (id, user_id) VALUES (?, ?)").run("character-2", "user-2");
        database.prepare("INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)")
          .run("axis-1", "user-1", "table-1", "character-1");
        database.prepare("INSERT INTO board_axis_items (id, user_id, table_id, character_id) VALUES (?, ?, ?, ?)")
          .run("axis-2", "user-1", "table-1", "character-2");
        const ownedCharacter = captureStatement((env) => bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-1"));
        const foreignCharacter = captureStatement((env) => bumpBoardSheetVersionsForCharacterStatement(env, "user-1", "character-2"));

        expect(executeStatement(database, ownedCharacter)).toEqual([{ id: "sheet-1", version: 1 }]);
        expect(executeStatement(database, foreignCharacter)).toEqual([]);
        expect(database.prepare("SELECT content_version FROM sheets WHERE id = ?").get("sheet-1")).toEqual({ content_version: 1 });
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
