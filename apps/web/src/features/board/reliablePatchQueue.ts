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

export interface ReliablePatchQueueOptions<T, K> {
  keyOf: (patch: T) => K;
  serializeBody: (patches: T[]) => string;
  send: (patches: T[], context?: ReliablePatchQueueSendContext) => Promise<SendOutcome<K>>;
  onPendingChange: (patches: T[]) => void;
  onPermanentFailure: (outcome: Extract<SendOutcome<K>, { type: "rejected" }>) => void;
  onAuthPause: (error: ApiClientError) => void;
}

interface PendingEntry<T, K> {
  key: K;
  patch: T;
  generation: number;
  serializedValue: string | null;
}

interface SendChunk<T, K> {
  entries: Array<PendingEntry<T, K>>;
  oversized: PendingEntry<T, K> | null;
}

type QueueErrorClassification = "auth" | "retry" | "permanent";

const textEncoder = new TextEncoder();

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
  private readonly pending = new Map<K, PendingEntry<T, K>>();
  private readonly eventTarget: EventTarget | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private worker: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private generation = 0;
  private retryIndex = 0;
  private authPaused = false;
  private disposed = false;

  private readonly handleImmediateRetry = () => {
    if (this.authPaused) return;
    void this.startWorker();
  };

  constructor(private readonly options: ReliablePatchQueueOptions<T, K>) {
    this.eventTarget = typeof window === "undefined" ? null : window;
    this.eventTarget?.addEventListener("focus", this.handleImmediateRetry);
    this.eventTarget?.addEventListener("online", this.handleImmediateRetry);
  }

  enqueue(patch: T): void {
    if (this.disposed) throw new Error("Cannot enqueue into a disposed reliable patch queue");

    const key = this.options.keyOf(patch);
    this.pending.set(key, {
      key,
      patch,
      generation: ++this.generation,
      serializedValue: stableSerialize(patch)
    });
    this.notifyPendingChange();
    if (!this.authPaused) this.scheduleDebounce();
  }

  enqueueMany(patches: T[]): void {
    if (this.disposed) throw new Error("Cannot enqueue into a disposed reliable patch queue");
    if (patches.length === 0) return;

    for (const patch of patches) {
      const key = this.options.keyOf(patch);
      this.pending.set(key, {
        key,
        patch,
        generation: ++this.generation,
        serializedValue: stableSerialize(patch)
      });
    }
    this.notifyPendingChange();
    if (!this.authPaused) this.scheduleDebounce();
  }

  async flush(): Promise<void> {
    await this.startWorker();
  }

  retry(): void {
    if (this.disposed) return;
    this.authPaused = false;
    void this.startWorker();
  }

  getPendingSnapshot(): T[] {
    return Array.from(this.pending.values(), ({ patch }) => patch);
  }

  discard(): T[] {
    const discarded = this.getPendingSnapshot();
    this.clearTimers();
    this.pending.clear();
    this.authPaused = false;
    this.retryIndex = 0;
    this.notifyPendingChange();
    return discarded;
  }

  dispose(): T[] {
    const snapshot = this.getPendingSnapshot();
    if (this.disposed) return snapshot;

    this.disposed = true;
    this.clearTimers();
    this.eventTarget?.removeEventListener("focus", this.handleImmediateRetry);
    this.eventTarget?.removeEventListener("online", this.handleImmediateRetry);
    this.activeController?.abort(new DOMException("Queue disposed", "AbortError"));
    return snapshot;
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.startWorker();
    }, PATCH_QUEUE_DEBOUNCE_MS);
  }

  private async startWorker(): Promise<void> {
    if (this.disposed || this.authPaused || this.pending.size === 0) return;
    this.clearTimers();
    if (this.worker !== null) return this.worker;

    const worker = this.drain().finally(() => {
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && !this.authPaused && this.pending.size > 0) {
      const chunk = this.buildChunk();
      if (chunk.oversized !== null) {
        this.rejectEntries(
          [chunk.oversized],
          [chunk.oversized.key],
          `Serialized patch exceeds ${PATCH_QUEUE_MAX_BODY_BYTES} bytes`
        );
        continue;
      }
      if (chunk.entries.length === 0) return;

      const shouldContinue = await this.sendChunk(chunk.entries);
      if (!shouldContinue) return;
    }
  }

  private buildChunk(): SendChunk<T, K> {
    const entries: Array<PendingEntry<T, K>> = [];

    for (const entry of this.pending.values()) {
      if (entries.length >= PATCH_QUEUE_MAX_ITEMS) break;
      const candidate = [...entries, entry];
      const body = this.options.serializeBody(candidate.map(({ patch }) => patch));
      if (textEncoder.encode(body).byteLength <= PATCH_QUEUE_MAX_BODY_BYTES) {
        entries.push(entry);
        continue;
      }
      if (entries.length === 0) return { entries: [], oversized: entry };
      break;
    }

    return { entries, oversized: null };
  }

  private async sendChunk(entries: Array<PendingEntry<T, K>>): Promise<boolean> {
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(PATCH_QUEUE_REQUEST_TIMEOUT_MS);
    const handleTimeout = () => controller.abort(timeoutSignal.reason);
    timeoutSignal.addEventListener("abort", handleTimeout, { once: true });
    this.activeController = controller;

    try {
      const outcome = await this.options.send(
        entries.map(({ patch }) => patch),
        { signal: controller.signal }
      );
      if (this.disposed) return false;
      return this.handleOutcome(entries, outcome);
    } catch (error) {
      if (this.disposed) return false;
      return this.handleThrownError(entries, error);
    } finally {
      timeoutSignal.removeEventListener("abort", handleTimeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private handleOutcome(entries: Array<PendingEntry<T, K>>, outcome: SendOutcome<K>): boolean {
    switch (outcome.type) {
      case "accepted": {
        this.retryIndex = 0;
        const acknowledged = new Set(outcome.acknowledgedKeys);
        const acknowledgedEntries = entries.filter(({ key }) => acknowledged.has(key));
        this.reconcileEntries(acknowledgedEntries);
        if (acknowledgedEntries.length === 0 && entries.length > 0) {
          this.scheduleRetry(null);
          return false;
        }
        return true;
      }
      case "rejected":
        this.retryIndex = 0;
        this.rejectEntries(entries, outcome.rejectedKeys, outcome.message);
        return true;
      case "auth":
        this.authPaused = true;
        this.options.onAuthPause(outcome.error);
        return false;
      case "retry":
        this.scheduleRetry(this.retryAfterFrom(outcome.retryAfterMs, outcome.error));
        return false;
    }
  }

  private handleThrownError(entries: Array<PendingEntry<T, K>>, error: unknown): boolean {
    switch (classifyQueueError(error)) {
      case "auth":
        this.authPaused = true;
        this.options.onAuthPause(error as ApiClientError);
        return false;
      case "retry":
        this.scheduleRetry(this.retryAfterFrom(null, error));
        return false;
      case "permanent":
        this.retryIndex = 0;
        this.rejectEntries(
          entries,
          entries.map(({ key }) => key),
          error instanceof Error ? error.message : "Patch send failed permanently"
        );
        return true;
    }
  }

  private rejectEntries(entries: Array<PendingEntry<T, K>>, rejectedKeys: K[], message: string): void {
    const rejected = new Set(rejectedKeys);
    this.reconcileEntries(entries.filter(({ key }) => rejected.has(key)));
    this.options.onPermanentFailure({ type: "rejected", rejectedKeys, message });
  }

  private reconcileEntries(entries: Array<PendingEntry<T, K>>): boolean {
    let changed = false;
    for (const sent of entries) {
      const current = this.pending.get(sent.key);
      if (
        current !== undefined &&
        current.generation === sent.generation &&
        valuesEqual(current, sent)
      ) {
        this.pending.delete(sent.key);
        changed = true;
      }
    }
    if (changed) this.notifyPendingChange();
    return changed;
  }

  private scheduleRetry(retryAfterMs: number | null): void {
    if (this.disposed || this.authPaused || this.pending.size === 0) return;
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
    this.options.onPendingChange(this.getPendingSnapshot());
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.retryTimer = null;
  }
}
