import { describe, expect, it } from "vitest";
import { getReorderTargetId, moveItem } from "./reorder";

function createClosestTarget(kind: string, id: string): Element {
  const target = {
    closest: () => target,
    getAttribute: (name: string) => {
      if (name === "data-reorder-kind") return kind;
      if (name === "data-reorder-id") return id;
      return null;
    }
  };

  return { closest: () => target } as unknown as Element;
}

describe("moveItem", () => {
  it("moves an item from one index to another", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns the original order for no-op moves", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], -1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
  });
});

describe("getReorderTargetId", () => {
  it("finds a matching reorder target from a nested pointer element", () => {
    const element = createClosestTarget("task", "task-1");

    expect(getReorderTargetId(element, "task")).toBe("task-1");
  });

  it("ignores reorder targets from the other axis", () => {
    const element = createClosestTarget("character", "character-1");

    expect(getReorderTargetId(element, "task")).toBeNull();
  });
});
