import { zValidator } from "@hono/zod-validator";
import { buildTaskDefinition } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import {
  addBoardShareFavorite,
  createBoardAxisItem,
  createManualBoardCharacterForTable,
  createBoardNote,
  createBoardSheet,
  createBoardTable,
  createBoardTaskForTable,
  deleteBoardNote,
  deleteBoardShareFavorite,
  deleteBoardSheet,
  deleteBoardTable,
  hideBoardAxisItem,
  importBoardCharactersForTable,
  listBoardShareFavorites,
  listBoardShares,
  loadBoard,
  loadBoardVersionSummary,
  loadSharedBoard,
  loadSharedBoardVersionSummary,
  reorderBoardAxisItems,
  saveBoardCellStatePatches,
  saveBoardCompletionPatches,
  startBoardSheetShare,
  stopBoardSheetShare,
  transposeBoardTable,
  updateBoardNote,
  updateBoardNoteLayout,
  updateBoardAxisItem,
  updateBoardAxisItemSize,
  updateBoardSheet,
  updateBoardTableSettings,
  updateBoardTableLayout,
  type BoardNoteLayoutPatch,
  type BoardTableLayoutPatch,
  type BoardCellStatePatch,
  type BoardCompletionPatch
} from "../db/board";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { periodKeySchema, resourceIdSchema, safeText } from "../http/input";
import type { LostArkEventRewardFilter } from "../lostark/events";
import {
  CHARACTER_IMPORT_MAX_COUNT,
  lostArkCharacterNameSchema,
  manualCharacterSchema,
  numericCharacterStatText,
  optionalNumericCharacterStatText
} from "./characters";
import { createTaskSchema } from "./tasks";

const safeBoardNameSchema = safeText({ allowEmoji: true, maxChars: 30, maxBytes: 120 });
const boardTaskColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((value) => value.toLowerCase());
const boardTaskResetTypeSchema = z.enum(["daily", "weekly", "biweekly", "none"]);
const boardAxisSeparatorSchema = z.object({
  widthPx: z.number().int().min(1).max(8),
  style: z.enum(["solid", "dashed", "dotted"]),
  color: boardTaskColorSchema
}).strict();
const boardDisplaySettingsSchema = z.object({
  show_display_name: z.union([z.literal(0), z.literal(1)]),
  show_server_name: z.union([z.literal(0), z.literal(1)]),
  show_class_name: z.union([z.literal(0), z.literal(1)]),
  show_item_level: z.union([z.literal(0), z.literal(1)]),
  show_combat_power: z.union([z.literal(0), z.literal(1)])
}).strict();
const boardDefaultRowHeightSchema = z.number().int().min(16).max(1024);
const boardDefaultColumnWidthSchema = z.number().int().min(16).max(1024);
const boardAxisPrimarySizeSchema = z.number().int().min(16).max(1024);
const boardAxisLabelSizeSchema = z.number().int().min(1).max(1024);
const boardNoteTitleSchema = safeText({ allowEmoji: true, maxChars: 80, maxBytes: 320 });
const boardNoteBodySchema = safeText({ allowEmpty: true, allowEmoji: true, maxChars: 5000, maxBytes: 20000, multiline: true });
const boardNoteWidthSchema = z.number().int().min(80).max(2400);
const boardNoteHeightSchema = z.number().int().min(64).max(2400);

export const boardTableOrientationSchema = z.enum(["tasks_rows", "tasks_columns", "custom"]);
const boardTableTemplateTypeSchema = z.enum(["custom", "lostark_event"]);
const lostArkEventRewardFilterSchema = z.enum(["gold", "card", "coin", "silver", "cardXp"]);

function hasDuplicateRewardFilters(values: LostArkEventRewardFilter[]): boolean {
  return new Set(values).size !== values.length;
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const createBoardSheetSchema = z.object({
  name: safeBoardNameSchema
}).strict();

export const updateBoardSheetSchema = createBoardSheetSchema;

export const boardSheetIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

export const boardShareIdParamSchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{22}$/)
}).strict();

export const boardShareFavoriteSchema = z.object({
  shareId: boardShareIdParamSchema.shape.shareId
}).strict();

