import { ApiClientError } from "../../api/client";
import type { BoardMutationVersions } from "./types";

export const PATCH_QUEUE_DEBOUNCE_MS = 800;
export const PATCH_QUEUE_MAX_ITEMS = 200;
export const PATCH_QUEUE_MAX_BODY_BYTES = 24 * 1024;
export const PATCH_QUEUE_REQUEST_TIMEOUT_MS = 10_000;
export const PATCH_QUEUE_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type SendOutcome<K> =
  | { type: "accepted"; acknowledgedKeys: K[]; versions?: BoardMutationVersions }
  | { type: "rejected"; rejectedKeys: K[]; message: string }
  | { type: "auth"; error: ApiClientError }
  | { type: "retry"; error: unknown; retryAfterMs: number | null };

export interface ReliablePatchQueueSendContext {
  signal: AbortSignal;
}

export type ReliablePatchQueueFlushErrorReason =
  | "retry"
  | "auth"
  | "timeout"
  | "non-progress"
  | "disposed";

export class ReliablePatchQueueFlushError extends Error {
  readonly cause: unknown;

  constructor(
    public readonly reason: ReliablePatchQueueFlushErrorReason,
    cause?: unknown
  ) {
    super(`Reliable patch queue flush stopped: ${reason}`);
    this.name = "ReliablePatchQueueFlushError";
    this.cause = cause;
  }
}

export interface ReliablePatchQueueOptions<T, K> {
  keyOf: (patch: T) => K;
  serializeBody: (patches: T[]) => string;
  send: (patches: T[], context: ReliablePatchQueueSendContext) => Promise<SendOutcome<K>>;
  onPendingChange: (patches: T[]) => void;
  onPermanentFailure: (outcome: Extract<SendOutcome<K>, { type: "rejected" }>) => void;
  onAuthPause: (error: ApiClientError) => void;
  onAccepted?: (
    patches: T[],
    outcome: Extract<SendOutcome<K>, { type: "accepted" }>
  ) => void;
  onVersions?: (versions: BoardMutationVersions) => void;
}

interface PendingEntry<T, K> {
  key: K;
  keyId: string;
  patch: T;
  generation: number;
  serializedValue: string | null;
}

interface SendChunk<T, K> {
  entries: Array<PendingEntry<T, K>>;
  oversized: PendingEntry<T, K> | null;
  serializationFailure: { entry: PendingEntry<T, K>; error: unknown } | null;
}

interface DrainResult {
  reason: ReliablePatchQueueFlushErrorReason | null;
  cause: unknown;
}

interface DrainControl {
  continue: boolean;
  result: DrainResult;
}

interface ActiveTransport {
  epoch: number;
  lifecycleEpoch: number;
  controller: AbortController;
  timedOut: boolean;
  timeoutCause: unknown;
}

type TransportResult<K> =
  | { type: "outcome"; outcome: SendOutcome<K> }
  | { type: "error"; error: unknown }
  | { type: "timeout"; cause: unknown };

type QueueErrorClassification = "auth" | "retry" | "permanent";

const textEncoder = new TextEncoder();

function canonicalKeyId(value: unknown): string {
  const ancestors = new Set<object>();
  const unsupported = (): never => {
    throw new TypeError(
      "A reliable patch queue key must be a finite JSON value without unsupported types or cycles"
    );
  };

  const encode = (nestedValue: unknown): string => {
    if (nestedValue === null) return "null";
    switch (typeof nestedValue) {
      case "string":
        return `string:${JSON.stringify(nestedValue)}`;
      case "boolean":
        return `boolean:${nestedValue}`;
      case "number":
        if (!Number.isFinite(nestedValue)) return unsupported();
        return `number:${Object.is(nestedValue, -0) ? 0 : nestedValue}`;
      case "object": {
        if (ancestors.has(nestedValue)) return unsupported();
        ancestors.add(nestedValue);
        try {
          if (Array.isArray(nestedValue)) {
            for (let index = 0; index < nestedValue.length; index += 1) {
              if (!Object.hasOwn(nestedValue, index)) return unsupported();
            }
            return `array:[${nestedValue.map(encode).join(",")}]`;
          }
          const prototype = Object.getPrototypeOf(nestedValue);
          if (
            (prototype !== Object.prototype && prototype !== null) ||
            Object.getOwnPropertySymbols(nestedValue).length > 0
          ) {
            return unsupported();
          }
          const record = nestedValue as Record<string, unknown>;
          return `object:{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
            .join(",")}}`;
        } finally {
          ancestors.delete(nestedValue);
        }
      }
      default:
        return unsupported();
    }
  };

  return encode(value);
}

