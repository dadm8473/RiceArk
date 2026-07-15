import { useEffect, useMemo, useRef } from "react";
import { ApiClientError, apiPatch } from "../../api/client";
import type { BoardCellStatePatch } from "./cellStates";
import type { BoardMutationVersions } from "./types";
import {
  ReliablePatchQueue,
  classifyQueueError,
  type SendOutcome
} from "./reliablePatchQueue";
import {
  attachBoardQueueLifecycle,
  type BoardPatchApi,
  type BoardPatchResponse
} from "./useBoardCompletionQueue";

export interface BoardCellStateKey {
  tableId: string;
  rowItemId: string;
  columnItemId: string;
}

export interface BoardCellStateQueueOptions {
  patch?: BoardPatchApi | undefined;
  onAccepted?: ((patches: BoardCellStatePatch[], versions: BoardMutationVersions) => void) | undefined;
  onPendingChange?: ((patches: BoardCellStatePatch[]) => void) | undefined;
  onPermanentFailure?:
    | ((outcome: Extract<SendOutcome<BoardCellStateKey>, { type: "rejected" }>) => void)
    | undefined;
  onAuthPause?: ((error: ApiClientError) => void) | undefined;
  onVersions?: ((versions: BoardMutationVersions) => void) | undefined;
}

export function getBoardCellStateKey(patch: BoardCellStatePatch): BoardCellStateKey {
  return {
    tableId: patch.tableId,
    rowItemId: patch.rowItemId,
    columnItemId: patch.columnItemId
  };
}

function isBoardCellStateKey(value: unknown): value is BoardCellStateKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.tableId === "string" &&
    typeof key.rowItemId === "string" &&
    typeof key.columnItemId === "string"
  );
}

function rejectedCellStateKeys(error: ApiClientError, sentPatches: BoardCellStatePatch[]): BoardCellStateKey[] {
  const value = error.details?.rejectedKeys;
  return Array.isArray(value) && value.every(isBoardCellStateKey)
    ? value
    : sentPatches.map(getBoardCellStateKey);
}

function notifyAcceptedCellStatePatches(
  observer: BoardCellStateQueueOptions["onAccepted"],
  patches: BoardCellStatePatch[],
  versions: BoardMutationVersions
): void {
  try {
    observer?.(patches, versions);
  } catch {
    // The server acknowledgment must not be retried because a local observer failed.
  }
}

export function createBoardCellStateQueue(
  options: BoardCellStateQueueOptions = {}
): ReliablePatchQueue<BoardCellStatePatch, BoardCellStateKey> {
  const patch = options.patch ?? ((path, body, requestOptions) => apiPatch<BoardPatchResponse>(path, body, requestOptions));

  return new ReliablePatchQueue({
    keyOf: getBoardCellStateKey,
    serializeBody: (patches) => JSON.stringify({ patches }),
    send: async (patches, context) => {
      try {
        const response = await patch("/api/board/cell-states", { patches }, { keepalive: true, signal: context.signal });
        notifyAcceptedCellStatePatches(options.onAccepted, patches, response.versions);
        return {
          type: "accepted",
          acknowledgedKeys: patches.map(getBoardCellStateKey),
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
          rejectedKeys: rejectedCellStateKeys(apiError, patches),
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

interface UseBoardCellStateQueueOptions {
  onPendingPatchesChange?: ((patches: BoardCellStatePatch[]) => void) | undefined;
}

export function useBoardCellStateQueue({ onPendingPatchesChange }: UseBoardCellStateQueueOptions = {}) {
  const onPendingPatchesChangeRef = useRef(onPendingPatchesChange);
  useEffect(() => {
    onPendingPatchesChangeRef.current = onPendingPatchesChange;
  }, [onPendingPatchesChange]);
  const queue = useMemo(
    () => createBoardCellStateQueue({ onPendingChange: (patches) => onPendingPatchesChangeRef.current?.(patches) }),
    []
  );

  useEffect(() => {
    const detach = attachBoardQueueLifecycle({ queues: [queue] });
    return () => {
      detach();
      queue.dispose();
    };
  }, [queue]);

  return useMemo(() => ({ enqueue: (patch: BoardCellStatePatch) => queue.enqueue(patch) }), [queue]);
}
