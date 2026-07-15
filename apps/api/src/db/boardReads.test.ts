import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BoardBootstrapPayload,
  BoardSheetManifest,
  BoardSheetManifestItem,
  BoardSheetPayload,
  BoardSheetPayloadItem,
  BoardVersionSummary
} from "./boardReads";
import type { BoardVersionSummary as BoardModuleVersionSummary } from "./board";

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