export const createBoardTableSchema = z.object({
  sheetId: resourceIdSchema,
  name: safeBoardNameSchema,
  orientation: boardTableOrientationSchema,
  defaultRowHeight: boardDefaultRowHeightSchema.optional(),
  defaultColumnWidth: boardDefaultColumnWidthSchema.optional(),
  displaySettings: boardDisplaySettingsSchema.nullable().optional(),
  templateType: boardTableTemplateTypeSchema.optional(),
  eventOptions: z
    .object({
      rewardFilters: z
        .array(lostArkEventRewardFilterSchema)
        .max(5)
        .refine((values): values is LostArkEventRewardFilter[] => !hasDuplicateRewardFilters(values as LostArkEventRewardFilter[]), {
          message: "Duplicate reward filters are not allowed"
        })
    })
    .strict()
    .nullable()
    .optional()
}).strict();

export const createBoardNoteSchema = z.object({
  sheetId: resourceIdSchema,
  title: boardNoteTitleSchema,
  body: boardNoteBodySchema,
  color: boardTaskColorSchema.optional()
}).strict();

export const updateBoardNoteSchema = z.object({
  title: boardNoteTitleSchema.optional(),
  body: boardNoteBodySchema.optional(),
  color: boardTaskColorSchema.optional(),
  width: boardNoteWidthSchema.optional(),
  height: boardNoteHeightSchema.optional(),
  locked: z.union([z.literal(0), z.literal(1)]).optional()
})
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "At least one note field is required" });

export const createBoardAxisItemSchema = z.object({
  tableId: resourceIdSchema,
  axis: z.enum(["row", "column"]),
  label: safeBoardNameSchema
}).strict();

export const boardAxisOrderSchema = z
  .object({
    tableId: resourceIdSchema,
    axis: z.enum(["row", "column"]),
    axisItemIds: z.array(resourceIdSchema).max(300)
  })
  .strict()
  .refine((input) => !hasDuplicates(input.axisItemIds), {
    message: "Duplicate board axis item ids are not allowed",
    path: ["axisItemIds"]
  });

export const updateBoardAxisItemSchema = z.object({
  label: safeBoardNameSchema,
  taskColor: boardTaskColorSchema.nullable().optional(),
  taskResetType: boardTaskResetTypeSchema.optional(),
  separator: boardAxisSeparatorSchema.nullable().optional(),
  displaySettings: boardDisplaySettingsSchema.nullable().optional()
}).strict();

export const updateBoardTableSettingsSchema = z.object({
  name: safeBoardNameSchema,
  defaultRowHeight: boardDefaultRowHeightSchema,
  defaultColumnWidth: boardDefaultColumnWidthSchema,
  locked: z.union([z.literal(0), z.literal(1)]).optional(),
  displaySettings: boardDisplaySettingsSchema.nullable().optional(),
  eventOptions: z
    .object({
      rewardFilters: z
        .array(lostArkEventRewardFilterSchema)
        .max(5)
        .refine((values): values is LostArkEventRewardFilter[] => !hasDuplicateRewardFilters(values as LostArkEventRewardFilter[]), {
          message: "Duplicate reward filters are not allowed"
        })
    })
    .strict()
    .nullable()
    .optional()
}).strict();

export const importBoardCharactersSchema = z.object({
  characters: z
    .array(
      z.object({
        name: lostArkCharacterNameSchema,
        serverName: safeText({ maxChars: 20 }),
        className: safeText({ maxChars: 20 }),
        itemLevel: numericCharacterStatText,
        combatPower: optionalNumericCharacterStatText.optional()
      })
      .strict()
    )
    .min(1)
    .max(CHARACTER_IMPORT_MAX_COUNT)
}).strict();
export const manualBoardCharacterSchema = manualCharacterSchema;

export const boardCompletionPatchSchema = z.object({
  patches: z
    .array(
      z.object({
        tableId: resourceIdSchema,
        rowItemId: resourceIdSchema,
        columnItemId: resourceIdSchema,
        periodKey: periodKeySchema,
        completed: z.boolean()
      })
      .strict()
    )
    .max(200)
}).strict();

export const boardCellMarkTypeSchema = z.enum(["default", "fixed", "reserved", "disabled"]);
export const boardCellMarkIconSchema = z.enum(["memo", "pin", "clock", "star", "alert", "flag", "tag", "check"]);

