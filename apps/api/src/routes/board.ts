import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { loadBoard, saveBoardCompletionPatches, type BoardCompletionPatch } from "../db/board";
import type { Env } from "../env";
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

export const boardRoutes = new Hono<{ Bindings: Env }>();

boardRoutes.get("/board", async (c) => {
  const user = await requireUser(c);
  const board = await loadBoard(c.env, user.id);
  return c.json(board);
});

boardRoutes.patch("/board/completions", zValidator("json", boardCompletionPatchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  await saveBoardCompletionPatches(c.env, user.id, patches as BoardCompletionPatch[]);
  return c.json({ ok: true });
});
