import { describe, expect, it } from "vitest";
import { getSortableItemId, moveItem, parseSortableItemId } from "./reorder";

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

describe("sortable item ids", () => {
  it("keeps task and character drag identifiers separate", () => {
    expect(getSortableItemId("task", "item-1")).toBe("task:item-1");
    expect(getSortableItemId("character", "item-1")).toBe("character:item-1");
  });

  it("parses valid sortable ids", () => {
    expect(parseSortableItemId("task:task-1")).toEqual({ kind: "task", id: "task-1" });
    expect(parseSortableItemId("character:character-1")).toEqual({ kind: "character", id: "character-1" });
  });

  it("ignores invalid sortable ids", () => {
    expect(parseSortableItemId("roster")).toBeNull();
    expect(parseSortableItemId("roster:character-1")).toBeNull();
    expect(parseSortableItemId("task:")).toBeNull();
  });
});