export const boardCellStatePatchSchema = z.object({
  tableId: resourceIdSchema,
  rowItemId: resourceIdSchema,
  columnItemId: resourceIdSchema,
  markType: boardCellMarkTypeSchema,
  markIcon: boardCellMarkIconSchema.nullable().optional(),
  memo: safeText({ maxChars: 120, allowEmpty: true, multiline: true }).nullable(),
  periodKey: periodKeySchema.optional()
}).strict()
  .refine((patch) => (patch.markType === "reserved" ? patch.periodKey !== undefined : patch.periodKey === undefined), {
    message: "예약 타입에만 periodKey가 필요합니다."
  })
  .refine((patch) => patch.markType !== "disabled" || ((patch.memo === null || patch.memo === "") && (patch.markIcon === null || patch.markIcon === undefined)), {
    message: "비활성화 타입에는 아이콘이나 메모를 남길 수 없습니다."
  });

export const boardCellStatePatchBatchSchema = z.object({
  patches: z.array(boardCellStatePatchSchema).max(200)
}).strict();

export const boardAxisSizePatchSchema = z.object({
  sizePx: boardAxisPrimarySizeSchema.optional(),
  crossSizePx: boardAxisLabelSizeSchema.optional()
}).strict().refine((patch) => patch.sizePx !== undefined || patch.crossSizePx !== undefined, {
  message: "At least one size value is required"
});

export const boardAxisItemIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

export const boardTableIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

export const boardNoteIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

export const boardTableLayoutPatchSchema = z.object({
  x: z.number().int().min(0).max(10000),
  y: z.number().int().min(0).max(10000),
  width: z.number().int().min(160).max(4000).nullable(),
  height: z.number().int().min(120).max(4000).nullable()
}).strict();

export const boardNoteLayoutPatchSchema = z.object({
  x: z.number().int().min(0).max(10000),
  y: z.number().int().min(0).max(10000),
  width: boardNoteWidthSchema,
  height: boardNoteHeightSchema
}).strict();

export const boardRoutes = new Hono<{ Bindings: Env }>();

boardRoutes.get("/board/versions", async (c) => {
  const user = await requireUser(c);
  const versions = await loadBoardVersionSummary(c.env, user.id);
  c.header("Cache-Control", "private, no-store");
  return c.json(versions);
});

boardRoutes.get("/board", async (c) => {
  const user = await requireUser(c);
  const board = await loadBoard(c.env, user.id);
  return c.json(board);
});

boardRoutes.get("/board/shares", async (c) => {
  const user = await requireUser(c);
  const shares = await listBoardShares(c.env, user.id);
  return c.json({ shares });
});

boardRoutes.get("/board/share-favorites", async (c) => {
  const user = await requireUser(c);
  const favorites = await listBoardShareFavorites(c.env, user.id);
  return c.json({ favorites });
});

boardRoutes.post("/board/share-favorites", zValidator("json", boardShareFavoriteSchema), async (c) => {
  const user = await requireUser(c);
  const { shareId } = c.req.valid("json");
  const created = await addBoardShareFavorite(c.env, user.id, shareId);
  if (created === "not_found") {
    throw new ApiError(404, "board_share_not_found", "공유 쌀통을 찾을 수 없습니다.");
  }
  return c.json(created, 201);
});

boardRoutes.delete("/board/share-favorites/:shareId", zValidator("param", boardShareIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { shareId } = c.req.valid("param");
  await deleteBoardShareFavorite(c.env, user.id, shareId);
  return c.body(null, 204);
});

boardRoutes.get("/shared-rice-bins/:shareId", zValidator("param", boardShareIdParamSchema), async (c) => {
  const { shareId } = c.req.valid("param");
  const board = await loadSharedBoard(c.env, shareId);
  if (!board) {
    throw new ApiError(404, "board_share_not_found", "공유 쌀통을 찾을 수 없습니다.");
  }
  c.header("Cache-Control", "no-store");
  return c.json(board);
});

boardRoutes.get("/shared-rice-bins/:shareId/version", zValidator("param", boardShareIdParamSchema), async (c) => {
  const { shareId } = c.req.valid("param");
  const versions = await loadSharedBoardVersionSummary(c.env, shareId);
  if (!versions) {
    throw new ApiError(404, "board_share_not_found", "공유 쌀통을 찾을 수 없습니다.");
  }
  c.header("Cache-Control", "no-store");
  return c.json(versions);
});

boardRoutes.post("/board/sheets", zValidator("json", createBoardSheetSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const sheet = await createBoardSheet(c.env, user.id, input);
  if (!sheet) {
    throw new ApiError(409, "board_sheet_name_conflict", "같은 이름의 탭이 이미 있습니다.");
  }
  return c.json(sheet, 201);
});

