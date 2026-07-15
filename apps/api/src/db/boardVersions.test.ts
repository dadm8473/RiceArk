import { describe, expect, it } from "vitest";
import {
  buildBoardMutationVersions,
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
    expect(statements[0]?.sql).toContain("board_axis_items.character_id = ?");
    expect(statements[0]?.sql).toContain("SELECT DISTINCT board_tables.sheet_id");
    expect(statements[0]?.sql.match(/user_id = \?/g)).toHaveLength(3);
    expect(statements[0]?.sql).toContain("RETURNING id, content_version AS version");
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
