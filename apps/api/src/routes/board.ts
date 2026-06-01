import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import {
  createBoardAxisItem,
  createBoardSheet,
  createBoardTable,
  hideBoardAxisItem,
  loadBoard,
  reorderBoardAxisItems,
  saveBoardCellStatePatch,
  saveBoardCompletionPatches,
  transposeBoardTable,
  updateBoardAxisItem,
  updateBoardAxisItemSize,
  updateBoardTableLayout,
  type BoardTableLayoutPatch,
  type BoardCellStatePatch,
  type BoardCompletionPatch
} from "../db/board";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { periodKeySchema, resourceIdSchema, safeText } from "../http/input";

const safeBoardNameSchema = safeText({ maxChars: 30, maxBytes: 120 });
const boardTaskColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((value) => value.toLowerCase());
const boardAxisSeparatorSchema = z.object({
  widthPx: z.number().int().min(1).max(8),
  style: z.enum(["solid", "dashed", "dotted"]),
  color: boardTaskColorSchema
});

export const boardTableOrientationSchema = z.enum(["tasks_rows", "tasks_columns", "custom"]);

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const createBoardSheetSchema = z.object({
  name: safeBoardNameSchema
});

export const createBoardTableSchema = z.object({
  sheetId: resourceIdSchema,
  name: safeBoardNameSchema,
  orientation: boardTableOrientationSchema
});

export const createBoardAxisItemSchema = z.object({
  tableId: resourceIdSchema,
  axis: z.enum(["row", "column"]),
  label: safeBoardNameSchema
});

export const boardAxisOrderSchema = z
  .object({
    tableId: resourceIdSchema,
    axis: z.enum(["row", "column"]),
    axisItemIds: z.array(resourceIdSchema).max(300)
  })
  .refine((input) => !hasDuplicates(input.axisItemIds), {
    message: "Duplicate board axis item ids are not allowed",
    path: ["axisItemIds"]
  });

export const updateBoardAxisItemSchema = z.object({
  label: safeBoardNameSchema,
  taskColor: boardTaskColorSchema.nullable().optional(),
  separator: boardAxisSeparatorSchema.nullable().optional()
});

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
    )
    .max(200)
});

export const boardCellStatePatchSchema = z.object({
  tableId: resourceIdSchema,
  rowItemId: resourceIdSchema,
  columnItemId: resourceIdSchema,
  checkboxVisible: z.boolean()
});

export const boardAxisSizePatchSchema = z.object({
  sizePx: z.number().int().min(16).max(1024)
});

export const boardAxisItemIdParamSchema = z.object({
  id: resourceIdSchema
});

export const boardTableIdParamSchema = z.object({
  id: resourceIdSchema
});

export const boardTableLayoutPatchSchema = z.object({
  x: z.number().int().min(0).max(10000),
  y: z.number().int().min(0).max(10000),
  width: z.number().int().min(160).max(4000).nullable(),
  height: z.number().int().min(120).max(4000).nullable()
});

export const boardRoutes = new Hono<{ Bindings: Env }>();

boardRoutes.get("/board", async (c) => {
  const user = await requireUser(c);
  const board = await loadBoard(c.env, user.id);
  return c.json(board);
});

boardRoutes.post("/board/sheets", zValidator("json", createBoardSheetSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const sheet = await createBoardSheet(c.env, user.id, input);
  if (!sheet) {
    throw new ApiError(409, "board_sheet_name_conflict", "같은 이름의 시트가 이미 있습니다.");
  }
  return c.json(sheet, 201);
});

boardRoutes.post("/board/tables", zValidator("json", createBoardTableSchema), async (c) => {
  const user = await requireUser(c);
  const input = c.req.valid("json");
  const table = await createBoardTable(c.env, user.id, input);
  if (!table) {
    throw new ApiError(404, "board_sheet_not_found", "시트를 찾을 수 없습니다.");
  }
  return c.json(table, 201);
});

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
    const updated = await updateBoardAxisItem(c.env, user.id, id, input);
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

boardRoutes.patch("/board/cell-states", zValidator("json", boardCellStatePatchSchema), async (c) => {
  const user = await requireUser(c);
  const patch = c.req.valid("json");
  const saved = await saveBoardCellStatePatch(c.env, user.id, patch as BoardCellStatePatch);
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
    const { sizePx } = c.req.valid("json");
    const updated = await updateBoardAxisItemSize(c.env, user.id, id, sizePx);
    if (!updated) {
      throw new ApiError(404, "board_axis_item_not_found", "Board axis item not found");
    }
    return c.json({ ok: true });
  }
);