function stableSerialize(value: unknown): string | null {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue !== "object" || nestedValue === null) return nestedValue;
      if (seen.has(nestedValue)) throw new TypeError("Circular value");
      seen.add(nestedValue);
      if (Array.isArray(nestedValue)) return nestedValue;

      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      );
    });
  } catch {
    return null;
  }
}

function valuesEqual<T>(current: PendingEntry<T, unknown>, sent: PendingEntry<T, unknown>): boolean {
  if (current.patch === sent.patch) return true;
  return current.serializedValue !== null && current.serializedValue === sent.serializedValue;
}

export function classifyQueueError(error: unknown): QueueErrorClassification {
  if (!(error instanceof ApiClientError)) return "retry";
  if (error.status === 401 || error.status === 403) return "auth";
  if (error.status === 408 || error.status === 429 || error.status >= 500) return "retry";
  return "permanent";
}

export class ReliablePatchQueue<T, K> {
  private readonly pending = new Map<string, PendingEntry<T, K>>();
  private readonly eventTarget: EventTarget | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private worker: Promise<DrainResult> | null = null;
  private activeTransport: ActiveTransport | null = null;
  private generation = 0;
  private transportEpoch = 0;
  private lifecycleEpoch = 0;
  private retryIndex = 0;
  private authPaused = false;
  private lastAuthError: ApiClientError | null = null;
  private immediateWakeRequested = false;
  private disposed = false;

  private readonly handleImmediateRetry = () => {
    if (this.authPaused) return;
    if (this.worker !== null || this.activeTransport !== null) {
      this.immediateWakeRequested = true;
      return;
    }
    void this.startWorker();
  };

  constructor(private readonly options: ReliablePatchQueueOptions<T, K>) {
    this.eventTarget = typeof window === "undefined" ? null : window;
    this.eventTarget?.addEventListener("focus", this.handleImmediateRetry);
    this.eventTarget?.addEventListener("online", this.handleImmediateRetry);
  }

  enqueue(patch: T): void {
    if (this.disposed) throw new Error("Cannot enqueue into a disposed reliable patch queue");

    const entry = this.createEntry(patch);
    this.pending.set(entry.keyId, entry);
    this.notifyPendingChange();
    this.scheduleAfterEnqueue();
  }

  enqueueMany(patches: T[]): void {
    if (this.disposed) throw new Error("Cannot enqueue into a disposed reliable patch queue");
    if (patches.length === 0) return;

    const entries = patches.map((patch) => this.createEntry(patch));
    for (const entry of entries) this.pending.set(entry.keyId, entry);
    this.notifyPendingChange();
    this.scheduleAfterEnqueue();
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (this.disposed) throw new ReliablePatchQueueFlushError("disposed");
    if (this.authPaused) throw new ReliablePatchQueueFlushError("auth", this.lastAuthError);

    const result = await this.startWorker();
    if (this.pending.size > 0) {
      throw new ReliablePatchQueueFlushError(result.reason ?? "non-progress", result.cause);
    }
  }

  retry(): void {
    if (this.disposed) return;
    this.authPaused = false;
    this.lastAuthError = null;
    if (this.worker !== null || this.activeTransport !== null) {
      this.immediateWakeRequested = true;
      return;
    }
    this.immediateWakeRequested = false;
    void this.startWorker();
  }

  getPendingSnapshot(): T[] {
    return Array.from(this.pending.values(), ({ patch }) => patch);
  }

  discard(): T[] {
    const discarded = this.getPendingSnapshot();
    this.lifecycleEpoch += 1;
    this.activeTransport?.controller.abort(new DOMException("Queue discarded", "AbortError"));
    this.clearTimers();
    this.pending.clear();
    this.authPaused = false;
    this.lastAuthError = null;
    this.retryIndex = 0;
    this.immediateWakeRequested = false;
    this.notifyPendingChange();
    return discarded;
  }

