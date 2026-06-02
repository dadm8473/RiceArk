import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveUserSettings, updateCharacterDisplaySettings, updateChecklistOrientation } from "../db/settings";
import type { Env } from "../env";

export const settingsRoutes = new Hono<{ Bindings: Env }>();

const densitySettingsSchema = z.object({
  density: z.enum(["comfortable", "default", "compact"]),
  rowHeight: z.number().int().min(28).max(72),
  columnWidth: z.number().int().min(96).max(220)
}).strict();

const characterDisplaySettingsSchema = z.object({
  characterDisplay: z.object({
    displayName: z.boolean(),
    serverName: z.boolean(),
    className: z.boolean(),
    itemLevel: z.boolean(),
    combatPower: z.boolean()
  }).strict()
}).strict();

export const settingsPatchSchema = z.union([
  densitySettingsSchema,
  characterDisplaySettingsSchema,
  z.object({
    checklistOrientation: z.enum(["tasks_rows", "tasks_columns"])
  }).strict()
]);

settingsRoutes.patch(
  "/settings",
  zValidator("json", settingsPatchSchema),
  async (c) => {
    const user = await requireUser(c);
    const input = c.req.valid("json");
    if ("checklistOrientation" in input) {
      await updateChecklistOrientation(c.env, user.id, input.checklistOrientation);
    } else if ("characterDisplay" in input) {
      await updateCharacterDisplaySettings(c.env, user.id, input.characterDisplay);
    } else {
      await saveUserSettings(c.env, user.id, input);
    }
    return c.json({ ok: true });
  }
);
