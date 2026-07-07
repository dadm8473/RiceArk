import { useCallback, useEffect, useMemo, useRef } from "react";
import { apiPatch } from "../../api/client";
import { mergeBoardCompletionPatches, type BoardCompletionPatch } from "./completions";

interface UseBoardCompletionQueueOptions {
  onPendingPatchesChange?: ((patches: BoardCompletionPatch[]) => void) | undefined;
}

function removeBoardCompletionPatches(
  patches: BoardCompletionPatch[],
  sentPatches: BoardCompletionPatch[]
): BoardCompletionPatch[] {
  const sentKeys = new Set(
    sentPatches.map((patch) => JSON.stringify([patch.tableId, patch.rowItemId, patch.columnItemId, patch.periodKey]))
  );
  return patches.filter((patch) => !sentKeys.has(JSON.stringify([patch.tableId, patch.rowItemId, patch.columnItemId, patch.periodKey])));
}

export function useBoardCompletionQueue({ onPendingPatchesChange }: UseBoardCompletionQueueOptions = {}) {
  const queue = useRef<BoardCompletionPatch[]>([]);
  const inFlight = useRef<BoardCompletionPatch[]>([]);
  const timer = useRef<number | null>(null);
  const onPendingPatchesChangeRef = useRef(onPendingPatchesChange);

  useEffect(() => {
    onPendingPatchesChangeRef.current = onPendingPatchesChange;
  }, [onPendingPatchesChange]);

  const notifyPendingPatches = useCallback(() => {
    onPendingPatchesChangeRef.current?.(mergeBoardCompletionPatches([...inFlight.current, ...queue.current]));
  }, []);

  const flush = useCallback(async () => {
    const patches = mergeBoardCompletionPatches(queue.current);
    queue.current = [];
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (patches.length === 0) {
      notifyPendingPatches();
      return;
    }

    inFlight.current = mergeBoardCompletionPatches([...inFlight.current, ...patches]);
    notifyPendingPatches();
    try {
      await apiPatch("/api/board/completions", { patches });
      inFlight.current = removeBoardCompletionPatches(inFlight.current, patches);
      notifyPendingPatches();
    } catch (err) {
      queue.current = mergeBoardCompletionPatches([...patches, ...queue.current]);
      inFlight.current = removeBoardCompletionPatches(inFlight.current, patches);
      notifyPendingPatches();
      throw err;
    }
  }, [notifyPendingPatches]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") void flush().catch(() => window.location.reload());
    }

    function handlePageHide() {
      void flush().catch(() => window.location.reload());
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [flush]);

  return useMemo(() => {
    function enqueue(patch: BoardCompletionPatch) {
      queue.current.push(patch);
      notifyPendingPatches();
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        void flush().catch(() => window.location.reload());
      }, 800);
    }

    return { enqueue };
  }, [flush, notifyPendingPatches]);
}