  dispose(): T[] {
    const snapshot = this.getPendingSnapshot();
    if (this.disposed) return snapshot;

    this.disposed = true;
    this.immediateWakeRequested = false;
    this.lifecycleEpoch += 1;
    this.clearTimers();
    this.eventTarget?.removeEventListener("focus", this.handleImmediateRetry);
    this.eventTarget?.removeEventListener("online", this.handleImmediateRetry);
    this.activeTransport?.controller.abort(new DOMException("Queue disposed", "AbortError"));
    return snapshot;
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startWorker();
    }, PATCH_QUEUE_DEBOUNCE_MS);
  }

  private startWorker(): Promise<DrainResult> {
    if (this.disposed) return Promise.resolve(this.stopResult("disposed"));
    if (this.authPaused) return Promise.resolve(this.stopResult("auth", this.lastAuthError));
    if (this.pending.size === 0) return Promise.resolve(this.completeResult());
    if (this.worker !== null) return this.worker;
    this.clearTimers();
    if (this.activeTransport !== null) {
      return Promise.resolve(
        this.activeTransport.timedOut
          ? this.stopResult("timeout", this.activeTransport.timeoutCause)
          : this.stopResult("non-progress")
      );
    }

    let worker!: Promise<DrainResult>;
    worker = Promise.resolve()
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.scheduleRetry(this.retryAfterFrom(null, error));
        return this.stopResult("retry", error);
      })
      .finally(() => this.finishWorker(worker));
    this.worker = worker;
    return worker;
  }

  private finishWorker(worker: Promise<DrainResult>): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.pending.size === 0) {
      this.immediateWakeRequested = false;
      return;
    }
    if (this.disposed || this.authPaused || this.activeTransport !== null) return;
    if (this.immediateWakeRequested) {
      this.immediateWakeRequested = false;
      this.clearTimers();
      void this.startWorker();
      return;
    }
    if (this.retryTimer === null && this.debounceTimer === null) this.scheduleDebounce();
  }

  private async drain(): Promise<DrainResult> {
    while (!this.disposed && !this.authPaused && this.pending.size > 0) {
      const chunk = this.buildChunk();
      if (chunk.serializationFailure !== null) {
        const { entry, error } = chunk.serializationFailure;
        this.rejectEntries(
          [entry],
          [entry.key],
          error instanceof Error ? error.message : "Patch body serialization failed"
        );
        continue;
      }
      if (chunk.oversized !== null) {
        this.rejectEntries(
          [chunk.oversized],
          [chunk.oversized.key],
          `Serialized patch exceeds ${PATCH_QUEUE_MAX_BODY_BYTES} bytes`
        );
        continue;
      }
      if (chunk.entries.length === 0) return this.stopResult("non-progress");

      const control = await this.sendChunk(chunk.entries);
      if (!control.continue) return control.result;
    }
    return this.completeResult();
  }

  private buildChunk(): SendChunk<T, K> {
    const entries: Array<PendingEntry<T, K>> = [];

    for (const entry of this.pending.values()) {
      if (entries.length >= PATCH_QUEUE_MAX_ITEMS) break;
      const candidate = [...entries, entry];
      let body: string;
      try {
        body = this.options.serializeBody(candidate.map(({ patch }) => patch));
      } catch (error) {
        if (entries.length > 0) break;
        return {
          entries: [],
          oversized: null,
          serializationFailure: { entry, error }
        };
      }
      if (textEncoder.encode(body).byteLength <= PATCH_QUEUE_MAX_BODY_BYTES) {
        entries.push(entry);
        continue;
      }
      if (entries.length === 0) {
        return { entries: [], oversized: entry, serializationFailure: null };
      }
      break;
    }

    return { entries, oversized: null, serializationFailure: null };
  }

  private async sendChunk(entries: Array<PendingEntry<T, K>>): Promise<DrainControl> {
    const controller = new AbortController();
    const transport: ActiveTransport = {
      epoch: ++this.transportEpoch,
      lifecycleEpoch: this.lifecycleEpoch,
      controller,
      timedOut: false,
      timeoutCause: undefined
    };
    this.activeTransport = transport;

    let rawTransport: Promise<SendOutcome<K>>;
    try {
      rawTransport = Promise.resolve(
        this.options.send(
          entries.map(({ patch }) => patch),
          { signal: controller.signal }
        )
      );
    } catch (error) {
      rawTransport = Promise.reject(error);
    }

    const transportResult: Promise<TransportResult<K>> = rawTransport.then(
      (outcome) => ({ type: "outcome", outcome }),
      (error: unknown) => ({ type: "error", error })
    );
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlineResult = new Promise<TransportResult<K>>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        const cause = new DOMException(
          `Patch request exceeded ${PATCH_QUEUE_REQUEST_TIMEOUT_MS} ms`,
          "TimeoutError"
        );
        transport.timedOut = true;
        transport.timeoutCause = cause;
        controller.abort(cause);
        resolve({ type: "timeout", cause });
      }, PATCH_QUEUE_REQUEST_TIMEOUT_MS);
    });
    const racedResult = Promise.race([transportResult, deadlineResult]);
    void transportResult.then(() => this.handleTransportSettled(transport));

    try {
      const result = await racedResult;
      if (result.type === "timeout") {
        return { continue: false, result: this.stopResult("timeout", result.cause) };
      }
      if (this.disposed || transport.lifecycleEpoch !== this.lifecycleEpoch || transport.timedOut) {
        return { continue: false, result: this.completeResult() };
      }
      if (result.type === "outcome") return this.handleOutcome(entries, result.outcome);
      return this.handleThrownError(entries, result.error);
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    }
  }

  private handleOutcome(entries: Array<PendingEntry<T, K>>, outcome: SendOutcome<K>): DrainControl {
    switch (outcome.type) {
      case "accepted": {
        const acknowledged = this.canonicalKeyIds(outcome.acknowledgedKeys);
        const acknowledgedEntries = entries.filter(({ keyId }) => acknowledged.has(keyId));
        if (acknowledgedEntries.length === 0 && entries.length > 0) {
          this.scheduleRetry(null);
          return { continue: false, result: this.stopResult("non-progress", outcome) };
        }
        this.invokeObserver(
          this.options.onAccepted,
          acknowledgedEntries.map(({ patch }) => patch),
          outcome
        );
        this.reconcileEntries(acknowledgedEntries);
        this.retryIndex = 0;
        if (outcome.versions !== undefined) {
          this.invokeObserver(this.options.onVersions, outcome.versions);
        }
        return { continue: true, result: this.completeResult() };
      }
      case "rejected": {
        const rejected = this.canonicalKeyIds(outcome.rejectedKeys);
        const rejectedEntries = entries.filter(({ keyId }) => rejected.has(keyId));
        if (rejectedEntries.length === 0) {
          this.scheduleRetry(null);
          return { continue: false, result: this.stopResult("non-progress", outcome) };
        }
        this.rejectEntries(
          rejectedEntries,
          rejectedEntries.map(({ key }) => key),
          outcome.message
        );
        this.retryIndex = 0;
        return { continue: true, result: this.completeResult() };
      }
      case "auth":
        this.authPaused = true;
        this.lastAuthError = outcome.error;
        this.invokeObserver(this.options.onAuthPause, outcome.error);
        return { continue: false, result: this.stopResult("auth", outcome.error) };
      case "retry":
        this.scheduleRetry(this.retryAfterFrom(outcome.retryAfterMs, outcome.error));
        return { continue: false, result: this.stopResult("retry", outcome.error) };
    }
  }

  private handleThrownError(entries: Array<PendingEntry<T, K>>, error: unknown): DrainControl {
    switch (classifyQueueError(error)) {
      case "auth":
        this.authPaused = true;
        this.lastAuthError = error as ApiClientError;
        this.invokeObserver(this.options.onAuthPause, error as ApiClientError);
        return { continue: false, result: this.stopResult("auth", error) };
      case "retry":
        this.scheduleRetry(this.retryAfterFrom(null, error));
        return { continue: false, result: this.stopResult("retry", error) };
      case "permanent":
        this.retryIndex = 0;
        this.rejectEntries(
          entries,
          entries.map(({ key }) => key),
          error instanceof Error ? error.message : "Patch send failed permanently"
        );
        return { continue: true, result: this.completeResult() };
    }
  }

  private handleTransportSettled(transport: ActiveTransport): void {
    if (this.activeTransport?.epoch === transport.epoch) this.activeTransport = null;
    if (
      this.disposed ||
      (!transport.timedOut && transport.lifecycleEpoch === this.lifecycleEpoch)
    ) {
      return;
    }

    const continueAfterWorker = () => {
      if (this.disposed || this.pending.size === 0) return;
      if (this.worker !== null || this.activeTransport !== null) return;
      if (this.immediateWakeRequested && !this.authPaused) {
        this.immediateWakeRequested = false;
        void this.startWorker();
        return;
      }
      if (transport.lifecycleEpoch !== this.lifecycleEpoch) {
        if (!this.authPaused) void this.startWorker();
        return;
      }
      this.scheduleRetry(null);
    };
    const worker = this.worker;
    if (worker === null) {
      continueAfterWorker();
    } else {
      void worker.then(continueAfterWorker);
    }
  }

  private rejectEntries(entries: Array<PendingEntry<T, K>>, rejectedKeys: K[], message: string): number {
    const reconciledCount = this.reconcileEntries(entries);
    this.invokeObserver(this.options.onPermanentFailure, { type: "rejected", rejectedKeys, message });
    return reconciledCount;
  }

  private reconcileEntries(entries: Array<PendingEntry<T, K>>): number {
    let reconciledCount = 0;
    for (const sent of entries) {
      const current = this.pending.get(sent.keyId);
      if (
        current !== undefined &&
        current.generation === sent.generation &&
        valuesEqual(current, sent)
      ) {
        this.pending.delete(sent.keyId);
        reconciledCount += 1;
      }
    }
    if (reconciledCount > 0) this.notifyPendingChange();
    return reconciledCount;
  }

  private scheduleRetry(retryAfterMs: number | null): void {
    if (this.disposed || this.authPaused || this.pending.size === 0) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);

    const retryDelay =
      PATCH_QUEUE_RETRY_MS[Math.min(this.retryIndex, PATCH_QUEUE_RETRY_MS.length - 1)] ??
      PATCH_QUEUE_RETRY_MS.at(-1)!;
    this.retryIndex = Math.min(this.retryIndex + 1, PATCH_QUEUE_RETRY_MS.length - 1);
    const safeRetryAfter =
      retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : 0;
    const delay = Math.min(
      PATCH_QUEUE_RETRY_MS.at(-1)!,
      Math.max(retryDelay, safeRetryAfter)
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startWorker();
    }, delay);
  }

  private retryAfterFrom(explicitRetryAfterMs: number | null, error: unknown): number | null {
    if (explicitRetryAfterMs !== null) return explicitRetryAfterMs;
    return error instanceof ApiClientError ? error.retryAfterMs : null;
  }

  private notifyPendingChange(): void {
    this.invokeObserver(this.options.onPendingChange, this.getPendingSnapshot());
  }

  private invokeObserver<A extends unknown[]>(
    observer: ((...args: A) => void) | undefined,
    ...args: A
  ): void {
    if (observer === undefined) return;
    try {
      const result = (observer as (...observerArgs: A) => unknown)(...args);
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Observer failures must not affect queue state or scheduling.
    }
  }

  private createEntry(patch: T): PendingEntry<T, K> {
    const key = this.options.keyOf(patch);
    return {
      key,
      keyId: canonicalKeyId(key),
      patch,
      generation: ++this.generation,
      serializedValue: stableSerialize(patch)
    };
  }

  private canonicalKeyIds(keys: K[]): Set<string> {
    const keyIds = new Set<string>();
    for (const key of keys) {
      try {
        keyIds.add(canonicalKeyId(key));
      } catch {
        // Unsupported server keys cannot acknowledge or reject a queued JSON key.
      }
    }
    return keyIds;
  }

  private scheduleAfterEnqueue(): void {
    if (
      this.disposed ||
      this.pending.size === 0 ||
      this.authPaused ||
      this.worker !== null ||
      this.activeTransport !== null ||
      this.retryTimer !== null
    ) {
      return;
    }
    this.scheduleDebounce();
  }

  private completeResult(): DrainResult {
    return { reason: null, cause: undefined };
  }

  private stopResult(reason: ReliablePatchQueueFlushErrorReason, cause?: unknown): DrainResult {
    return { reason, cause };
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.retryTimer = null;
  }
}
