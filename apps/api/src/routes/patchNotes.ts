import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin } from "../auth/admin";
import { createPatchNote, deletePatchNote, listPatchNotes, updatePatchNote } from "../db/patchNotes";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { resourceIdSchema, safeText } from "../http/input";

export const patchNoteRoutes = new Hono<{ Bindings: Env }>();

export const patchNoteBodySchema = z
  .object({
    title: safeText({ allowEmoji: true, maxChars: 80, maxBytes: 320 }),
    body: safeText({ allowEmoji: true, maxChars: 5000, maxBytes: 20000, multiline: true })
  })
  .strict();

export const patchNoteIdParamSchema = z
  .object({
    id: resourceIdSchema
  })
  .strict();

patchNoteRoutes.get("/patch-notes", async (c) => {
  const notes = await listPatchNotes(c.env);
  return c.json({ notes });
});

patchNoteRoutes.post("/patch-notes", zValidator("json", patchNoteBodySchema), async (c) => {
  const user = await requireAdmin(c);
  const input = c.req.valid("json");
  const note = await createPatchNote(c.env, { ...input, authorUserId: user.id });
  return c.json({ note }, 201);
});

patchNoteRoutes.patch(
  "/patch-notes/:id",
  zValidator("param", patchNoteIdParamSchema),
  zValidator("json", patchNoteBodySchema),
  async (c) => {
    await requireAdmin(c);
    const { id } = c.req.valid("param");
    const note = await updatePatchNote(c.env, id, c.req.valid("json"));
    if (!note) throw new ApiError(404, "patch_note_not_found", "Patch note not found");
    return c.json({ note });
  }
);

patchNoteRoutes.delete("/patch-notes/:id", zValidator("param", patchNoteIdParamSchema), async (c) => {
  await requireAdmin(c);
  const { id } = c.req.valid("param");
  const deleted = await deletePatchNote(c.env, id);
  if (!deleted) throw new ApiError(404, "patch_note_not_found", "Patch note not found");
  return c.body(null, 204);
});
