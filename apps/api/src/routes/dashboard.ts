import { zValidator } from "@hono/zod-validator";
import type { CompletionPatch } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveCompletionPatches } from "../db/completions";
import { loadDashboard } from "../db/dashboard";
import type { Env } from "../env";
import { periodKeySchema, resourceIdSchema } from "../http/input";

export const completionPatchSchema = z.object({
  patches: z
    .array(
      z.object({
        taskId: resourceIdSchema,
        characterId: resourceIdSchema.nullable(),
        periodKey: periodKeySchema,
        completed: z.boolean()
      })
      .strict()
    )
    .max(200)
}).strict();

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.get("/dashboard", async (c) => {
  const user = await requireUser(c);
  const dashboard = await loadDashboard(c.env, user.id);
  return c.json(dashboard);
});

dashboardRoutes.patch("/completions", zValidator("json", completionPatchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  await saveCompletionPatches(c.env, user.id, patches as CompletionPatch[]);
  return c.json({ ok: true });
});
