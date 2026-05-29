import { zValidator } from "@hono/zod-validator";
import { buildTaskDefinition } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { createUserTask } from "../db/tasks";
import type { Env } from "../env";

export const taskRoutes = new Hono<{ Bindings: Env }>();

taskRoutes.post(
  "/tasks",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(40),
      scope: z.enum(["character", "roster"]),
      resetType: z.enum(["daily", "weekly", "biweekly", "custom"]),
      anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      intervalDays: z.number().int().min(1).max(365).optional()
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    const input = c.req.valid("json");
    const task = buildTaskDefinition(input);
    const id = await createUserTask(c.env, user.id, { name: task.name, scope: task.scope, resetRule: task.resetRule });
    return c.json({ id }, 201);
  }
);
