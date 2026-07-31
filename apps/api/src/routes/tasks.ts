import { zValidator } from "@hono/zod-validator";
import { buildTaskDefinition } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireSubjectUser } from "../auth/userAccess";
import { createUserTask, deleteTaskOverride, reorderTasks, updateTaskOverride } from "../db/tasks";
import type { AppEnv } from "../env";
import { ApiError } from "../http/errors";
import { resourceIdSchema, safeText } from "../http/input";

export const taskRoutes = new Hono<AppEnv>();

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const taskOrderSchema = z
  .object({
    taskIds: z.array(resourceIdSchema).max(200)
  })
  .strict()
  .refine((input) => !hasDuplicates(input.taskIds), {
    message: "Duplicate task ids are not allowed",
    path: ["taskIds"]
  });

const safeTaskNameSchema = safeText({ allowEmoji: true, maxChars: 40, maxBytes: 160 });
const taskColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((value) => value.toLowerCase());

export const createTaskSchema = z.object({
  name: safeTaskNameSchema,
  scope: z.literal("character").optional().default("character"),
  resetType: z.enum(["daily", "weekly", "biweekly", "custom", "none"]),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  intervalDays: z.number().int().min(1).max(365).optional(),
  color: taskColorSchema.optional(),
  requestId: resourceIdSchema.optional()
}).strict();

export const updateTaskSchema = z.object({
  name: safeTaskNameSchema,
  resetType: z.enum(["daily", "weekly", "biweekly", "custom", "none"]),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  intervalDays: z.number().int().min(1).max(365).optional()
}).strict();

export const taskIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

taskRoutes.patch(
  "/tasks/order",
  zValidator("json", taskOrderSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { taskIds } = c.req.valid("json");
    const updated = await reorderTasks(c.env, user.id, taskIds);
    if (!updated) throw new ApiError(400, "invalid_task_order", "Task order contains unavailable tasks");
    return c.json({ ok: true });
  }
);

taskRoutes.post(
  "/tasks",
  zValidator("json", createTaskSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const input = c.req.valid("json");
    const task = buildTaskDefinition(input);
    const id = await createUserTask(c.env, user.id, {
      name: task.name,
      scope: task.scope,
      resetRule: task.resetRule,
      createRequestId: input.requestId
    });
    return c.json({ id }, 201);
  }
);

taskRoutes.patch(
  "/tasks/:id",
  zValidator("param", taskIdParamSchema),
  zValidator("json", updateTaskSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const task = buildTaskDefinition({ ...input, scope: "character" });
    const updated = await updateTaskOverride(c.env, user.id, id, { name: task.name, resetRule: task.resetRule });
    if (!updated) throw new ApiError(404, "task_not_found", "Task not found");
    return c.json({ ok: true });
  }
);

taskRoutes.delete(
  "/tasks/:id",
  zValidator("param", taskIdParamSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { id } = c.req.valid("param");
    const deleted = await deleteTaskOverride(c.env, user.id, id);
    if (!deleted) throw new ApiError(404, "task_not_found", "Task not found");
    return c.body(null, 204);
  }
);
