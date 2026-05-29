import { describe, expect, it } from "vitest";
import { mergeCompletionPatches } from "../src/completions";

describe("mergeCompletionPatches", () => {
  it("keeps only the latest patch for the same task character and period", () => {
    expect(
      mergeCompletionPatches([
        { taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: true },
        { taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: false }
      ])
    ).toEqual([{ taskId: "a", characterId: "c1", periodKey: "daily:2026-05-29", completed: false }]);
  });
});