boardRoutes.post("/board/sheets/:id/share", zValidator("param", boardSheetIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const shared = await startBoardSheetShare(c.env, user.id, id);
  if (shared === "not_found") {
    throw new ApiError(404, "board_sheet_not_found", "탭을 찾을 수 없습니다.");
  }
  return c.json(shared, 201);
});

boardRoutes.delete("/board/sheets/:id/share", zValidator("param", boardSheetIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  await stopBoardSheetShare(c.env, user.id, id);
  return c.body(null, 204);
});

boardRoutes.delete("/board/sheets/:id", zValidator("param", boardSheetIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const result = await deleteBoardSheet(c.env, user.id, id);
  if (result === "not_found") {
    throw new ApiError(404, "board_sheet_not_found", "탭을 찾을 수 없습니다.");
  }
  if (result === "last_sheet") {
    throw new ApiError(400, "board_sheet_last_one", "마지막 탭은 삭제할 수 없습니다.");
  }
  return c.body(null, 204);
});

boardRoutes.patch(
  "/board/sheets/:id",
  zValidator("param", boardSheetIdParamSchema),
  zValidator("json", updateBoardSheetSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const result = await updateBoardSheet(c.env, user.id, id, input);
    if (result === "not_found") {
      throw new ApiError(404, "board_sheet_not_found", "탭을 찾을 수 없습니다.");
    }
    if (result === "name_conflict") {
      throw new ApiError(409, "board_sheet_name_conflict", "같은 이름의 탭이 이미 있습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.post("/board/tables", zValidator("json", createBoardTableSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const table = await createBoardTable(c.env, user.id, input);
  if (!table) {
    throw new ApiError(404, "board_sheet_not_found", "탭을 찾을 수 없습니다.");
  }
  return c.json(table, 201);
});

boardRoutes.post("/board/notes", zValidator("json", createBoardNoteSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const note = await createBoardNote(c.env, user.id, input);
  if (!note) {
    throw new ApiError(404, "board_sheet_not_found", "탭을 찾을 수 없습니다.");
  }
  return c.json(note, 201);
});

boardRoutes.patch(
  "/board/notes/:id",
  zValidator("param", boardNoteIdParamSchema),
  zValidator("json", updateBoardNoteSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const updated = await updateBoardNote(c.env, user.id, id, input);
    if (updated === "not_found") {
      throw new ApiError(404, "board_note_not_found", "메모를 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.delete("/board/notes/:id", zValidator("param", boardNoteIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const deleted = await deleteBoardNote(c.env, user.id, id);
  if (!deleted) {
    throw new ApiError(404, "board_note_not_found", "메모를 찾을 수 없습니다.");
  }
  return c.body(null, 204);
});

boardRoutes.patch(
  "/board/tables/:id",
  zValidator("param", boardTableIdParamSchema),
  zValidator("json", updateBoardTableSettingsSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const updated = await updateBoardTableSettings(c.env, user.id, id, input);
    if (updated === "locked") {
      throw new ApiError(423, "board_table_locked", "잠긴 표는 잠금을 해제한 뒤 수정할 수 있습니다.");
    }
    if (updated === "not_found") {
      throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.delete("/board/tables/:id", zValidator("param", boardTableIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const deleted = await deleteBoardTable(c.env, user.id, id);
  if (!deleted) {
    throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
  }
  return c.body(null, 204);
});

boardRoutes.post(
  "/board/tables/:id/characters/import",
  zValidator("param", boardTableIdParamSchema),
  zValidator("json", importBoardCharactersSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const { characters } = c.req.valid("json");
    const imported = await importBoardCharactersForTable(
      c.env,
      user.id,
      id,
      characters.map((character) => ({ ...character, combatPower: character.combatPower ?? null }))
    );
    if (!imported) {
      throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.post(
  "/board/tables/:id/characters/manual",
  zValidator("param", boardTableIdParamSchema),
  zValidator("json", manualBoardCharacterSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const created = await createManualBoardCharacterForTable(c.env, user.id, id, {
      name: input.name,
      serverName: input.serverName?.trim() ? input.serverName.trim() : "",
      className: input.className?.trim() ? input.className.trim() : "",
      itemLevel: input.itemLevel?.trim() ? input.itemLevel.trim() : "",
      combatPower: input.combatPower?.trim() ? input.combatPower.trim() : null
    });
    if (!created) {
      throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
    }
    return c.json(created, 201);
  }
);

boardRoutes.post(
  "/board/tables/:id/tasks",
  zValidator("param", boardTableIdParamSchema),
  zValidator("json", createTaskSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const task = buildTaskDefinition(input);
    const created = await createBoardTaskForTable(c.env, user.id, id, {
      name: task.name,
      scope: task.scope,
      resetRule: task.resetRule,
      taskColor: input.color,
      createRequestId: input.requestId
    });
    if (!created) {
      throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
    }
    return c.json(created, 201);
  }
);

boardRoutes.post("/board/axis-items", zValidator("json", createBoardAxisItemSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const axisItem = await createBoardAxisItem(c.env, user.id, input);
  if (!axisItem) {
    throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
  }
  return c.json(axisItem, 201);
});

boardRoutes.patch("/board/axis-items/order", zValidator("json", boardAxisOrderSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const updated = await reorderBoardAxisItems(c.env, user.id, input);
  if (!updated) {
    throw new ApiError(400, "invalid_board_axis_order", "행 또는 열 순서에 사용할 수 없는 항목이 있습니다.");
  }
  return c.json({ ok: true });
});

boardRoutes.patch(
  "/board/tables/:id/layout",
  zValidator("param", boardTableIdParamSchema),
  zValidator("json", boardTableLayoutPatchSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const updated = await updateBoardTableLayout(c.env, user.id, id, patch as BoardTableLayoutPatch);
    if (!updated) {
      throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.patch(
  "/board/notes/:id/layout",
  zValidator("param", boardNoteIdParamSchema),
  zValidator("json", boardNoteLayoutPatchSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const updated = await updateBoardNoteLayout(c.env, user.id, id, patch as BoardNoteLayoutPatch);
    if (!updated) {
      throw new ApiError(404, "board_note_not_found", "메모를 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.post("/board/tables/:id/transpose", zValidator("param", boardTableIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const updated = await transposeBoardTable(c.env, user.id, id);
  if (!updated) {
    throw new ApiError(404, "board_table_not_found", "표를 찾을 수 없습니다.");
  }
  return c.json({ ok: true });
});

boardRoutes.patch(
  "/board/axis-items/:id",
  zValidator("param", boardAxisItemIdParamSchema),
  zValidator("json", updateBoardAxisItemSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const taskResetRule = input.taskResetType
      ? buildTaskDefinition({ name: input.label, scope: "character", resetType: input.taskResetType }).resetRule
      : undefined;
    const updated = await updateBoardAxisItem(c.env, user.id, id, { ...input, taskResetRule });
    if (!updated) {
      throw new ApiError(404, "board_axis_item_not_found", "행 또는 열 항목을 찾을 수 없습니다.");
    }
    return c.json({ ok: true });
  }
);

boardRoutes.delete("/board/axis-items/:id", zValidator("param", boardAxisItemIdParamSchema), async (c) => {
  const user = await requireUser(c);
  const { id } = c.req.valid("param");
  const deleted = await hideBoardAxisItem(c.env, user.id, id);
  if (!deleted) {
    throw new ApiError(404, "board_axis_item_not_found", "행 또는 열 항목을 찾을 수 없습니다.");
  }
  return c.body(null, 204);
});

boardRoutes.patch("/board/completions", zValidator("json", boardCompletionPatchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  const saved = await saveBoardCompletionPatches(c.env, user.id, patches as BoardCompletionPatch[]);
  if (!saved) {
    throw new ApiError(400, "invalid_board_completion_target", "Board completion target is not available");
  }
  return c.json({ ok: true });
});

boardRoutes.patch("/board/cell-states", zValidator("json", boardCellStatePatchBatchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  const saved = await saveBoardCellStatePatches(c.env, user.id, patches as BoardCellStatePatch[]);
  if (!saved) {
    throw new ApiError(400, "invalid_board_cell_state_target", "셀 표시 상태를 바꿀 수 없는 항목입니다.");
  }
  return c.json({ ok: true });
});

boardRoutes.patch(
  "/board/axis-items/:id/size",
  zValidator("param", boardAxisItemIdParamSchema),
  zValidator("json", boardAxisSizePatchSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const updated = await updateBoardAxisItemSize(c.env, user.id, id, patch);
    if (!updated) {
      throw new ApiError(404, "board_axis_item_not_found", "Board axis item not found");
    }
    return c.json({ ok: true });
  }
);
