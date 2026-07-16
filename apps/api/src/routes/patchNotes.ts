import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireAdmin } from "../auth/admin";
import { deletePublicCacheKey, getPublicJson } from "../cache/publicJsonCache";
import { createPatchNote, deletePatchNote, listPatchNotes, updatePatchNote } from "../db/patchNotes";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { resourceIdSchema, safeText } from "../http/input";

export const patchNoteRoutes = new Hono<{ Bindings: Env }>();
const PATCH_NOTES_CACHE_NAMESPACE = "patch-notes:v1";
const PATCH_NOTES_CACHE_TTL_SECONDS = 300;

type PatchNoteContext = Context<{ Bindings: Env }>;

function setPrivateMutationHeaders(c: PatchNoteContext) {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie");
}

function patchNotesPublicUrl(requestUrl: string): string {
  return new URL("/api/patch-notes", requestUrl).toString();
}

function invalidatePatchNotes(c: PatchNoteContext) {
  const invalidation = deletePublicCacheKey(
    patchNotesPublicUrl(c.req.url),
    PATCH_NOTES_CACHE_NAMESPACE
  ).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(invalidation);
  } catch {
    // Unit tests have no execution context; the already-started invalidation remains best-effort.
  }
}

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
  return getPublicJson(
    patchNotesPublicUrl(c.req.url),
    PATCH_NOTES_CACHE_NAMESPACE,
    PATCH_NOTES_CACHE_TTL_SECONDS,
    async () => Response.json({ notes: await listPatchNotes(c.env) })
  );
});

patchNoteRoutes.post("/patch-notes", zValidator("json", patchNoteBodySchema), async (c) => {
  setPrivateMutationHeaders(c);
  const user = await requireAdmin(c);
  const input = c.req.valid("json");
  const note = await createPatchNote(c.env, { ...input, authorUserId: user.id });
  invalidatePatchNotes(c);
  return c.json({ note }, 201);
});

patchNoteRoutes.patch(
  "/patch-notes/:id",
  zValidator("param", patchNoteIdParamSchema),
  zValidator("json", patchNoteBodySchema),
  async (c) => {
    setPrivateMutationHeaders(c);
    await requireAdmin(c);
    const { id } = c.req.valid("param");
    const note = await updatePatchNote(c.env, id, c.req.valid("json"));
    if (!note) throw new ApiError(404, "patch_note_not_found", "Patch note not found");
    invalidatePatchNotes(c);
    return c.json({ note });
  }
);

patchNoteRoutes.delete("/patch-notes/:id", zValidator("param", patchNoteIdParamSchema), async (c) => {
  setPrivateMutationHeaders(c);
  await requireAdmin(c);
  const { id } = c.req.valid("param");
  const deleted = await deletePatchNote(c.env, id);
  if (!deleted) throw new ApiError(404, "patch_note_not_found", "Patch note not found");
  invalidatePatchNotes(c);
  return c.body(null, 204);
});
