import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import {
  loadBoard,
  saveBoardCompletionPatches,
  updateBoardAxisItemSize,
  type BoardCompletionPatch
} from "../db/board";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { periodKeySchema, resourceIdSchema } from "../http/input";

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

export const boardAxisSizePatchSchema = z.object({
  sizePx: z.number().int().min(16).max(1024)
});

export const boardAxisItemIdParamSchema = z.object({
  id: resourceIdSchema
});

export const boardRoutes = new Hono<{ Bindings: Env }>();

boardRoutes.get("/board", async (c) => {
  const user = await requireUser(c);
  const board = await loadBoard(c.env, user.id);
  return c.json(board);
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
