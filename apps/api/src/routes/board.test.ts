import { describe, expect, it } from "vitest";
import app from "../index";
import {
  boardAxisItemIdParamSchema,
  boardAxisOrderSchema,
  boardCellStatePatchBatchSchema,
  boardAxisSizePatchSchema,
  boardCellStatePatchSchema,
  boardCompletionPatchSchema,
  boardNoteIdParamSchema,
  boardNoteLayoutPatchSchema,
  boardShareIdParamSchema,
  boardSheetIdParamSchema,
  boardTableIdParamSchema,
  boardTableLayoutPatchSchema,
  createBoardAxisItemSchema,
  createBoardNoteSchema,
  createBoardSheetSchema,
  createBoardTableSchema,
  importBoardCharactersSchema,
  manualBoardCharacterSchema,
  updateBoardNoteSchema,
  updateBoardSheetSchema,
  updateBoardTableSettingsSchema,
  updateBoardAxisItemSchema
} from "./board";

const routeEnv = {
  APP_ORIGIN: "http://127.0.0.1:5173",
  COOKIE_DOMAIN: "127.0.0.1",
  ENVIRONMENT: "test",
  SESSION_SECRET: "test-secret"
};

describe("board route schemas", () => {
  it("accepts small board completion batches", () => {
    expect(
      boardCompletionPatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized board completion batches and unsafe ids", () => {
    expect(
      boardCompletionPatchSchema.safeParse({
        patches: new Array(201).fill({
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: true
        })
      }).success
    ).toBe(false);

    expect(
      boardCompletionPatchSchema.safeParse({
        patches: [
          {
            tableId: "table🙂",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts bounded pixel sizes", () => {
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 48 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 48, crossSizePx: 160 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 48 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 8 }).success).toBe(true);
    expect(boardAxisSizePatchSchema.safeParse({}).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 0 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ sizePx: 2000 }).success).toBe(false);
    expect(boardAxisSizePatchSchema.safeParse({ crossSizePx: 2000 }).success).toBe(false);
  });

  it("validates board axis item ids for size updates", () => {
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis-item-1" }).success).toBe(true);
    expect(boardAxisItemIdParamSchema.safeParse({ id: "axis🙂" }).success).toBe(false);
  });

  it("accepts bounded board table layout patches", () => {
    expect(boardTableIdParamSchema.safeParse({ id: "table-1" }).success).toBe(true);
    expect(boardTableIdParamSchema.safeParse({ id: "table🙂" }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 360, height: 240 }).success).toBe(true);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: null, height: null }).success).toBe(true);
  });

  it("validates board table ids for table-level actions", () => {
    expect(boardTableIdParamSchema.safeParse({ id: "table-1" }).success).toBe(true);
    expect(boardTableIdParamSchema.safeParse({ id: "table🙂" }).success).toBe(false);
  });

  it("validates board note ids and layout patches", () => {
    expect(boardNoteIdParamSchema.safeParse({ id: "note-1" }).success).toBe(true);
    expect(boardNoteIdParamSchema.safeParse({ id: "note🙂" }).success).toBe(false);
    expect(boardNoteLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 220, height: 160 }).success).toBe(true);
    expect(boardNoteLayoutPatchSchema.safeParse({ x: -1, y: 48, width: 220, height: 160 }).success).toBe(false);
    expect(boardNoteLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 0, height: 160 }).success).toBe(false);
    expect(boardNoteLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 220, height: 0 }).success).toBe(false);
    expect(boardNoteLayoutPatchSchema.safeParse({ x: 24, y: 48, width: 2401, height: 160 }).success).toBe(false);
  });

  it("validates board sheet ids for sheet-level actions", () => {
    expect(boardSheetIdParamSchema.safeParse({ id: "sheet-1" }).success).toBe(true);
    expect(boardSheetIdParamSchema.safeParse({ id: "sheet🙂" }).success).toBe(false);
  });

  it("validates shared rice bin ids", () => {
    expect(boardShareIdParamSchema.safeParse({ shareId: "AbCdEfGhIjKlMnOpQrStUv" }).success).toBe(true);
    expect(boardShareIdParamSchema.safeParse({ shareId: "short" }).success).toBe(false);
    expect(boardShareIdParamSchema.safeParse({ shareId: "share🙂share🙂share🙂" }).success).toBe(false);
  });

  it("rejects unsafe board table layout patches", () => {
    expect(boardTableLayoutPatchSchema.safeParse({ x: -1, y: 0, width: 360, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: -1, width: 360, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: 120, height: 240 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 0, y: 0, width: 360, height: 80 }).success).toBe(false);
    expect(boardTableLayoutPatchSchema.safeParse({ x: 10001, y: 0, width: 360, height: 240 }).success).toBe(false);
  });

  it("accepts complete board axis order payloads", () => {
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-1", "row-2"]
      }).success
    ).toBe(true);
  });

  it("rejects duplicate or unsafe board axis order payloads", () => {
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-1", "row-1"]
      }).success
    ).toBe(false);
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table🙂",
        axis: "row",
        axisItemIds: ["row-1"]
      }).success
    ).toBe(false);
    expect(
      boardAxisOrderSchema.safeParse({
        tableId: "table-1",
        axis: "diagonal",
        axisItemIds: ["row-1"]
      }).success
    ).toBe(false);
  });

  it("accepts every board cell mark type", () => {
    const base = { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" };

    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "default", memo: null }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "fixed", markIcon: "pin", memo: "고정파티 21시" }).success).toBe(true);
    expect(
      boardCellStatePatchSchema.safeParse({
        ...base,
        markType: "reserved",
        markIcon: "clock",
        memo: "이번주만 트라이",
        periodKey: "weekly:2026-06-10"
      }).success
    ).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "disabled", memo: null }).success).toBe(true);
  });

  it("requires a period key only for reserved cell marks", () => {
    const base = { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" };

    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "reserved", memo: null }).success).toBe(false);
    expect(
      boardCellStatePatchSchema.safeParse({ ...base, markType: "fixed", memo: null, periodKey: "weekly:2026-06-10" }).success
    ).toBe(false);
    expect(
      boardCellStatePatchSchema.safeParse({ ...base, markType: "default", memo: null, periodKey: "weekly:2026-06-10" }).success
    ).toBe(false);
  });

  it("allows persistent memos on default, fixed, and reserved cell marks", () => {
    const base = { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" };

    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "default", memo: "메모" }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "default", memo: "첫 줄\n둘째 줄" }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "fixed", memo: "메모" }).success).toBe(true);
    expect(
      boardCellStatePatchSchema.safeParse({ ...base, markType: "reserved", memo: "메모", periodKey: "weekly:2026-06-10" }).success
    ).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "disabled", memo: "메모" }).success).toBe(false);
    expect(
      boardCellStatePatchSchema.safeParse({ ...base, markType: "fixed", memo: "가".repeat(121) }).success
    ).toBe(false);
  });

  it("accepts direct board cell mark icons and rejects unsupported icon values", () => {
    const base = { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", markType: "default" };

    expect(boardCellStatePatchSchema.safeParse({ ...base, markIcon: "star", memo: null }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markIcon: "alert", memo: "주의" }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markIcon: null, memo: "메모만" }).success).toBe(true);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markIcon: "check", memo: null }).success).toBe(false);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markIcon: "dragon", memo: null }).success).toBe(false);
    expect(boardCellStatePatchSchema.safeParse({ ...base, markType: "disabled", markIcon: "star", memo: null }).success).toBe(false);
  });

  it("rejects unsafe board cell mark patches", () => {
    expect(
      boardCellStatePatchSchema.safeParse({
        tableId: "table🙂",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "default",
        memo: null
      }).success
    ).toBe(false);
    expect(
      boardCellStatePatchSchema.safeParse({
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "hidden",
        memo: null
      }).success
    ).toBe(false);
  });

  it("accepts small board cell mark batches", () => {
    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: [
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
            columnItemId: "column-2",
            markType: "default",
            memo: null
          }
        ]
      }).success
    ).toBe(true);
  });

  it("rejects oversized board cell mark batches and unsafe ids", () => {
    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: new Array(201).fill({
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "disabled",
          memo: null
        })
      }).success
    ).toBe(false);

    expect(
      boardCellStatePatchBatchSchema.safeParse({
        patches: [
          {
            tableId: "table-1",
            rowItemId: "row🙂",
            columnItemId: "column-1",
            markType: "disabled",
            memo: null
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts normalized sheet and table names for board creation", () => {
    expect(createBoardSheetSchema.parse({ name: "  원정대  " })).toEqual({ name: "원정대" });
    expect(updateBoardSheetSchema.parse({ name: "  부캐  " })).toEqual({ name: "부캐" });
    expect(createBoardSheetSchema.parse({ name: "원정대🙂" })).toEqual({ name: "원정대🙂" });
    expect(updateBoardSheetSchema.parse({ name: "레이드🔥" })).toEqual({ name: "레이드🔥" });
    expect(createBoardTableSchema.parse({ sheetId: "sheet-1", name: "  격주 이벤트  ", orientation: "custom" })).toEqual({
      sheetId: "sheet-1",
      name: "격주 이벤트",
      orientation: "custom"
    });
    expect(createBoardTableSchema.parse({ sheetId: "sheet-1", name: "숙제✅", orientation: "custom" })).toEqual({
      sheetId: "sheet-1",
      name: "숙제✅",
      orientation: "custom"
    });
    expect(
      createBoardTableSchema.parse({
        sheetId: "sheet-1",
        name: "이벤트",
        orientation: "custom",
        templateType: "lostark_event",
        eventOptions: {
          rewardFilters: []
        }
      })
    ).toEqual({
      sheetId: "sheet-1",
      name: "이벤트",
      orientation: "custom",
      templateType: "lostark_event",
      eventOptions: {
        rewardFilters: []
      }
    });
    expect(
      createBoardTableSchema.parse({
        sheetId: "sheet-1",
        name: "이벤트",
        orientation: "custom",
        templateType: "lostark_event",
        eventOptions: {
          rewardFilters: ["gold", "card", "coin", "silver", "cardXp"]
        }
      })
    ).toEqual({
      sheetId: "sheet-1",
      name: "이벤트",
      orientation: "custom",
      templateType: "lostark_event",
      eventOptions: {
        rewardFilters: ["gold", "card", "coin", "silver", "cardXp"]
      }
    });
    expect(
      createBoardTableSchema.safeParse({
        sheetId: "sheet-1",
        name: "이벤트",
        orientation: "custom",
        templateType: "lostark_event",
        eventOptions: {
          rewardFilters: ["rice"]
        }
      }).success
    ).toBe(false);
  });

  it("accepts bounded board notes with emoji and multiline body text", () => {
    expect(
      createBoardNoteSchema.parse({
        sheetId: "sheet-1",
        title: "레이드 메모 📝",
        body: "  상아탑 먼저\r\n카멘 나중  ",
        color: "#FEF3C7"
      })
    ).toEqual({
      sheetId: "sheet-1",
      title: "레이드 메모 📝",
      body: "상아탑 먼저\n카멘 나중",
      color: "#fef3c7"
    });
    expect(
      updateBoardNoteSchema.parse({
        title: "메모",
        body: "",
        color: "#E0F2FE",
        width: 240,
        height: 180,
        locked: 1
      })
    ).toEqual({
      title: "메모",
      body: "",
      color: "#e0f2fe",
      width: 240,
      height: 180,
      locked: 1
    });
    expect(updateBoardNoteSchema.parse({ body: "본문만 수정" })).toEqual({ body: "본문만 수정" });
    expect(updateBoardNoteSchema.parse({ color: "#FEE2E2" })).toEqual({ color: "#fee2e2" });
    expect(updateBoardNoteSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unsafe or oversized board note input", () => {
    expect(createBoardNoteSchema.safeParse({ sheetId: "sheet🙂", title: "메모", body: "", color: "#fef3c7" }).success).toBe(false);
    expect(createBoardNoteSchema.safeParse({ sheetId: "sheet-1", title: "메모\u200B", body: "", color: "#fef3c7" }).success).toBe(false);
    expect(createBoardNoteSchema.safeParse({ sheetId: "sheet-1", title: "메모", body: "x".repeat(5001), color: "#fef3c7" }).success).toBe(false);
    expect(createBoardNoteSchema.safeParse({ sheetId: "sheet-1", title: "메모", body: "", color: "yellow" }).success).toBe(false);
    expect(
      updateBoardNoteSchema.safeParse({
        title: "메모",
        body: "",
        color: "#fef3c7",
        width: 80,
        height: 160,
        locked: 2
      }).success
    ).toBe(false);
  });

  it("accepts table-scoped manual characters with only a nickname", () => {
    expect(
      manualBoardCharacterSchema.parse({
        name: "임의캐릭터",
        serverName: "",
        className: null,
        itemLevel: "",
        combatPower: null
      })
    ).toMatchObject({
      name: "임의캐릭터",
      serverName: "",
      className: null,
      itemLevel: "",
      combatPower: null
    });
  });

  it("rejects unsafe board creation input", () => {
    expect(createBoardSheetSchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateBoardSheetSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createBoardSheetSchema.safeParse({ name: "원정대\u200B" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet🙂", name: "숙제", orientation: "tasks_rows" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet-1", name: "숙제", orientation: "unknown" }).success).toBe(false);
    expect(createBoardTableSchema.safeParse({ sheetId: "sheet-1", name: "숙제", orientation: "custom", extra: "x" }).success).toBe(false);
    expect(
      createBoardTableSchema.safeParse({
        sheetId: "sheet-1",
        name: "숙제",
        orientation: "custom",
        defaultRowHeight: 9999
      }).success
    ).toBe(false);
  });

  it("validates board table settings strictly", () => {
    const displaySettings = {
      show_display_name: 1 as const,
      show_server_name: 0 as const,
      show_class_name: 0 as const,
      show_item_level: 1 as const,
      show_combat_power: 0 as const
    };
    expect(
      updateBoardTableSettingsSchema.parse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 1,
        eventOptions: {
          rewardFilters: []
        },
        displaySettings,
        characterDisplaySettings: displaySettings,
        characterSeparator: { widthPx: 3, style: "dashed", color: "#3344AA" },
        applyRowSize: true,
        applyColumnSize: true
      })
    ).toEqual({
      name: "숙제",
      defaultRowHeight: 40,
      defaultColumnWidth: 132,
      locked: 1,
      eventOptions: { rewardFilters: [] },
      displaySettings,
      characterDisplaySettings: displaySettings,
      characterSeparator: { widthPx: 3, style: "dashed", color: "#3344aa" },
      applyRowSize: true,
      applyColumnSize: true
    });
    expect(
      updateBoardTableSettingsSchema.parse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132
      })
    ).toEqual({
      name: "숙제",
      defaultRowHeight: 40,
      defaultColumnWidth: 132,
      applyRowSize: false,
      applyColumnSize: false
    });
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 2
      }).success
    ).toBe(false);
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        characterSeparator: null,
        characterDisplaySettings: null,
        unknown: true
      }).success
    ).toBe(false);
    expect(
      updateBoardTableSettingsSchema.safeParse({
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        displaySettings: {
          show_display_name: 2,
          show_server_name: 0,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      }).success
    ).toBe(false);
  });

  it("accepts normalized custom axis item labels for board tables", () => {
    expect(createBoardAxisItemSchema.parse({ tableId: "table-1", axis: "row", label: "  카제로스  " })).toEqual({
      tableId: "table-1",
      axis: "row",
      label: "카제로스"
    });
    expect(createBoardAxisItemSchema.parse({ tableId: "table-1", axis: "row", label: "카제로스🙂" })).toEqual({
      tableId: "table-1",
      axis: "row",
      label: "카제로스🙂"
    });
  });

  it("rejects unsafe custom axis item input", () => {
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table🙂", axis: "row", label: "카제로스" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "diagonal", label: "카제로스" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "row", label: "카제로스\u200B" }).success).toBe(false);
    expect(createBoardAxisItemSchema.safeParse({ tableId: "table-1", axis: "row", label: "" }).success).toBe(false);
  });

  it("accepts normalized board axis item labels for updates", () => {
    expect(updateBoardAxisItemSchema.parse({ label: "  카제로스  " })).toEqual({ label: "카제로스" });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스🙂" })).toEqual({ label: "카제로스🙂" });
    expect(updateBoardAxisItemSchema.parse({ sizePx: 44, crossSizePx: 96 })).toEqual({ sizePx: 44, crossSizePx: 96 });
    expect(updateBoardAxisItemSchema.safeParse({}).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ sizePx: 15 }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ crossSizePx: 0 }).success).toBe(false);
  });

  it("accepts normalized task colors for board axis item updates", () => {
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskColor: "#BE123C" })).toEqual({
      label: "카제로스",
      taskColor: "#be123c"
    });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskColor: null })).toEqual({
      label: "카제로스",
      taskColor: null
    });
  });

  it("accepts task reset type changes for board axis item updates", () => {
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskResetType: "weekly" })).toEqual({
      label: "카제로스",
      taskResetType: "weekly"
    });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", taskResetType: "none" })).toEqual({
      label: "카제로스",
      taskResetType: "none"
    });
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", taskResetType: "monthly" }).success).toBe(false);
  });

  it("accepts normalized separator settings for board axis item updates", () => {
    expect(
      updateBoardAxisItemSchema.parse({
        label: "카제로스",
        separator: { widthPx: 3, style: "dashed", color: "#3344AA" }
      })
    ).toEqual({
      label: "카제로스",
      separator: { widthPx: 3, style: "dashed", color: "#3344aa" }
    });
    expect(updateBoardAxisItemSchema.parse({ label: "카제로스", separator: null })).toEqual({
      label: "카제로스",
      separator: null
    });
  });

  it("rejects unsafe board axis item update labels", () => {
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스\u200B" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", taskColor: "blue" }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", taskColor: "#12345g" }).success).toBe(false);
    expect(
      updateBoardAxisItemSchema.safeParse({
        label: "카제로스",
        separator: { widthPx: 0, style: "solid", color: "#334455" }
      }).success
    ).toBe(false);
    expect(
      updateBoardAxisItemSchema.safeParse({
        label: "카제로스",
        separator: { widthPx: 2, style: "double", color: "#334455" }
      }).success
    ).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ label: "카제로스", unknown: true }).success).toBe(false);
    expect(updateBoardAxisItemSchema.safeParse({ sizePx: 44, unknown: true }).success).toBe(false);
  });

  it("rejects unsafe table-scoped character imports", () => {
    expect(
      importBoardCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수 나이스1",
            serverName: "아만",
            className: "브레이커",
            itemLevel: "1,778.33",
            combatPower: "2,549.41"
          }
        ]
      }).success
    ).toBe(false);
    expect(
      importBoardCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수나이스1",
            serverName: "아만🙂",
            className: "브레이커",
            itemLevel: "1,778.33",
            combatPower: "2,549.41"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts table-scoped character imports larger than 30 characters across multiple servers", () => {
    const characters = Array.from({ length: 120 }, (_, index) => ({
      name: `캐릭터${index + 1}`,
      serverName: index % 2 === 0 ? "아만" : "카단",
      className: "브레이커",
      itemLevel: "1,640.00",
      combatPower: "2,549.41"
    }));

    expect(importBoardCharactersSchema.safeParse({ characters }).success).toBe(true);
  });
});

