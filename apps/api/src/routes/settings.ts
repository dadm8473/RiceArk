import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveUserSettings } from "../db/settings";
import type { Env } from "../env";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.patch(
  "/settings",
  zValidator(
    "json",
    z.object({
      density: z.enum(["comfortable", "default", "compact"]),
      rowHeight: z.number().int().min(28).max(72),
      columnWidth: z.number().int().min(96).max(220)
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    await saveUserSettings(c.env, user.id, c.req.valid("json"));
    return c.json({ ok: true });
  }
);
