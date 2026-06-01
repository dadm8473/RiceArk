import { describe, expect, it } from "vitest";
import { createTaskSchema, taskIdParamSchema, taskOrderSchema, updateTaskSchema } from "./tasks";

describe("taskOrderSchema", () => {
  it("accepts ordered task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-b"] }).success).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-a"] }).success).toBe(false);
  });
});

describe("createTaskSchema", () => {
  it("defaults new tasks to character scope", () => {
    expect(createTaskSchema.parse({ name: "쿠르잔 전선", resetType: "daily" })).toMatchObject({
      name: "쿠르잔 전선",
      scope: "character",
      resetType: "daily"
    });
  });

  it("rejects roster as a special task scope", () => {
    expect(createTaskSchema.safeParse({ name: "세르카", scope: "roster", resetType: "daily" }).success).toBe(false);
  });
});

describe("updateTaskSchema", () => {
  it("accepts editable task name and reset type", () => {
    expect(updateTaskSchema.parse({ name: "에브니 큐브", resetType: "weekly" })).toMatchObject({
      name: "에브니 큐브",
      resetType: "weekly"
    });
  });

  it("rejects empty task names", () => {
    expect(updateTaskSchema.safeParse({ name: "", resetType: "daily" }).success).toBe(false);
  });

  it("rejects whitespace-only task names", () => {
    expect(updateTaskSchema.safeParse({ name: "   ", resetType: "daily" }).success).toBe(false);
  });
});

describe("taskIdParamSchema", () => {
  it("accepts non-empty task ids", () => {
    expect(taskIdParamSchema.safeParse({ id: "task-1" }).success).toBe(true);
  });

  it("rejects empty task ids", () => {
    expect(taskIdParamSchema.safeParse({ id: "" }).success).toBe(false);
  });
});
