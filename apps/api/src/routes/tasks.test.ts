import { describe, expect, it } from "vitest";
import { createTaskSchema, taskOrderSchema } from "./tasks";

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
