import { zValidator } from "@hono/zod-validator";
import { buildTaskDefinition } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { createUserTask, reorderTasks } from "../db/tasks";
import type { Env } from "../env";
import { ApiError } from "../http/errors";

export const taskRoutes = new Hono<{ Bindings: Env }>();

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const taskOrderSchema = z
  .object({
    taskIds: z.array(z.string().min(1)).max(200)
  })
  .refine((input) => !hasDuplicates(input.taskIds), {
    message: "Duplicate task ids are not allowed",
    path: ["taskIds"]
  });

taskRoutes.patch(
  "/tasks/order",
  zValidator("json", taskOrderSchema),
  async (c) => {
    const user = await requireUser(c);
    const { taskIds } = c.req.valid("json");
    const updated = await reorderTasks(c.env, user.id, taskIds);
    if (!updated) throw new ApiError(400, "invalid_task_order", "Task order contains unavailable tasks");
    return c.json({ ok: true });
  }
);

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
