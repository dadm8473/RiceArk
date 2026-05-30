import { describe, expect, it } from "vitest";
import { taskOrderSchema } from "./tasks";

describe("taskOrderSchema", () => {
  it("accepts ordered task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-b"] }).success).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    expect(taskOrderSchema.safeParse({ taskIds: ["task-a", "task-a"] }).success).toBe(false);
  });
});