describe("board mutation routes", () => {
  function createMutationRouteEnv(options: { missingSheet?: boolean; missingNote?: boolean; lastSheet?: boolean; nameConflict?: boolean } = {}) {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];

    const execute = (statement: { sql: string; values: unknown[] }) => {
      const sql = statement.sql.replace(/\s+/g, " ").trim();
      const returnsRows = /\bRETURNING\b/i.test(sql) || sql.startsWith("SELECT");
      const result = (rows: Record<string, unknown>[], changes = rows.length) => ({
        success: true,
        meta: { changes },
        results: returnsRows ? rows : []
      });

      if (sql.startsWith("UPDATE sheets") && sql.includes("SET name =")) {
        if (options.nameConflict) throw new Error("D1_ERROR: UNIQUE constraint failed: sheets.user_id, sheets.name");
        return options.missingSheet ? result([]) : result([{ id: "sheet-1" }]);
      }
      if (sql.startsWith("INSERT INTO sheets")) return result([{ id: String(statement.values[0]) }]);
      if (sql.includes("INSERT INTO board_manifest_versions")) {
        if (options.missingSheet && sql.includes("WHERE EXISTS")) return result([]);
        if (options.lastSheet && sql.includes("other.id <> target.id")) return result([]);
        return result([{ user_id: "user-1", version: 8 }]);
      }
      if (sql.startsWith("UPDATE sheets") && sql.includes("content_version = content_version + 1")) {
        return options.missingSheet || (sql.includes("FROM board_notes") && options.missingNote)
          ? result([])
          : result([{ id: "sheet-1", version: 4 }]);
      }
      if (sql.startsWith("DELETE FROM sheets")) return options.missingSheet || options.lastSheet ? result([]) : result([{ id: "sheet-1" }]);
      if (sql.startsWith("SELECT CASE") && sql.includes("FROM sheets WHERE id = ? AND user_id = ?")) {
        return result([{ type: options.missingSheet ? "not_found" : "last_sheet" }]);
      }
      if (sql.startsWith("INSERT INTO board_tables")) {
        return options.missingSheet ? result([]) : result([{ id: String(statement.values[0]) }]);
      }
      if (sql.startsWith("INSERT INTO board_notes")) {
        return options.missingSheet ? result([]) : result([{ id: String(statement.values[0]) }]);
      }
      if (sql.startsWith("UPDATE board_notes")) return options.missingNote ? result([]) : result([{ id: "note-1" }]);
      if (sql.startsWith("DELETE FROM board_notes") && sql.includes("WHERE id = ? AND user_id = ?")) {
        return options.missingNote ? result([]) : result([{ id: "note-1" }]);
      }
      return result([], 1);
    };

    const env = {
      ...routeEnv,
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM sessions")) return { id: "user-1", display_name: "Tester", avatar_url: null };
              if (sql.includes("SELECT id FROM board_tables WHERE user_id = ? LIMIT 1")) return { id: "table-existing" };
              if (sql.includes("SELECT id, is_default FROM sheets")) {
                return options.missingSheet ? null : { id: "sheet-1", is_default: 1 };
              }
              if (sql.includes("SELECT COUNT(*) AS count FROM sheets")) return { count: options.lastSheet ? 1 : 2 };
              if (sql.includes("SELECT id FROM sheets WHERE user_id = ? AND name = ?")) {
                return options.nameConflict ? { id: "sheet-2" } : null;
              }
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) {
                return options.missingSheet ? null : { id: "sheet-1" };
              }
              if (sql.includes("MAX(sort_order)")) {
                return sql.includes("board_notes")
                  ? { maxSortOrder: 10, noteCount: 1 }
                  : { maxSortOrder: 10, tableCount: 1 };
              }
              return null;
            },
            async run() {
              return execute(this);
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(execute);
        }
      }
    };

    return { env, batches };
  }

  function createRemainingMutationRouteEnv(
    options: {
      invalidTargets?: boolean;
      axisItemKind?: "task" | "character" | "custom";
      lockedTable?: boolean;
      missingTable?: boolean;
      rejectBatch?: boolean;
      tableSettingsRace?: "deleted" | "locked" | "unlocked";
    } = {}
  ) {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const prepared: Array<{ sql: string }> = [];

    const execute = (statement: { sql: string; values: unknown[] }) => {
      const sql = statement.sql.replace(/\s+/g, " ").trim();
      if (sql.includes("WITH requested AS MATERIALIZED") && sql.includes("UPDATE board_axis_items")) {
        const ids = JSON.parse(String(statement.values[0])) as string[];
        return { success: true, meta: { changes: ids.length }, results: ids.map((id) => ({ id })) };
      }
      if (sql.includes("WITH requested AS") && sql.includes("UPDATE sheets") && sql.includes("FROM json_each(?1)")) {
        const ids = JSON.parse(String(statement.values[0])) as string[];
        return {
          success: true,
          meta: { changes: ids.length > 0 ? 1 : 0 },
          results: ids.length > 0 ? [{ id: "sheet-1", version: 4 }] : []
        };
      }
      if (sql.includes("changed_characters") && sql.includes("UPDATE sheets")) {
        const payload = JSON.parse(String(statement.values[1])) as Array<Record<string, unknown>>;
        return {
          success: true,
          meta: { changes: payload.length > 0 ? 1 : 0 },
          results: payload.length > 0 ? [{ id: "sheet-1", version: 4 }] : []
        };
      }
      if (sql.includes("INSERT INTO characters") && sql.includes("RETURNING id, name, server_name")) {
        const payload = JSON.parse(String(statement.values[2])) as Array<Record<string, unknown>>;
        return {
          success: true,
          meta: { changes: payload.length },
          results: payload.map((row) => ({ id: row.id, name: row.name, server_name: row.serverName }))
        };
      }
      if (sql.includes("UPDATE board_axis_items") && sql.includes("RETURNING id, character_id")) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      if (sql.includes("INSERT INTO board_axis_items") && sql.includes("RETURNING id, character_id")) {
        const payload = JSON.parse(String(statement.values[0])) as Array<Record<string, unknown>>;
        return {
          success: true,
          meta: { changes: payload.length },
          results: payload.map((row) => ({ id: row.axisItemId, character_id: row.id }))
        };
      }
      if (sql.includes("UPDATE sheets") && sql.includes("content_version = content_version + 1")) {
        if (!sql.startsWith("WITH")) {
          const tableIds = statement.values
            .filter((value): value is string => typeof value === "string" && value.startsWith("["))
            .flatMap((value) => JSON.parse(value) as string[]);
          return {
            success: true,
            meta: { changes: tableIds.includes("table-2") ? 2 : 1 },
            results: tableIds.includes("table-2")
              ? [{ id: "sheet-1", version: 4 }, { id: "sheet-2", version: 8 }]
              : [{ id: "sheet-1", version: 4 }]
          };
        }
        const payload = JSON.parse(String(statement.values[1])) as Array<Record<string, unknown>>;
        const sheetIds = [...new Set(payload.map((row) => String(row.sheet_id)))];
        return {
          success: true,
          meta: { changes: sheetIds.length },
          results: sheetIds.map((id) => ({ id, version: id === "sheet-2" ? 8 : 4 }))
        };
      }
      if (sql.startsWith("UPDATE board_tables") && sql.includes("json_each")) {
        const ids = JSON.parse(String(statement.values[1])) as string[];
        return { success: true, meta: { changes: ids.length }, results: ids.map((id) => ({ id })) };
      }
      if (sql.startsWith("UPDATE board_axis_items") && sql.includes("json_each")) {
        const ids = JSON.parse(String(statement.values[0])) as string[];
        return { success: true, meta: { changes: ids.length }, results: ids.map((id) => ({ id })) };
      }
      if (sql.includes("RETURNING table_id AS tableId")) {
        const payload = JSON.parse(String(statement.values[1])) as Array<Record<string, unknown>>;
        const rows = payload
          .filter((row) => !sql.includes("INSERT INTO board_cell_states") || row.delete_state === 0)
          .filter((row) => !sql.includes("DELETE FROM board_cell_states") || row.delete_state === 1)
          .map((row) => ({
            tableId: row.table_id,
            rowItemId: row.row_item_id,
            columnItemId: row.column_item_id,
            ...(row.period_key ? { periodKey: row.period_key } : {})
          }));
        return { success: true, meta: { changes: rows.length }, results: rows };
      }
      if (/\bRETURNING id\b/.test(sql)) {
        const id = sql.startsWith("INSERT INTO")
          ? String(statement.values[0])
          : sql.includes("board_axis_items")
            ? "axis-1"
            : "table-1";
        return { success: true, meta: { changes: 1 }, results: [{ id }] };
      }
      return { success: true, meta: { changes: 1 }, results: [] };
    };

    const env = {
      ...routeEnv,
      DB: {
        prepare(sql: string) {
          prepared.push({ sql });
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              const normalizedSql = sql.replace(/\s+/g, " ");
              if (sql.includes("FROM sessions")) return { id: "user-1", display_name: "Tester", avatar_url: null };
              if (sql.includes("SELECT id FROM board_tables WHERE user_id = ? LIMIT 1")) return { id: "table-1" };
              if (sql.includes("SELECT name, default_row_height")) {
                if (options.missingTable) return null;
                return {
                  name: "Table",
                  default_row_height: 40,
                  default_column_width: 132,
                  display_options_json: null,
                  event_options_json: null,
                  template_type: "custom",
                  locked: options.lockedTable ? 1 : 0
                };
              }
              if (sql.includes("row_role, column_role, task_axis")) {
                return options.missingTable
                  ? null
                  : { id: "table-1", row_role: "task", column_role: "character", task_axis: "rows", locked: options.lockedTable ? 1 : 0 };
              }
              if (sql.includes("row_role, column_role, locked")) {
                return options.missingTable
                  ? null
                  : { id: "table-1", row_role: "task", column_role: "character", locked: options.lockedTable ? 1 : 0 };
              }
              if (sql.includes("SELECT locked FROM board_tables") && options.tableSettingsRace) {
                if (options.tableSettingsRace === "deleted") return null;
                return { locked: options.tableSettingsRace === "locked" ? 1 : 0 };
              }
              if (sql.includes("SELECT id, locked FROM board_tables") || sql.includes("SELECT locked FROM board_tables")) {
                return options.missingTable ? null : { id: "table-1", locked: options.lockedTable ? 1 : 0 };
              }
              if (normalizedSql.includes("SELECT id FROM characters") && sql.includes("name = ?")) return { id: "character-1" };
              if (sql.includes("SELECT id, name") && sql.includes("FROM characters")) {
                return { id: "character-1", name: "캐릭터" };
              }
              if (sql.includes("SELECT id") && sql.includes("FROM board_axis_items")) return null;
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 40, cross_size_px: 132 };
              if (sql.includes("MAX(sort_order)") && sql.includes("board_axis_items")) {
                return { maxSortOrder: 10, taskCount: 1 };
              }
              if (sql.includes("MAX(sort_order)") && sql.includes("FROM characters")) return { max_sort: 0 };
              if (sql.includes("MAX(sort_order)") && sql.includes("FROM tasks")) return { max_sort: 0 };
              return null;
            },
            async all() {
              if (sql.includes("SELECT id, visible") && sql.includes("FROM board_axis_items")) {
                return { results: [{ id: "axis-1", visible: 1 }, { id: "axis-2", visible: 1 }] };
              }
              if (sql.includes("SELECT input.ordinal")) return {
                results: (JSON.parse(String(this.values[1])) as Array<Record<string, unknown>>).map((row, ordinal) => ({
                  ordinal,
                  tableId: row.table_id,
                  rowItemId: row.row_item_id,
                  columnItemId: row.column_item_id,
                  eligible: options.invalidTargets ? 0 : 1,
                  sheetId: options.invalidTargets ? null : row.table_id === "table-2" ? "sheet-2" : "sheet-1",
                  rowKind: options.invalidTargets ? null : "task",
                  columnKind: options.invalidTargets ? null : "character",
                  rowTaskResetRuleJson: options.invalidTargets ? null : '{"type":"none"}',
                  columnTaskResetRuleJson: null
                }))
              };
              return { results: [] };
            },
            async run() {
              return execute(this);
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          if (options.tableSettingsRace) {
            throw new Error("NOT NULL constraint failed: board_cell_completions.table_id");
          }
          if (
            options.axisItemKind !== undefined &&
            options.axisItemKind !== "task" &&
            statements.some((statement) => statement.sql.includes("board-axis-item-task-kind-guard"))
          ) {
            throw new Error("NOT NULL constraint failed: board_cell_completions.row_item_id");
          }
          if (options.rejectBatch) {
            return statements.map(() => ({ success: true, meta: { changes: 0 }, results: [] }));
          }
          return statements.map(execute);
        }
      }
    };

    return { env, batches, prepared };
  }

  it("collapses table settings propagation into one bounded route mutation", async () => {
    const { env, batches, prepared } = createRemainingMutationRouteEnv();
    const characterDisplaySettings = {
      show_display_name: 1,
      show_server_name: 1,
      show_class_name: 0,
      show_item_level: 1,
      show_combat_power: 0
    };
    const response = await app.request(
      "/api/board/tables/table-1",
      {
        method: "PATCH",
        headers: {
          Cookie: "riceark_session=test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Table",
          defaultRowHeight: 52,
          defaultColumnWidth: 148,
          locked: 0,
          displaySettings: characterDisplaySettings,
          applyRowSize: true,
          applyColumnSize: true,
          characterSeparator: { widthPx: 4, style: "dashed", color: "#334455" },
          characterDisplaySettings
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      versions: { sheets: [{ id: "sheet-1", version: 4 }] }
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(7);
    expect(prepared).toHaveLength(9);
    expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE sheets"))).toHaveLength(1);
    expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE board_axis_items"))).toHaveLength(1);
  });

  it("collapses axis details, primary size, and cross-size propagation into one bounded route mutation", async () => {
    const { env, batches, prepared } = createRemainingMutationRouteEnv();
    const response = await app.request(
      "/api/board/axis-items/axis-1",
      {
        method: "PATCH",
        headers: {
          Cookie: "riceark_session=test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          label: "바뀐 행",
          taskColor: "#334455",
          taskResetType: "weekly",
          sizePx: 44,
          crossSizePx: 96
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      versions: { sheets: [{ id: "sheet-1", version: 4 }] }
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(8);
    expect(prepared).toHaveLength(9);
    expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE sheets"))).toHaveLength(1);
    expect(batches[0]?.filter((statement) => statement.sql.includes("UPDATE board_axis_items"))).toHaveLength(2);
  });

  it("unlocks a table through the compatible settings payload without propagating axes", async () => {
    const { env, batches } = createRemainingMutationRouteEnv({ lockedTable: true });
    const response = await app.request(
      "/api/board/tables/table-1",
      {
        method: "PATCH",
        headers: {
          Cookie: "riceark_session=test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Table",
          defaultRowHeight: 40,
          defaultColumnWidth: 132,
          locked: 0
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.some((statement) => statement.sql.includes("UPDATE board_axis_items"))).toBe(false);
  });

  it.each([
    {
      name: "create sheet",
      method: "POST",
      path: "/api/board/sheets",
      body: { name: "New" },
      status: 201,
      expected: { id: expect.any(String), versions: { sheets: [], manifestVersion: 8 } }
    },
    {
      name: "rename sheet",
      method: "PATCH",
      path: "/api/board/sheets/sheet-1",
      body: { name: "Renamed" },
      status: 200,
      expected: { ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }], manifestVersion: 8 } }
    },
    {
      name: "delete sheet",
      method: "DELETE",
      path: "/api/board/sheets/sheet-1",
      status: 200,
      expected: { ok: true, versions: { sheets: [], manifestVersion: 8 } }
    },
    {
      name: "create table",
      method: "POST",
      path: "/api/board/tables",
      body: { sheetId: "sheet-1", name: "Table", orientation: "custom" },
      status: 201,
      expected: { id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } }
    },
    {
      name: "create note",
      method: "POST",
      path: "/api/board/notes",
      body: { sheetId: "sheet-1", title: "Memo", body: "Body" },
      status: 201,
      expected: { id: expect.any(String), versions: { sheets: [{ id: "sheet-1", version: 4 }] } }
    },
    {
      name: "update note",
      method: "PATCH",
      path: "/api/board/notes/note-1",
      body: { body: "Updated" },
      status: 200,
      expected: { ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } }
    },
    {
      name: "layout note",
      method: "PATCH",
      path: "/api/board/notes/note-1/layout",
      body: { x: 10, y: 20, width: 240, height: 180 },
      status: 200,
      expected: { ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } }
    },
    {
      name: "delete note",
      method: "DELETE",
      path: "/api/board/notes/note-1",
      status: 200,
      expected: { ok: true, versions: { sheets: [{ id: "sheet-1", version: 4 }] } }
    }
  ])("keeps $name response fields top-level and adds versions", async ({ method, path, body, status, expected }) => {
    const { env } = createMutationRouteEnv();
    const response = await app.request(
      path,
      {
        method,
        headers: {
          Cookie: "riceark_session=test-token",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      env
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(expected);
  });

  it.each([
    {
      name: "table settings",
      method: "PATCH",
      path: "/api/board/tables/table-1",
      body: { name: "Table", defaultRowHeight: 40, defaultColumnWidth: 132 },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "table delete",
      method: "DELETE",
      path: "/api/board/tables/table-1",
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "table layout",
      method: "PATCH",
      path: "/api/board/tables/table-1/layout",
      body: { x: 10, y: 20, width: 320, height: 180 },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "table transpose",
      method: "POST",
      path: "/api/board/tables/table-1/transpose",
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "table character import",
      method: "POST",
      path: "/api/board/tables/table-1/characters/import",
      body: { characters: [{ name: "캐릭터", serverName: "아만", className: "바드", itemLevel: "1700", combatPower: null }] },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "table manual character creation",
      method: "POST",
      path: "/api/board/tables/table-1/characters/manual",
      body: { name: "수동캐릭터" },
      status: 201,
      domain: { id: expect.any(String) },
      sheetCount: 1
    },
    {
      name: "table task creation",
      method: "POST",
      path: "/api/board/tables/table-1/tasks",
      body: { name: "새 숙제", resetType: "none" },
      status: 201,
      domain: { id: expect.any(String) },
      sheetCount: 1
    },
    {
      name: "axis create",
      method: "POST",
      path: "/api/board/axis-items",
      body: { tableId: "table-1", axis: "row", label: "새 행" },
      status: 201,
      domain: { id: expect.any(String) },
      sheetCount: 1
    },
    {
      name: "axis order",
      method: "PATCH",
      path: "/api/board/axis-items/order",
      body: { tableId: "table-1", axis: "row", axisItemIds: ["axis-2", "axis-1"] },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "axis update",
      method: "PATCH",
      path: "/api/board/axis-items/axis-1",
      body: { label: "바뀐 행" },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "axis size",
      method: "PATCH",
      path: "/api/board/axis-items/axis-1/size",
      body: { sizePx: 44 },
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "axis hide",
      method: "DELETE",
      path: "/api/board/axis-items/axis-1",
      status: 200,
      domain: { ok: true },
      sheetCount: 1
    },
    {
      name: "completion batch",
      method: "PATCH",
      path: "/api/board/completions",
      body: {
        patches: [
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", periodKey: "none:permanent", completed: true },
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", periodKey: "none:permanent", completed: false },
          { tableId: "table-2", rowItemId: "row-2", columnItemId: "column-2", periodKey: "none:permanent", completed: true }
        ]
      },
      status: 200,
      domain: { ok: true },
      sheetCount: 2
    },
    {
      name: "cell-state batch",
      method: "PATCH",
      path: "/api/board/cell-states",
      body: {
        patches: [
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", markType: "fixed", memo: "one" },
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", markType: "fixed", memo: "latest" },
          { tableId: "table-2", rowItemId: "row-2", columnItemId: "column-2", markType: "disabled", memo: null }
        ]
      },
      status: 200,
      domain: { ok: true },
      sheetCount: 2
    }
  ])("returns additive versions and one increment per distinct sheet for $name", async ({ method, path, body, status, domain, sheetCount }) => {
    const { env, batches } = createRemainingMutationRouteEnv();
    const response = await app.request(
      path,
      {
        method,
        headers: {
          Cookie: "riceark_session=test-token",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      env
    );

    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload).toEqual({
      ...domain,
      versions: {
        sheets: sheetCount === 2
          ? [{ id: "sheet-1", version: 4 }, { id: "sheet-2", version: 8 }]
          : [{ id: "sheet-1", version: 4 }]
      }
    });
    const versionStatements = batches.flat().filter((statement) =>
      statement.sql.includes("content_version = content_version + 1")
    );
    expect(versionStatements).toHaveLength(1);
  });

  it.each([
    {
      name: "locked table settings",
      options: { lockedTable: true },
      method: "PATCH",
      path: "/api/board/tables/table-1",
      body: { name: "Changed", defaultRowHeight: 40, defaultColumnWidth: 132 },
      status: 423,
      code: "board_table_locked"
    },
    {
      name: "table deleted after settings pre-read",
      options: { tableSettingsRace: "deleted" as const },
      method: "PATCH",
      path: "/api/board/tables/table-1",
      body: { name: "Changed", defaultRowHeight: 52, defaultColumnWidth: 148 },
      status: 404,
      code: "board_table_not_found"
    },
    {
      name: "table locked after settings pre-read",
      options: { tableSettingsRace: "locked" as const },
      method: "PATCH",
      path: "/api/board/tables/table-1",
      body: { name: "Changed", defaultRowHeight: 52, defaultColumnWidth: 148 },
      status: 423,
      code: "board_table_locked"
    },
    {
      name: "table unlocked after locked settings pre-read",
      options: { lockedTable: true, tableSettingsRace: "unlocked" as const },
      method: "PATCH",
      path: "/api/board/tables/table-1",
      body: { name: "Table", defaultRowHeight: 40, defaultColumnWidth: 132, locked: 0 },
      status: 409,
      code: "board_table_settings_conflict"
    },
    {
      name: "locked table delete",
      options: { lockedTable: true },
      method: "DELETE",
      path: "/api/board/tables/table-1",
      status: 404,
      code: "board_table_not_found"
    },
    {
      name: "missing table layout",
      options: { missingTable: true, rejectBatch: true },
      method: "PATCH",
      path: "/api/board/tables/table-1/layout",
      body: { x: 10, y: 20, width: 320, height: 180 },
      status: 404,
      code: "board_table_not_found"
    },
    {
      name: "locked axis update",
      options: { lockedTable: true, rejectBatch: true },
      method: "PATCH",
      path: "/api/board/axis-items/axis-1",
      body: { label: "Changed" },
      status: 404,
      code: "board_axis_item_not_found"
    },
    {
      name: "task fields on a non-task axis item",
      options: { axisItemKind: "character" as const },
      method: "PATCH",
      path: "/api/board/axis-items/axis-1",
      body: { taskColor: "#334455", taskResetType: "weekly" },
      status: 400,
      code: "board_axis_item_task_fields_invalid"
    },
    {
      name: "missing axis size",
      options: { rejectBatch: true },
      method: "PATCH",
      path: "/api/board/axis-items/missing-axis/size",
      body: { sizePx: 44 },
      status: 404,
      code: "board_axis_item_not_found"
    },
    {
      name: "invalid completion target",
      options: { invalidTargets: true },
      method: "PATCH",
      path: "/api/board/completions",
      body: {
        patches: [
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", periodKey: "none:permanent", completed: true }
        ]
      },
      status: 400,
      code: "invalid_board_completion_target"
    },
    {
      name: "invalid cell-state target",
      options: { invalidTargets: true },
      method: "PATCH",
      path: "/api/board/cell-states",
      body: {
        patches: [
          { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", markType: "fixed", memo: "memo" }
        ]
      },
      status: 400,
      code: "invalid_board_cell_state_target"
    }
  ])("preserves the rejected response for $name", async ({ options, method, path, body, status, code }) => {
    const { env } = createRemainingMutationRouteEnv(options);
    const response = await app.request(
      path,
      {
        method,
        headers: {
          Cookie: "riceark_session=test-token",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      env
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it.each(["/api/board/completions", "/api/board/cell-states"])(
    "returns empty versions without a write for an accepted empty batch at %s",
    async (path) => {
      const { env, batches } = createRemainingMutationRouteEnv();
      const response = await app.request(
        path,
        {
          method: "PATCH",
          headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ patches: [] })
        },
        env
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, versions: { sheets: [] } });
      expect(batches).toEqual([]);
    }
  );

  it("returns object-shaped completion and cell-state rejected keys", async () => {
    const { env } = createRemainingMutationRouteEnv({ invalidTargets: true });
    const completionKey = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "none:permanent"
    };
    const completion = await app.request(
      "/api/board/completions",
      {
        method: "PATCH",
        headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ patches: [{ ...completionKey, completed: true }] })
      },
      env
    );
    expect(completion.status).toBe(400);
    expect(await completion.json()).toEqual({
      error: {
        code: "invalid_board_completion_target",
        message: "Board completion target is not available",
        rejectedKeys: [completionKey]
      }
    });

    const cellKey = { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1" };
    const cell = await app.request(
      "/api/board/cell-states",
      {
        method: "PATCH",
        headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ patches: [{ ...cellKey, markType: "fixed", memo: "memo" }] })
      },
      env
    );
    expect(cell.status).toBe(400);
    expect(await cell.json()).toEqual({
      error: {
        code: "invalid_board_cell_state_target",
        message: "셀 표시 상태를 바꿀 수 없는 항목입니다.",
        rejectedKeys: [cellKey]
      }
    });
  });

  it.each([
    { path: "/api/board/completions", expectedStatements: 5, cellState: false },
    { path: "/api/board/cell-states", expectedStatements: 6, cellState: true }
  ])("keeps a 200-row two-sheet request at the exact statement budget for $path", async ({ path, expectedStatements, cellState }) => {
    const { env, prepared, batches } = createRemainingMutationRouteEnv();
    const patches = Array.from({ length: 200 }, (_, index) => ({
      tableId: index < 100 ? "table-1" : "table-2",
      rowItemId: `row-${index}`,
      columnItemId: `column-${index}`,
      ...(cellState
        ? { markType: "fixed", memo: `memo-${index}` }
        : { periodKey: "none:permanent", completed: index % 2 === 0 })
    }));

    const response = await app.request(
      path,
      {
        method: "PATCH",
        headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ patches })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(prepared).toHaveLength(expectedStatements);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(cellState ? 4 : 3);
    expect(batches[0]?.every((statement) => statement.values.length === 2)).toBe(true);
  });

  it.each(["/api/board/completions", "/api/board/cell-states"])(
    "performs authentication only for an empty request at %s",
    async (path) => {
      const { env, prepared, batches } = createRemainingMutationRouteEnv();
      const response = await app.request(
        path,
        {
          method: "PATCH",
          headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ patches: [] })
        },
        env
      );

      expect(response.status).toBe(200);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]?.sql).toContain("FROM sessions");
      expect(batches).toEqual([]);
    }
  );

  it.each(["/api/board/completions", "/api/board/cell-states"])(
    "returns retryable 500 for an incomplete guarded batch at %s",
    async (path) => {
      const { env } = createRemainingMutationRouteEnv({ rejectBatch: true });
      const patch = path.endsWith("completions")
        ? { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", periodKey: "none:permanent", completed: true }
        : { tableId: "table-1", rowItemId: "row-1", columnItemId: "column-1", markType: "fixed", memo: null };
      const response = await app.request(
        path,
        {
          method: "PATCH",
          headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ patches: [patch] })
        },
        env
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    }
  );

  it.each([
    {
      name: "create sheet name conflict",
      options: { nameConflict: true },
      method: "POST",
      path: "/api/board/sheets",
      body: { name: "Other" },
      status: 409,
      code: "board_sheet_name_conflict"
    },
    {
      name: "rename missing sheet",
      options: { missingSheet: true },
      method: "PATCH",
      path: "/api/board/sheets/sheet-1",
      body: { name: "Renamed" },
      status: 404,
      code: "board_sheet_not_found"
    },
    {
      name: "rename name conflict",
      options: { nameConflict: true },
      method: "PATCH",
      path: "/api/board/sheets/sheet-1",
      body: { name: "Other" },
      status: 409,
      code: "board_sheet_name_conflict"
    },
    {
      name: "delete missing sheet",
      options: { missingSheet: true },
      method: "DELETE",
      path: "/api/board/sheets/sheet-1",
      status: 404,
      code: "board_sheet_not_found"
    },
    {
      name: "delete last sheet",
      options: { lastSheet: true },
      method: "DELETE",
      path: "/api/board/sheets/sheet-1",
      status: 400,
      code: "board_sheet_last_one"
    },
    {
      name: "create table for missing sheet",
      options: { missingSheet: true },
      method: "POST",
      path: "/api/board/tables",
      body: { sheetId: "sheet-1", name: "Table", orientation: "custom" },
      status: 404,
      code: "board_sheet_not_found"
    },
    {
      name: "create note for missing sheet",
      options: { missingSheet: true },
      method: "POST",
      path: "/api/board/notes",
      body: { sheetId: "sheet-1", title: "Memo", body: "" },
      status: 404,
      code: "board_sheet_not_found"
    },
    {
      name: "update missing note",
      options: { missingNote: true },
      method: "PATCH",
      path: "/api/board/notes/note-1",
      body: { body: "Updated" },
      status: 404,
      code: "board_note_not_found"
    },
    {
      name: "layout missing note",
      options: { missingNote: true },
      method: "PATCH",
      path: "/api/board/notes/note-1/layout",
      body: { x: 10, y: 20, width: 240, height: 180 },
      status: 404,
      code: "board_note_not_found"
    },
    {
      name: "delete missing note",
      options: { missingNote: true },
      method: "DELETE",
      path: "/api/board/notes/note-1",
      status: 404,
      code: "board_note_not_found"
    }
  ])("preserves $name status and error code", async ({ options, method, path, body, status, code }) => {
    const { env } = createMutationRouteEnv(options);
    const response = await app.request(
      path,
      {
        method,
        headers: {
          Cookie: "riceark_session=test-token",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      env
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });
});

describe("board share routes", () => {
  function createShareRouteEnv() {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      ...routeEnv,
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM sessions")) return { id: "user-1", display_name: "냠수", avatar_url: null };
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("SELECT share_id FROM board_shares WHERE owner_user_id = ?")) return { share_id: "share-old" };
              if (sql.includes("SELECT share_id FROM board_shares WHERE share_id = ?")) return { share_id: "AbCdEfGhIjKlMnOpQrStUv" };
              if (sql.includes("FROM board_shares") && sql.includes("share_id = ?")) {
                return { owner_user_id: "user-1", sheet_id: "sheet-1", content_version: 0 };
              }
              if (sql.includes("FROM user_settings")) return null;
              return null;
            },
            async all() {
              if (sql.includes("WITH manifest AS") && sql.includes("LEFT JOIN sheets")) {
                return {
                  results: [
                    {
                      manifest_version: 0,
                      id: "sheet-1",
                      name: "숙제",
                      sort_order: 0,
                      is_default: 1,
                      version: 0
                    }
                  ]
                };
              }
              if (sql.includes("FROM board_shares") && sql.includes("JOIN sheets")) {
                return {
                  results: [{ sheet_id: "sheet-1", sheet_name: "숙제", share_id: "AbCdEfGhIjKlMnOpQrStUv", created_at: "2026-06-05 00:00:00" }]
                };
              }
              if (sql.includes("FROM board_share_favorites")) {
                return {
                  results: [
                    {
                      share_id: "AbCdEfGhIjKlMnOpQrStUv",
                      sheet_id: "sheet-1",
                      sheet_name: "숙제",
                      owner_display_name: "냠수",
                      created_at: "2026-06-05 00:00:00"
                    }
                  ]
                };
              }
              if (sql.includes("FROM sheets")) {
                return { results: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1, content_version: 0 }] };
              }
              if (sql.includes("FROM board_tables")) {
                return {
                  results: [
                    {
                      id: "table-1",
                      user_id: "user-1",
                      sheet_id: "sheet-1",
                      name: "숙제",
                      sort_order: 0,
                      x: 0,
                      y: 0
                    }
                  ]
                };
              }
              if (sql.includes("FROM board_axis_items")) return { results: [] };
              if (sql.includes("FROM board_notes")) return { results: [] };
              if (sql.includes("FROM board_cell_states")) return { results: [] };
              if (sql.includes("FROM board_cell_completions")) return { results: [] };
              return { results: [] };
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
            results: statement.sql.includes("RETURNING")
              ? [{ id: statement.values[0], share_id: statement.values.at(-1) }]
              : []
          }));
        }
      }
    };
    return { env, batches, runs };
  }

  it("starts and stops sharing for an authenticated owner sheet", async () => {
    const { env, batches } = createShareRouteEnv();
    const start = await app.request(
      "/api/board/sheets/sheet-1/share",
      { method: "POST", headers: { Cookie: "riceark_session=test-token" } },
      env
    );

    expect(start.status).toBe(201);
    expect(await start.json()).toEqual({ shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(batches[0]?.some((statement) => statement.sql.includes("INSERT INTO board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(false);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version"))).toBe(false);

    const stop = await app.request(
      "/api/board/sheets/sheet-1/share",
      { method: "DELETE", headers: { Cookie: "riceark_session=test-token" } },
      env
    );
    expect(stop.status).toBe(204);
    expect(batches.at(-1)?.some((statement) => statement.sql.includes("DELETE FROM board_shares"))).toBe(true);
    expect(batches.at(-1)?.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(false);
    expect(batches.at(-1)?.some((statement) => statement.sql.includes("content_version"))).toBe(false);
  });

  it("serves shared rice bins without login and blocks public mutation methods", async () => {
    const { env } = createShareRouteEnv();
    const response = await app.request("/api/shared-rice-bins/AbCdEfGhIjKlMnOpQrStUv", {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      shareId: "AbCdEfGhIjKlMnOpQrStUv",
      readOnly: true,
      userId: "user-1",
      sheets: [{ id: "sheet-1", name: "숙제" }]
    });

    const mutation = await app.request("/api/shared-rice-bins/AbCdEfGhIjKlMnOpQrStUv", { method: "POST" }, env);
    expect(mutation.status).not.toBe(200);
  });

  it("lists owner shares and manages authenticated share favorites", async () => {
    const { env, runs } = createShareRouteEnv();
    const shares = await app.request("/api/board/shares", { headers: { Cookie: "riceark_session=test-token" } }, env);
    expect(shares.status).toBe(200);
    expect(await shares.json()).toEqual({
      shares: [{ sheetId: "sheet-1", sheetName: "숙제", shareId: "AbCdEfGhIjKlMnOpQrStUv", createdAt: "2026-06-05 00:00:00" }]
    });

    const addFavorite = await app.request(
      "/api/board/share-favorites",
      {
        method: "POST",
        headers: { Cookie: "riceark_session=test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ shareId: "AbCdEfGhIjKlMnOpQrStUv" })
      },
      env
    );
    expect(addFavorite.status).toBe(201);

    const favorites = await app.request("/api/board/share-favorites", { headers: { Cookie: "riceark_session=test-token" } }, env);
    expect(favorites.status).toBe(200);
    expect(await favorites.json()).toEqual({
      favorites: [
        {
          shareId: "AbCdEfGhIjKlMnOpQrStUv",
          sheetId: "sheet-1",
          sheetName: "숙제",
          ownerDisplayName: "냠수",
          createdAt: "2026-06-05 00:00:00"
        }
      ]
    });

    const removeFavorite = await app.request(
      "/api/board/share-favorites/AbCdEfGhIjKlMnOpQrStUv",
      { method: "DELETE", headers: { Cookie: "riceark_session=test-token" } },
      env
    );
    expect(removeFavorite.status).toBe(204);
    expect(runs.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO board_share_favorites"))).toBe(true);
    expect(runs.some((statement) => statement.sql.includes("DELETE FROM board_share_favorites"))).toBe(true);
  });

  it("serves lightweight owner and shared version summaries", async () => {
    const { env } = createShareRouteEnv();
    const owner = await app.request("/api/board/versions", { headers: { Cookie: "riceark_session=test-token" } }, env);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({
      manifestVersion: 0,
      sheets: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1, version: 0 }],
      periodFingerprint: ""
    });

    const shared = await app.request("/api/shared-rice-bins/AbCdEfGhIjKlMnOpQrStUv/version", {}, env);
    expect(shared.status).toBe(200);
    expect(shared.headers.get("cache-control")).toContain("no-store");
    expect(await shared.json()).toEqual({
      shareId: "AbCdEfGhIjKlMnOpQrStUv",
      sheetId: "sheet-1",
      version: 0,
      periodFingerprint: ""
    });
  });
});
