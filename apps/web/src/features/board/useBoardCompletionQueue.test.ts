import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/client";
import {
  attachBoardQueueLifecycle,
  createBoardCompletionQueue,
  type BoardCompletionKey,
  type BoardPatchApi
} from "./useBoardCompletionQueue";
import type { BoardCompletionPatch } from "./completions";

function completion(index: number, periodKey = "daily:2026-07-15"): BoardCompletionPatch {
  return {
    tableId: "table-1",
    rowItemId: `row-${index}`,
    columnItemId: "column-1",
    periodKey,
    completed: true
  };
}

describe("board completion reliable queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces ten edits inside 800 ms into one completion request", async () => {
    vi.useFakeTimers();
    const patch = vi.fn<BoardPatchApi>(async (_path, body) => ({
      ok: true,
      versions: { sheets: [{ id: "sheet-1", version: body.patches.length }] }
    }));
    const queue = createBoardCompletionQueue({ patch });

    queue.enqueueMany(Array.from({ length: 10 }, (_, index) => completion(index)));
    expect(patch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(799);
    expect(patch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toBe("/api/board/completions");
    expect(patch.mock.calls[0]?.[1]).toEqual({ patches: Array.from({ length: 10 }, (_, index) => completion(index)) });
    queue.dispose();
  });

  it("keeps completion periods as distinct structural keys", () => {
    const queue = createBoardCompletionQueue({
      patch: vi.fn(async () => ({ ok: true as const, versions: { sheets: [] } }))
    });

    queue.enqueue(completion(1, "daily:2026-07-15"));
    queue.enqueue({ ...completion(1, "daily:2026-07-16"), completed: false });

    expect(queue.getPendingSnapshot()).toHaveLength(2);
    queue.dispose();
  });

  it("passes keepalive and the queue-owned signal directly to apiPatch", async () => {
    const patch = vi.fn<BoardPatchApi>(async () => ({ ok: true, versions: { sheets: [] } }));
    const queue = createBoardCompletionQueue({ patch });
    queue.enqueue(completion(1));

    await queue.flush();

    const options = patch.mock.calls[0]?.[2];
    expect(options).toEqual({ keepalive: true, signal: expect.any(AbortSignal) });
    expect(options?.signal?.aborted).toBe(false);
    queue.dispose();
  });

  it("commits accepted patches synchronously before they leave pending state", async () => {
    const events: string[] = [];
    let queue: ReturnType<typeof createBoardCompletionQueue>;
    queue = createBoardCompletionQueue({
      patch: vi.fn(async () => ({ ok: true as const, versions: { sheets: [] } })),
      onAccepted: (patches) => {
        expect(queue.getPendingSnapshot()).toEqual(patches);
        events.push("accepted");
      },
      onPendingChange: (patches) => events.push(`pending:${patches.length}`)
    });
    queue.enqueue(completion(1));

    await queue.flush();

    expect(events).toEqual(["pending:1", "accepted", "pending:0"]);
    queue.dispose();
  });

  it("does not retry a server-accepted request when the accepted observer throws", async () => {
    const patch = vi.fn<BoardPatchApi>(async () => ({ ok: true, versions: { sheets: [] } }));
    const queue = createBoardCompletionQueue({
      patch,
      onAccepted: () => {
        throw new Error("observer failed");
      }
    });
    queue.enqueue(completion(1));

    await expect(queue.flush()).resolves.toBeUndefined();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(queue.getPendingSnapshot()).toEqual([]);
    queue.dispose();
  });

  it("uses validated rejected keys and falls back to every sent key", async () => {
    const rejected: BoardCompletionKey[][] = [];
    const validKey = {
      tableId: "table-1",
      rowItemId: "row-1",
      columnItemId: "column-1",
      periodKey: "daily:2026-07-15"
    };
    const validQueue = createBoardCompletionQueue({
      patch: vi.fn(async () => {
        throw new ApiClientError(422, "invalid", "Rejected", null, { rejectedKeys: [validKey] });
      }),
      onPermanentFailure: (outcome) => rejected.push(outcome.rejectedKeys)
    });
    validQueue.enqueue(completion(1));
    await validQueue.flush();
    validQueue.dispose();

    const fallbackQueue = createBoardCompletionQueue({
      patch: vi.fn(async () => {
        throw new ApiClientError(422, "invalid", "Rejected", null, { rejectedKeys: [{ tableId: 1 }] });
      }),
      onPermanentFailure: (outcome) => rejected.push(outcome.rejectedKeys)
    });
    fallbackQueue.enqueueMany([completion(3), completion(4)]);
    await fallbackQueue.flush();

    expect(rejected).toEqual([
      [validKey],
      [
        { ...validKey, rowItemId: "row-3" },
        { ...validKey, rowItemId: "row-4" }
      ]
    ]);
    fallbackQueue.dispose();
  });

  it("flushes every queue on hidden visibility and pagehide without reloading", async () => {
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, "visibilityState", { value: "visible", writable: true });
    const windowTarget = new EventTarget();
    const firstFlush = vi.fn(async () => {
      throw new Error("offline");
    });
    const secondFlush = vi.fn(async () => undefined);
    const detach = attachBoardQueueLifecycle({
      documentTarget,
      windowTarget,
      queues: [{ flush: firstFlush }, { flush: secondFlush }]
    });

    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    windowTarget.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();

    expect(firstFlush).toHaveBeenCalledTimes(2);
    expect(secondFlush).toHaveBeenCalledTimes(2);
    detach();
  });
});
