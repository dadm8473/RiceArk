import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../api/client";
import {
  PATCH_QUEUE_DEBOUNCE_MS,
  PATCH_QUEUE_MAX_BODY_BYTES,
  PATCH_QUEUE_MAX_ITEMS,
  PATCH_QUEUE_REQUEST_TIMEOUT_MS,
  PATCH_QUEUE_RETRY_MS,
  ReliablePatchQueue,
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
  const options: ReliablePatchQueueOptions<Patch, string> = {
    keyOf: (patch) => patch.key,
    serializeBody: (patches) => JSON.stringify({ patches }),
    send: async (patches) => accepted(patches),
    onPendingChange: (patches) => pendingChanges.push(patches),
    onPermanentFailure: (outcome) => permanentFailures.push(outcome),
    onAuthPause: (error) => authPauses.push(error),
    ...overrides
  };

  return {
    queue: new ReliablePatchQueue(options),
    pendingChanges,
    permanentFailures,
    authPauses
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
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    });
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
    expect(timeoutSpy).toHaveBeenCalledWith(PATCH_QUEUE_REQUEST_TIMEOUT_MS);
    expect(signals[0]?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
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
