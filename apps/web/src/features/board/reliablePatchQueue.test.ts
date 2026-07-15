import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/client";
import type { BoardMutationVersions } from "./types";
import {
  PATCH_QUEUE_DEBOUNCE_MS,
  PATCH_QUEUE_MAX_BODY_BYTES,
  PATCH_QUEUE_MAX_ITEMS,
  PATCH_QUEUE_REQUEST_TIMEOUT_MS,
  PATCH_QUEUE_RETRY_MS,
  ReliablePatchQueue,
  ReliablePatchQueueFlushError,
  classifyQueueError,
  type ReliablePatchQueueOptions,
  type SendOutcome
} from "./reliablePatchQueue";

interface Patch {
  key: string;
  value: boolean;
  payload?: string;
}

function accepted(patches: Patch[]): SendOutcome<string> {
  return { type: "accepted", acknowledgedKeys: patches.map((patch) => patch.key) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortableDeferred<T>(signal: AbortSignal) {
  const result = deferred<T>();
  signal.addEventListener("abort", () => result.reject(signal.reason), { once: true });
  return result;
}

function makeQueue(
  overrides: Partial<ReliablePatchQueueOptions<Patch, string>> = {}
) {
  const pendingChanges: Patch[][] = [];
  const permanentFailures: Array<Extract<SendOutcome<string>, { type: "rejected" }>> = [];
  const authPauses: ApiClientError[] = [];
  const versionChanges: BoardMutationVersions[] = [];
  const options: ReliablePatchQueueOptions<Patch, string> = {
    keyOf: (patch) => patch.key,
    serializeBody: (patches) => JSON.stringify({ patches }),
    send: async (patches) => accepted(patches),
    onPendingChange: (patches) => pendingChanges.push(patches),
    onPermanentFailure: (outcome) => permanentFailures.push(outcome),
    onAuthPause: (error) => authPauses.push(error),
    onVersions: (versions) => versionChanges.push(versions),
    ...overrides
  };

  return {
    queue: new ReliablePatchQueue(options),
    pendingChanges,
    permanentFailures,
    authPauses,
    versionChanges
  };
}

describe("ReliablePatchQueue", () => {
  let eventTarget: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    eventTarget = new EventTarget();
    vi.stubGlobal("window", eventTarget);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exports the stable queue limits", () => {
    expect(PATCH_QUEUE_DEBOUNCE_MS).toBe(800);
    expect(PATCH_QUEUE_MAX_ITEMS).toBe(200);
    expect(PATCH_QUEUE_MAX_BODY_BYTES).toBe(24 * 1024);
    expect(PATCH_QUEUE_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(PATCH_QUEUE_RETRY_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
  });

  it("coalesces by key in first-insertion order with the latest value", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue, pendingChanges } = makeQueue({ send });

    queue.enqueue({ key: "a", value: true });
    queue.enqueue({ key: "b", value: true });
    queue.enqueue({ key: "a", value: false });

    expect(pendingChanges.at(-1)).toEqual([
      { key: "a", value: false },
      { key: "b", value: true }
    ]);
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_DEBOUNCE_MS);
    expect(send).toHaveBeenCalledWith(
      [
        { key: "a", value: false },
        { key: "b", value: true }
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("waits for the 800 ms debounce", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue } = makeQueue({ send });

    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(799);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still schedules work when onPendingChange throws synchronously", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue } = makeQueue({
      send,
      onPendingChange: () => {
        throw new Error("render observer failed");
      }
    });

    expect(() => queue.enqueue({ key: "a", value: true })).not.toThrow();
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it.each(["dispose", "discard"] as const)(
    "leaves no timer when onPendingChange reentrantly calls %s",
    (action) => {
      let queue!: ReliablePatchQueue<Patch, string>;
      let acted = false;
      ({ queue } = makeQueue({
        onPendingChange: (patches) => {
          if (acted || patches.length === 0) return;
          acted = true;
          if (action === "dispose") queue.dispose();
          else queue.discard();
        }
      }));

      queue.enqueue({ key: "a", value: true });

      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("handles a rejected thenable returned by a void observer", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const rejectedObserver = (() => Promise.reject(new Error("async observer failed"))) as (
      patches: Patch[]
    ) => void;
    const { queue } = makeQueue({ send, onPendingChange: rejectedObserver });

    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("allows only one active send", async () => {
    const first = deferred<SendOutcome<string>>();
    let active = 0;
    let maximumActive = 0;
    const send = vi.fn(async (patches: Patch[]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const outcome = send.mock.calls.length === 1 ? await first.promise : accepted(patches);
      active -= 1;
      return outcome;
    });
    const { queue } = makeQueue({ send });

    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);
    queue.enqueue({ key: "b", value: true });
    await vi.advanceTimersByTimeAsync(800);
    eventTarget.dispatchEvent(new Event("focus"));
    eventTarget.dispatchEvent(new Event("online"));
    expect(send).toHaveBeenCalledTimes(1);

    first.resolve({ type: "accepted", acknowledgedKeys: ["a"] });
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it.each([
    ["serialization", "flush"],
    ["oversize", "retry"]
  ] as const)(
    "reserves one worker when a %s failure observer calls %s synchronously",
    async (failureKind, reentrantAction) => {
      let queue!: ReliablePatchQueue<Patch, string>;
      let activeSends = 0;
      let maximumActiveSends = 0;
      const send = vi.fn(async (patches: Patch[]) => {
        activeSends += 1;
        maximumActiveSends = Math.max(maximumActiveSends, activeSends);
        await Promise.resolve();
        activeSends -= 1;
        return accepted(patches);
      });
      ({ queue } = makeQueue({
        serializeBody: (patches) => {
          if (failureKind === "serialization" && patches.some(({ key }) => key === "bad")) {
            throw new Error("Cannot serialize bad patch");
          }
          return JSON.stringify({ patches });
        },
        send,
        onPermanentFailure: () => {
          if (reentrantAction === "flush") {
            void queue.flush().catch(() => undefined);
          } else {
            queue.retry();
          }
        }
      }));
      queue.enqueueMany([
        {
          key: "bad",
          value: true,
          ...(failureKind === "oversize"
            ? { payload: "x".repeat(PATCH_QUEUE_MAX_BODY_BYTES) }
            : {})
        },
        { key: "good", value: false }
      ]);

      await expect(queue.flush()).resolves.toBeUndefined();
      expect(maximumActiveSends).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("schedules an enqueue that lands between drain resolution and worker finalization", async () => {
    let queue!: ReliablePatchQueue<Patch, string>;
    let nestedEnqueueScheduled = false;
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    ({ queue } = makeQueue({
      send,
      onPendingChange: (patches) => {
        if (patches.length === 0 && !nestedEnqueueScheduled) {
          nestedEnqueueScheduled = true;
          queueMicrotask(() => {
            queueMicrotask(() => queue.enqueue({ key: "nested", value: true }));
          });
        }
      }
    }));
    queue.enqueue({ key: "initial", value: true });

    await vi.advanceTimersByTimeAsync(800);
    expect(queue.getPendingSnapshot()).toEqual([{ key: "nested", value: true }]);
    await vi.advanceTimersByTimeAsync(799);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("splits sends at 200 patches", async () => {
    const sizes: number[] = [];
    const send = vi.fn(async (patches: Patch[]) => {
      sizes.push(patches.length);
      return accepted(patches);
    });
    const { queue } = makeQueue({ send });

    queue.enqueueMany(
      Array.from({ length: 401 }, (_, index) => ({ key: `key-${index}`, value: true }))
    );
    await vi.advanceTimersByTimeAsync(800);

    expect(sizes).toEqual([200, 200, 1]);
  });

  it("splits sends by serialized UTF-8 body size", async () => {
    const bodies: string[] = [];
    const send = vi.fn(async (patches: Patch[]) => {
      bodies.push(JSON.stringify({ patches }));
      return accepted(patches);
    });
    const { queue } = makeQueue({ send });

    queue.enqueueMany([
      { key: "a", value: true, payload: "한".repeat(4_000) },
      { key: "b", value: true, payload: "나".repeat(4_000) },
      { key: "c", value: true, payload: "다".repeat(4_000) }
    ]);
    await vi.advanceTimersByTimeAsync(800);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(PATCH_QUEUE_MAX_BODY_BYTES);
    }
  });

  it("permanently rejects an individually oversized patch without sending or looping", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue, permanentFailures } = makeQueue({ send });
    queue.enqueue({ key: "huge", value: true, payload: "x".repeat(PATCH_QUEUE_MAX_BODY_BYTES) });

    await vi.advanceTimersByTimeAsync(800);
    await queue.flush();

    expect(send).not.toHaveBeenCalled();
    expect(permanentFailures).toEqual([
      expect.objectContaining({ type: "rejected", rejectedKeys: ["huge"] })
    ]);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("keeps two independent queue requests below 64 KiB combined", async () => {
    const bodyBytes: number[] = [];
    const sends: Array<ReturnType<typeof abortableDeferred<SendOutcome<string>>>> = [];
    const createQueue = () =>
      makeQueue({
        send: async (patches, context) => {
          bodyBytes.push(new TextEncoder().encode(JSON.stringify({ patches })).byteLength);
          const pending = abortableDeferred<SendOutcome<string>>(context!.signal);
          sends.push(pending);
          return pending.promise;
        }
      }).queue;
    const firstQueue = createQueue();
    const secondQueue = createQueue();

    firstQueue.enqueue({ key: "a", value: true, payload: "x".repeat(23_000) });
    secondQueue.enqueue({ key: "b", value: true, payload: "y".repeat(23_000) });
    await vi.advanceTimersByTimeAsync(800);

    expect(bodyBytes).toHaveLength(2);
    expect(bodyBytes.every((bytes) => bytes <= PATCH_QUEUE_MAX_BODY_BYTES)).toBe(true);
    expect(bodyBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(64 * 1024);
    firstQueue.dispose();
    secondQueue.dispose();
    await Promise.allSettled(sends.map(({ promise }) => promise));
  });

  it("aborts at the 10 second deadline before scheduling a retry", async () => {
    const signals: AbortSignal[] = [];
    const send = vi.fn(async (patches: Patch[], context) => {
      signals.push(context!.signal);
      if (send.mock.calls.length === 1) {
        return abortableDeferred<SendOutcome<string>>(context!.signal).promise;
      }
      return accepted(patches);
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_REQUEST_TIMEOUT_MS);
    expect(signals[0]?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses a portable queue timer when AbortSignal.timeout is unavailable", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("AbortSignal.timeout is unavailable");
    });
    const signals: AbortSignal[] = [];
    const send = vi.fn(async (_patches: Patch[], context) => {
      signals.push(context.signal);
      return abortableDeferred<SendOutcome<string>>(context.signal).promise;
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });

    const flushResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_REQUEST_TIMEOUT_MS);

    expect(await flushResult).toMatchObject({
      name: "ReliablePatchQueueFlushError",
      reason: "timeout",
      cause: expect.objectContaining({ name: "TimeoutError" })
    });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("rejects flush with the retry cause while pending work remains", async () => {
    const retryError = new Error("offline");
    const { queue } = makeQueue({
      send: async () => ({ type: "retry", error: retryError, retryAfterMs: null })
    });
    queue.enqueue({ key: "a", value: true });

    await expect(queue.flush()).rejects.toEqual(
      expect.objectContaining<Partial<ReliablePatchQueueFlushError>>({
        name: "ReliablePatchQueueFlushError",
        reason: "retry",
        cause: retryError
      })
    );
    expect(queue.getPendingSnapshot()).toEqual([{ key: "a", value: true }]);
  });

  it("rejects flush with the auth cause while preserving the overlay", async () => {
    const authError = new ApiClientError(401, "unauthorized", "Login required");
    const { queue } = makeQueue({
      send: async () => ({ type: "auth", error: authError })
    });
    queue.enqueue({ key: "a", value: true });

    await expect(queue.flush()).rejects.toEqual(
      expect.objectContaining<Partial<ReliablePatchQueueFlushError>>({
        name: "ReliablePatchQueueFlushError",
        reason: "auth",
        cause: authError
      })
    );
    expect(queue.getPendingSnapshot()).toEqual([{ key: "a", value: true }]);
  });

  it("bounds flush when send ignores abort and waits for that stale transport before retrying", async () => {
    const first = deferred<SendOutcome<string>>();
    const signals: AbortSignal[] = [];
    const send = vi.fn(async (patches: Patch[], context) => {
      signals.push(context!.signal);
      return send.mock.calls.length === 1 ? first.promise : accepted(patches);
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });

    const flushResult = queue.flush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_REQUEST_TIMEOUT_MS);

    expect(await flushResult).toEqual(
      expect.objectContaining<Partial<ReliablePatchQueueFlushError>>({
        name: "ReliablePatchQueueFlushError",
        reason: "timeout",
        cause: expect.objectContaining({ name: "TimeoutError" })
      })
    );
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);

    first.resolve(accepted([{ key: "a", value: true }]));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it.each(["focus", "online"] as const)(
    "latches %s while a timed-out transport is active and retries immediately after settlement",
    async (eventType) => {
      const first = deferred<SendOutcome<string>>();
      let activeSends = 0;
      let maximumActiveSends = 0;
      const send = vi.fn(async (patches: Patch[]) => {
        activeSends += 1;
        maximumActiveSends = Math.max(maximumActiveSends, activeSends);
        try {
          return send.mock.calls.length === 1 ? await first.promise : accepted(patches);
        } finally {
          activeSends -= 1;
        }
      });
      const { queue } = makeQueue({ send });
      queue.enqueue({ key: "a", value: true });
      await vi.advanceTimersByTimeAsync(
        PATCH_QUEUE_DEBOUNCE_MS + PATCH_QUEUE_REQUEST_TIMEOUT_MS
      );

      eventTarget.dispatchEvent(new Event(eventType));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledTimes(1);

      first.resolve(accepted([{ key: "a", value: true }]));
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      expect(maximumActiveSends).toBe(1);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("does not let a timed-out transport settlement schedule beside its replacement worker", async () => {
    const replacement = deferred<SendOutcome<string>>();
    const send = vi.fn((patches: Patch[], context) => {
      if (send.mock.calls.length === 1) {
        return abortableDeferred<SendOutcome<string>>(context.signal).promise;
      }
      if (send.mock.calls.length === 2) return replacement.promise;
      return Promise.resolve(accepted(patches));
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_DEBOUNCE_MS);

    queue.retry();
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_REQUEST_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(2);

    replacement.resolve(accepted([{ key: "a", value: true }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    queue.enqueue({ key: "b", value: false });
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_DEBOUNCE_MS - 1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("uses the 1/2/5/10/30 second retry sequence and caps there", async () => {
    const send = vi.fn(async (patches: Patch[]) =>
      send.mock.calls.length <= 6
        ? ({ type: "retry", error: new Error("offline"), retryAfterMs: null } as const)
        : accepted(patches)
    );
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    for (const [index, delay] of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(send).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(index + 2);
    }
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("honors finite Retry-After values without exceeding 30 seconds", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "retry", error: new Error("busy"), retryAfterMs: 60_000 })
      .mockResolvedValueOnce({ type: "retry", error: new Error("busy"), retryAfterMs: Number.NaN })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("resets retry backoff after an accepted send", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "retry", error: new Error("offline"), retryAfterMs: null })
      .mockImplementationOnce(async (patches) => accepted(patches))
      .mockResolvedValueOnce({ type: "retry", error: new Error("offline"), retryAfterMs: null })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue } = makeQueue({ send });

    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800 + 1_000);
    queue.enqueue({ key: "b", value: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it.each(["accepted", "rejected"] as const)(
    "resets retry backoff when a known stale generation is %s",
    async (staleOutcome) => {
      const staleAttempt = deferred<SendOutcome<string>>();
      const send = vi.fn(async (patches: Patch[]) => {
        switch (send.mock.calls.length) {
          case 1:
          case 2:
            return { type: "retry", error: new Error("offline"), retryAfterMs: null } as const;
          case 3:
            return staleAttempt.promise;
          case 4:
            return { type: "retry", error: new Error("offline again"), retryAfterMs: null } as const;
          default:
            return accepted(patches);
        }
      });
      const { queue } = makeQueue({ send });
      queue.enqueue({ key: "cell", value: true });

      await vi.advanceTimersByTimeAsync(800 + 1_000 + 2_000);
      expect(send).toHaveBeenCalledTimes(3);
      queue.enqueue({ key: "cell", value: false });
      staleAttempt.resolve(
        staleOutcome === "accepted"
          ? { type: "accepted", acknowledgedKeys: ["cell"] }
          : { type: "rejected", rejectedKeys: ["cell"], message: "Stale patch rejected" }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(999);
      expect(send).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(5);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("delivers accepted versions only after a known acknowledgment", async () => {
    const versions: BoardMutationVersions = {
      sheets: [{ id: "sheet-1", version: 7 }],
      manifestVersion: 3
    };
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "accepted", acknowledgedKeys: ["unknown"], versions })
      .mockResolvedValueOnce({ type: "accepted", acknowledgedKeys: ["a"], versions });
    const { queue, versionChanges } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });

    const firstFlush = queue.flush().catch((error: unknown) => error);
    expect(await firstFlush).toMatchObject({ reason: "non-progress" });
    expect(versionChanges).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(versionChanges).toEqual([versions]);
  });

  it("advances backoff for unknown and empty acknowledgments without resetting it", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "retry", error: new Error("offline"), retryAfterMs: null })
      .mockResolvedValueOnce({ type: "accepted", acknowledgedKeys: ["unknown"] })
      .mockResolvedValueOnce({ type: "accepted", acknowledgedKeys: [] })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800 + 1_000);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(4);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("backs off for empty and unknown rejected keys without reporting permanent failure", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "rejected", rejectedKeys: [], message: "No key" })
      .mockResolvedValueOnce({ type: "rejected", rejectedKeys: ["unknown"], message: "Wrong key" })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue, permanentFailures } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    expect(send).toHaveBeenCalledTimes(1);
    expect(permanentFailures).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 1_999);
    expect(send).toHaveBeenCalledTimes(2);
    expect(permanentFailures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("reports only rejected keys that match the sent chunk", async () => {
    const send = vi.fn(async () => ({
      type: "rejected" as const,
      rejectedKeys: ["a", "unknown"],
      message: "Invalid cell"
    }));
    const { queue, permanentFailures } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    expect(permanentFailures).toEqual([
      { type: "rejected", rejectedKeys: ["a"], message: "Invalid cell" }
    ]);
  });

  it("does not let enqueue bypass an in-flight request's Retry-After backoff", async () => {
    const first = deferred<SendOutcome<string>>();
    const send = vi.fn(async (patches: Patch[]) =>
      send.mock.calls.length === 1 ? first.promise : accepted(patches)
    );
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    queue.enqueue({ key: "b", value: false });
    await vi.advanceTimersByTimeAsync(100);
    first.resolve({ type: "retry", error: new Error("busy"), retryAfterMs: 10_000 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("preserves Retry-After when enqueue happens as the first debounce fires", async () => {
    const send = vi.fn(async (patches: Patch[]) =>
      send.mock.calls.length === 1
        ? ({ type: "retry", error: new Error("busy"), retryAfterMs: 10_000 } as const)
        : accepted(patches)
    );
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);
    queue.enqueue({ key: "b", value: false });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries immediately on focus or online without duplicate in-flight work", async () => {
    const retrySend = deferred<SendOutcome<string>>();
    const send = vi.fn(async (patches: Patch[]) => {
      if (send.mock.calls.length === 1) {
        return { type: "retry", error: new Error("offline"), retryAfterMs: null } as const;
      }
      return retrySend.promise;
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    eventTarget.dispatchEvent(new Event("focus"));
    eventTarget.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    retrySend.resolve(accepted([{ key: "a", value: true }]));
    await queue.flush();
  });

  it("consumes a latched immediate retry instead of leaving the worker's retry timer", async () => {
    const first = deferred<SendOutcome<string>>();
    let activeSends = 0;
    let maximumActiveSends = 0;
    const send = vi.fn(async (patches: Patch[]) => {
      activeSends += 1;
      maximumActiveSends = Math.max(maximumActiveSends, activeSends);
      try {
        return send.mock.calls.length === 1 ? await first.promise : accepted(patches);
      } finally {
        activeSends -= 1;
      }
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(PATCH_QUEUE_DEBOUNCE_MS);

    queue.retry();
    first.resolve({ type: "retry", error: new Error("busy"), retryAfterMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(maximumActiveSends).toBe(1);
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses automatic work on auth and resumes only through retry", async () => {
    const authError = new ApiClientError(401, "unauthorized", "Login required");
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "auth", error: authError })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue, authPauses, pendingChanges } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);

    queue.enqueue({ key: "b", value: false });
    eventTarget.dispatchEvent(new Event("focus"));
    eventTarget.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(authPauses).toEqual([authError]);
    expect(pendingChanges.at(-1)).toEqual([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);

    queue.retry();
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it.each(["synchronous", "microtask"] as const)(
    "honors a %s retry requested from onAuthPause immediately after the worker stops",
    async (retryTiming) => {
      let queue!: ReliablePatchQueue<Patch, string>;
      const authError = new ApiClientError(401, "unauthorized", "Login required");
      const send = vi
        .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
        .mockResolvedValueOnce({ type: "auth", error: authError })
        .mockImplementation(async (patches) => accepted(patches));
      ({ queue } = makeQueue({
        send,
        onAuthPause: () => {
          const retry = () => queue.retry();
          if (retryTiming === "synchronous") {
            retry();
            throw new Error("auth observer failed after retry");
          }
          queueMicrotask(retry);
        }
      }));
      queue.enqueue({ key: "a", value: true });

      await vi.advanceTimersByTimeAsync(800);
      expect(send).toHaveBeenCalledTimes(2);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("reconciles permanently rejected keys and reports the failure", async () => {
    const rejection: SendOutcome<string> = {
      type: "rejected",
      rejectedKeys: ["a"],
      message: "Invalid cell"
    };
    const sent: Patch[][] = [];
    const send = vi.fn(async (patches: Patch[]) => {
      sent.push(patches);
      return send.mock.calls.length === 1 ? rejection : accepted(patches);
    });
    const { queue, permanentFailures, pendingChanges } = makeQueue({ send });
    queue.enqueueMany([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);

    await vi.advanceTimersByTimeAsync(800);
    expect(permanentFailures).toEqual([rejection]);
    expect(sent).toEqual([
      [
        { key: "a", value: true },
        { key: "b", value: false }
      ],
      [{ key: "b", value: false }]
    ]);
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(pendingChanges.at(-1)).toEqual([]);
  });

  it("continues remaining work when onPermanentFailure throws", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "rejected", rejectedKeys: ["a"], message: "Invalid" })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue } = makeQueue({
      send,
      onPermanentFailure: () => {
        throw new Error("failure observer failed");
      }
    });
    queue.enqueueMany([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("continues remaining work when onVersions throws", async () => {
    const versions: BoardMutationVersions = { sheets: [{ id: "sheet-1", version: 2 }] };
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockResolvedValueOnce({ type: "accepted", acknowledgedKeys: ["a"], versions })
      .mockImplementation(async (patches) => accepted(patches));
    const { queue } = makeQueue({
      send,
      onVersions: () => {
        throw new Error("version observer failed");
      }
    });
    queue.enqueueMany([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it.each([
    [new Error("network"), "retry"],
    [new ApiClientError(401, "unauthorized", "no"), "auth"],
    [new ApiClientError(403, "forbidden", "no"), "auth"],
    [new ApiClientError(408, "timeout", "later"), "retry"],
    [new ApiClientError(429, "rate_limited", "later"), "retry"],
    [new ApiClientError(500, "internal", "later"), "retry"],
    [new ApiClientError(503, "unavailable", "later"), "retry"],
    [new ApiClientError(400, "bad_request", "bad"), "permanent"],
    [new ApiClientError(404, "not_found", "gone"), "permanent"],
    [new ApiClientError(422, "invalid", "bad"), "permanent"]
  ] as const)("classifies %# queue errors", (error, expected) => {
    expect(classifyQueueError(error)).toBe(expected);
  });

  it("classifies thrown retry, auth, and permanent errors inside the queue", async () => {
    const send = vi
      .fn<NonNullable<ReliablePatchQueueOptions<Patch, string>["send"]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiClientError(403, "forbidden", "Sign in again"))
      .mockRejectedValueOnce(new ApiClientError(422, "invalid", "Invalid patch"));
    const { queue, authPauses, permanentFailures } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800 + 1_000);
    expect(authPauses).toHaveLength(1);

    queue.retry();
    await queue.flush();
    expect(permanentFailures).toEqual([
      { type: "rejected", rejectedKeys: ["a"], message: "Invalid patch" }
    ]);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it.each(["retry", "rejected"] as const)(
    "keeps only a newer false value when an in-flight true value is %s",
    async (firstOutcome) => {
      const first = deferred<SendOutcome<string>>();
      const sent: Patch[][] = [];
      const send = vi.fn(async (patches: Patch[]) => {
        sent.push(patches);
        return send.mock.calls.length === 1 ? first.promise : accepted(patches);
      });
      const { queue, pendingChanges } = makeQueue({ send });
      queue.enqueue({ key: "cell", value: true });
      await vi.advanceTimersByTimeAsync(800);

      queue.enqueue({ key: "cell", value: false });
      const changesAfterNewerValue = pendingChanges.length;
      first.resolve(
        firstOutcome === "retry"
          ? { type: "retry", error: new Error("offline"), retryAfterMs: null }
          : { type: "rejected", rejectedKeys: ["cell"], message: "stale" }
      );
      await Promise.resolve();
      if (firstOutcome === "retry") await vi.advanceTimersByTimeAsync(1_000);
      await queue.flush();

      expect(sent).toEqual([
        [{ key: "cell", value: true }],
        [{ key: "cell", value: false }]
      ]);
      expect(pendingChanges.slice(changesAfterNewerValue)).not.toContainEqual([
        { key: "cell", value: true }
      ]);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("does not let an acknowledgment erase a newer structurally equal intent", async () => {
    const first = deferred<SendOutcome<string>>();
    const sent: Patch[][] = [];
    const send = vi.fn(async (patches: Patch[]) => {
      sent.push(patches);
      return send.mock.calls.length === 1 ? first.promise : accepted(patches);
    });
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "cell", value: true });
    await vi.advanceTimersByTimeAsync(800);
    queue.enqueue({ key: "cell", value: true });

    first.resolve({ type: "accepted", acknowledgedKeys: ["cell"] });
    await queue.flush();
    expect(sent).toEqual([
      [{ key: "cell", value: true }],
      [{ key: "cell", value: true }]
    ]);
  });

  it("coalesces structural object keys and reconciles deserialized acknowledgments", async () => {
    type ObjectKey = { tableId: string; rowItemId: string };
    interface ObjectPatch {
      key: ObjectKey;
      value: boolean;
    }
    const sent: ObjectPatch[][] = [];
    const queue = new ReliablePatchQueue<ObjectPatch, ObjectKey>({
      keyOf: (patch) => patch.key,
      serializeBody: (patches) => JSON.stringify({ patches }),
      send: async (patches) => {
        sent.push(patches);
        return {
          type: "accepted",
          acknowledgedKeys: JSON.parse(JSON.stringify(patches.map(({ key }) => key))) as ObjectKey[]
        };
      },
      onPendingChange: () => undefined,
      onPermanentFailure: () => undefined,
      onAuthPause: () => undefined
    });

    queue.enqueue({ key: { tableId: "table-1", rowItemId: "row-1" }, value: true });
    queue.enqueue({ key: { tableId: "table-2", rowItemId: "row-2" }, value: true });
    queue.enqueue({ key: { rowItemId: "row-1", tableId: "table-1" }, value: false });

    expect(queue.getPendingSnapshot()).toEqual([
      { key: { rowItemId: "row-1", tableId: "table-1" }, value: false },
      { key: { tableId: "table-2", rowItemId: "row-2" }, value: true }
    ]);
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(sent).toEqual([
      [
        { key: { rowItemId: "row-1", tableId: "table-1" }, value: false },
        { key: { tableId: "table-2", rowItemId: "row-2" }, value: true }
      ]
    ]);
  });

  it("reconciles a structural tuple key returned in a rejected outcome", async () => {
    type TupleKey = readonly [string, string, string];
    interface TuplePatch {
      key: TupleKey;
      value: boolean;
    }
    const permanentFailures: Array<Extract<SendOutcome<TupleKey>, { type: "rejected" }>> = [];
    const queue = new ReliablePatchQueue<TuplePatch, TupleKey>({
      keyOf: (patch) => patch.key,
      serializeBody: (patches) => JSON.stringify({ patches }),
      send: async () => ({
        type: "rejected",
        rejectedKeys: [JSON.parse('["table-1","row-1","column-1"]') as TupleKey],
        message: "Locked"
      }),
      onPendingChange: () => undefined,
      onPermanentFailure: (outcome) => permanentFailures.push(outcome),
      onAuthPause: () => undefined
    });
    const key = ["table-1", "row-1", "column-1"] as const;
    queue.enqueue({ key, value: true });

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(permanentFailures).toEqual([
      { type: "rejected", rejectedKeys: [key], message: "Locked" }
    ]);
  });

  it("rejects unsupported structural keys atomically", () => {
    interface UnknownKeyPatch {
      key: unknown;
      value: boolean;
    }
    const circularKey: Record<string, unknown> = {};
    circularKey.self = circularKey;
    const queue = new ReliablePatchQueue<UnknownKeyPatch, unknown>({
      keyOf: (patch) => patch.key,
      serializeBody: (patches) => JSON.stringify({ patches }),
      send: async () => ({ type: "accepted", acknowledgedKeys: [] }),
      onPendingChange: () => undefined,
      onPermanentFailure: () => undefined,
      onAuthPause: () => undefined
    });

    expect(() =>
      queue.enqueueMany([
        { key: { tableId: "valid" }, value: true },
        { key: circularKey, value: false }
      ])
    ).toThrowError(/reliable patch queue key/i);
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(() => queue.enqueue({ key: () => "unsupported", value: true })).toThrowError(
      /reliable patch queue key/i
    );
    const sparseKey: unknown[] = [];
    sparseKey.length = 1;
    expect(() => queue.enqueue({ key: sparseKey, value: true })).toThrowError(
      /reliable patch queue key/i
    );
  });

  it("returns the latest pending snapshot on dispose, clears work, and aborts safely", async () => {
    const removeSpy = vi.spyOn(eventTarget, "removeEventListener");
    let activeSignal: AbortSignal | undefined;
    const send = vi.fn(async (_patches: Patch[], context) => {
      activeSignal = context!.signal;
      return abortableDeferred<SendOutcome<string>>(context!.signal).promise;
    });
    const { queue, pendingChanges } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });
    await vi.advanceTimersByTimeAsync(800);
    queue.enqueue({ key: "a", value: false });
    queue.enqueue({ key: "b", value: true });

    const snapshot = queue.dispose();
    expect(snapshot).toEqual([
      { key: "a", value: false },
      { key: "b", value: true }
    ]);
    expect(activeSignal?.aborted).toBe(true);
    expect(pendingChanges.at(-1)).toEqual(snapshot);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    eventTarget.dispatchEvent(new Event("focus"));
    eventTarget.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns unsent work when disposed during debounce", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue } = makeQueue({ send });
    queue.enqueue({ key: "a", value: true });

    expect(queue.dispose()).toEqual([{ key: "a", value: true }]);
    await vi.advanceTimersByTimeAsync(800);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["auth", "rejected"] as const)(
    "invalidates a late %s outcome after discard while keeping new work usable",
    async (lateOutcome) => {
      const first = deferred<SendOutcome<string>>();
      let activeSignal: AbortSignal | undefined;
      const send = vi.fn(async (patches: Patch[], context) => {
        activeSignal = context!.signal;
        return send.mock.calls.length === 1 ? first.promise : accepted(patches);
      });
      const { queue, authPauses, permanentFailures } = makeQueue({ send });
      queue.enqueue({ key: "a", value: true });
      await vi.advanceTimersByTimeAsync(800);

      expect(queue.discard()).toEqual([{ key: "a", value: true }]);
      expect(activeSignal?.aborted).toBe(true);
      queue.enqueue({ key: "b", value: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledTimes(1);

      first.resolve(
        lateOutcome === "auth"
          ? {
              type: "auth",
              error: new ApiClientError(401, "unauthorized", "Old session")
            }
          : { type: "rejected", rejectedKeys: ["a"], message: "Old patch" }
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(authPauses).toEqual([]);
      expect(permanentFailures).toEqual([]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(queue.getPendingSnapshot()).toEqual([]);
    }
  );

  it("isolates a serializeBody exception as a permanent entry failure", async () => {
    const serializationError = new Error("Cannot serialize bad patch");
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue, permanentFailures } = makeQueue({
      serializeBody: (patches) => {
        if (patches.some(({ key }) => key === "bad")) throw serializationError;
        return JSON.stringify({ patches });
      },
      send
    });
    queue.enqueueMany([
      { key: "bad", value: true },
      { key: "good", value: false }
    ]);

    await expect(queue.flush()).resolves.toBeUndefined();
    expect(permanentFailures).toEqual([
      {
        type: "rejected",
        rejectedKeys: ["bad"],
        message: "Cannot serialize bad patch"
      }
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual([{ key: "good", value: false }]);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("turns an unexpected internal worker failure into a bounded retry", async () => {
    let serializationCalls = 0;
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue } = makeQueue({
      serializeBody: (patches) => {
        serializationCalls += 1;
        if (serializationCalls === 1) return Symbol("invalid body") as unknown as string;
        return JSON.stringify({ patches });
      },
      send
    });
    queue.enqueue({ key: "a", value: true });

    await vi.advanceTimersByTimeAsync(800);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPendingSnapshot()).toEqual([]);
  });

  it("discards pending values only through the explicit discard method", async () => {
    const send = vi.fn(async (patches: Patch[]) => accepted(patches));
    const { queue, pendingChanges } = makeQueue({ send });
    queue.enqueueMany([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);

    expect(queue.discard()).toEqual([
      { key: "a", value: true },
      { key: "b", value: false }
    ]);
    expect(queue.getPendingSnapshot()).toEqual([]);
    expect(pendingChanges.at(-1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(send).not.toHaveBeenCalled();
  });
});
