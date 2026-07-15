import { useEffect, useMemo, useRef } from "react";
import { ApiClientError, apiPatch, type ApiRequestOptions } from "../../api/client";
import type { BoardMutationVersions } from "./types";
import type { BoardCompletionPatch } from "./completions";
import {
  ReliablePatchQueue,
  classifyQueueError,
  type SendOutcome
} from "./reliablePatchQueue";

export interface BoardCompletionKey {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
  periodKey: string;
}

export interface BoardPatchResponse {
  ok: true;
  versions: BoardMutationVersions;
}

export type BoardPatchApi = (
  path: string,
  body: { patches: unknown[] },
  options: ApiRequestOptions
) => Promise<BoardPatchResponse>;

export interface BoardCompletionQueueOptions {
  patch?: BoardPatchApi | undefined;
  onAccepted?: ((patches: BoardCompletionPatch[], versions: BoardMutationVersions) => void) | undefined;
  onPendingChange?: ((patches: BoardCompletionPatch[]) => void) | undefined;
  onPermanentFailure?:
    | ((outcome: Extract<SendOutcome<BoardCompletionKey>, { type: "rejected" }>) => void)
    | undefined;
  onAuthPause?: ((error: ApiClientError) => void) | undefined;
  onVersions?: ((versions: BoardMutationVersions) => void) | undefined;
}

export function getBoardCompletionKey(patch: BoardCompletionPatch): BoardCompletionKey {
  return {
    tableId: patch.tableId,
    rowItemId: patch.rowItemId,
    columnItemId: patch.columnItemId,
    periodKey: patch.periodKey
  };
}

function isBoardCompletionKey(value: unknown): value is BoardCompletionKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.tableId === "string" &&
    typeof key.rowItemId === "string" &&
    typeof key.columnItemId === "string" &&
    typeof key.periodKey === "string"
  );
}

function rejectedCompletionKeys(
  error: ApiClientError,
  sentPatches: BoardCompletionPatch[]
): BoardCompletionKey[] {
  const value = error.details?.rejectedKeys;
  return Array.isArray(value) && value.every(isBoardCompletionKey)
    ? value
    : sentPatches.map(getBoardCompletionKey);
}

function notifyAcceptedCompletionPatches(
  observer: BoardCompletionQueueOptions["onAccepted"],
  patches: BoardCompletionPatch[],
  versions: BoardMutationVersions
): void {
  try {
    observer?.(patches, versions);
  } catch {
    // The server acknowledgment must not be retried because a local observer failed.
  }
}

export function createBoardCompletionQueue(
  options: BoardCompletionQueueOptions = {}
): ReliablePatchQueue<BoardCompletionPatch, BoardCompletionKey> {
  const patch = options.patch ?? ((path, body, requestOptions) => apiPatch<BoardPatchResponse>(path, body, requestOptions));

  return new ReliablePatchQueue({
    keyOf: getBoardCompletionKey,
    serializeBody: (patches) => JSON.stringify({ patches }),
    send: async (patches, context) => {
      try {
        const response = await patch("/api/board/completions", { patches }, { keepalive: true, signal: context.signal });
        notifyAcceptedCompletionPatches(options.onAccepted, patches, response.versions);
        return {
          type: "accepted",
          acknowledgedKeys: patches.map(getBoardCompletionKey),
          versions: response.versions
        };
      } catch (error) {
        const classification = classifyQueueError(error);
        if (classification === "auth") return { type: "auth", error: error as ApiClientError };
        if (classification === "retry") {
          return {
            type: "retry",
            error,
            retryAfterMs: error instanceof ApiClientError ? error.retryAfterMs : null
          };
        }
        const apiError = error as ApiClientError;
        return {
          type: "rejected",
          rejectedKeys: rejectedCompletionKeys(apiError, patches),
          message: apiError.message
        };
      }
    },
    onPendingChange: options.onPendingChange ?? (() => undefined),
    onPermanentFailure: options.onPermanentFailure ?? (() => undefined),
    onAuthPause: options.onAuthPause ?? (() => undefined),
    ...(options.onVersions ? { onVersions: options.onVersions } : {})
  });
}

interface FlushableQueue {
  flush: () => Promise<void>;
}

export function attachBoardQueueLifecycle({
  documentTarget = typeof document === "undefined" ? undefined : document,
  windowTarget = typeof window === "undefined" ? undefined : window,
  queues
}: {
  documentTarget?: (EventTarget & Pick<Document, "visibilityState">) | undefined;
  windowTarget?: EventTarget | undefined;
  queues: FlushableQueue[];
}): () => void {
  const flushAll = () => {
    void Promise.allSettled(queues.map((queue) => queue.flush()));
  };
  const handleVisibilityChange = () => {
    if (documentTarget?.visibilityState === "hidden") flushAll();
  };

  documentTarget?.addEventListener("visibilitychange", handleVisibilityChange);
  windowTarget?.addEventListener("pagehide", flushAll);
  return () => {
    documentTarget?.removeEventListener("visibilitychange", handleVisibilityChange);
    windowTarget?.removeEventListener("pagehide", flushAll);
  };
}

interface UseBoardCompletionQueueOptions {
  onPendingPatchesChange?: ((patches: BoardCompletionPatch[]) => void) | undefined;
}

export function useBoardCompletionQueue({ onPendingPatchesChange }: UseBoardCompletionQueueOptions = {}) {
  const onPendingPatchesChangeRef = useRef(onPendingPatchesChange);
  useEffect(() => {
    onPendingPatchesChangeRef.current = onPendingPatchesChange;
  }, [onPendingPatchesChange]);
  const queue = useMemo(
    () => createBoardCompletionQueue({ onPendingChange: (patches) => onPendingPatchesChangeRef.current?.(patches) }),
    []
  );

  useEffect(() => {
    const detach = attachBoardQueueLifecycle({ queues: [queue] });
    return () => {
      detach();
      queue.dispose();
    };
  }, [queue]);

  return useMemo(() => ({ enqueue: (patch: BoardCompletionPatch) => queue.enqueue(patch) }), [queue]);
}
