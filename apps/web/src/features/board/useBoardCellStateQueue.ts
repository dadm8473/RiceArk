import { useMemo, useRef } from "react";
import { apiPatch } from "../../api/client";
import { mergeBoardCellStatePatches, type BoardCellStatePatch } from "./cellStates";

export function useBoardCellStateQueue() {
  const queue = useRef<BoardCellStatePatch[]>([]);
  const timer = useRef<number | null>(null);

  return useMemo(() => {
    async function flush() {
      const patches = mergeBoardCellStatePatches(queue.current);
      queue.current = [];
      timer.current = null;
      if (patches.length > 0) {
        await apiPatch("/api/board/cell-states", { patches });
      }
    }

    function enqueue(patch: BoardCellStatePatch) {
      queue.current.push(patch);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        void flush().catch(() => window.location.reload());
      }, 800);
    }

    return { enqueue };
  }, []);
}
