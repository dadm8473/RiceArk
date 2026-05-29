import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveUserSettings, updateChecklistOrientation } from "../db/settings";
import type { Env } from "../env";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

const densitySettingsSchema = z.object({
  density: z.enum(["comfortable", "default", "compact"]),
  rowHeight: z.number().int().min(28).max(72),
  columnWidth: z.number().int().min(96).max(220)
});

export const settingsPatchSchema = z.union([
  densitySettingsSchema,
  z.object({
    checklistOrientation: z.enum(["tasks_rows", "tasks_columns"])
  })
]);

settingsRoutes.patch(
  "/settings",
  zValidator("json", settingsPatchSchema),
  async (c) => {
    const user = await requireUser(c);
    const input = c.req.valid("json");
    if ("checklistOrientation" in input) {
      await updateChecklistOrientation(c.env, user.id, input.checklistOrientation);
    } else {
      await saveUserSettings(c.env, user.id, input);
    }
    return c.json({ ok: true });
  }
);
