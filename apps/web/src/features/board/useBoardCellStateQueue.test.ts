import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoardCellStateQueue } from "./useBoardCellStateQueue";
import type { BoardCellStatePatch } from "./cellStates";
import type { BoardPatchApi } from "./useBoardCompletionQueue";

function paint(index: number, memo = `memo-${index}`): BoardCellStatePatch {
  return {
    tableId: "table-1",
    rowItemId: "row-1",
    columnItemId: `column-${index}`,
    markType: "fixed",
    markIcon: "pin",
    memo
  };
}

describe("board cell-state reliable queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces ten paints inside 800 ms into one cell-state request", async () => {
    vi.useFakeTimers();
    const patch = vi.fn<BoardPatchApi>(async () => ({ ok: true, versions: { sheets: [] } }));
    const queue = createBoardCellStateQueue({ patch });

    queue.enqueueMany(Array.from({ length: 10 }, (_, index) => paint(index)));
    await vi.advanceTimersByTimeAsync(800);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toBe("/api/board/cell-states");
    expect(patch.mock.calls[0]?.[1]).toEqual({ patches: Array.from({ length: 10 }, (_, index) => paint(index)) });
    queue.dispose();
  });

  it("coalesces cell paints by structural table, row, and column key", () => {
    const queue = createBoardCellStateQueue({
      patch: vi.fn(async () => ({ ok: true as const, versions: { sheets: [] } }))
    });

    queue.enqueue(paint(1, "old"));
    queue.enqueue(paint(1, "latest"));

    expect(queue.getPendingSnapshot()).toEqual([paint(1, "latest")]);
    queue.dispose();
  });

  it("passes keepalive and the exact queue signal to the cell-state request", async () => {
    const patch = vi.fn<BoardPatchApi>(async () => ({ ok: true, versions: { sheets: [] } }));
    const queue = createBoardCellStateQueue({ patch });
    queue.enqueue(paint(1));

    await queue.flush();

    expect(patch.mock.calls[0]?.[2]).toEqual({ keepalive: true, signal: expect.any(AbortSignal) });
    queue.dispose();
  });
});
