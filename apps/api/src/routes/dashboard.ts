import { zValidator } from "@hono/zod-validator";
import type { CompletionPatch } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveCompletionPatches } from "../db/completions";
import { loadDashboard } from "../db/dashboard";
import type { Env } from "../env";

const patchSchema = z.object({
  patches: z
    .array(
      z.object({
        taskId: z.string(),
        characterId: z.string().nullable(),
        periodKey: z.string(),
        completed: z.boolean()
      })
    )
    .max(200)
});

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.get("/dashboard", async (c) => {
  const user = await requireUser(c);
  const dashboard = await loadDashboard(c.env, user.id);
  return c.json(dashboard);
});

dashboardRoutes.patch("/completions", zValidator("json", patchSchema), async (c) => {
  const user = await requireUser(c);
  const { patches } = c.req.valid("json");
  await saveCompletionPatches(c.env, user.id, patches as CompletionPatch[]);
  return c.json({ ok: true });
});
