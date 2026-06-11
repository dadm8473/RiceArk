import { useMemo, useRef } from "react";
import { apiPatch } from "../../api/client";
import { mergeBoardCompletionPatches, type BoardCompletionPatch } from "./completions";

export function useBoardCompletionQueue() {
  const queue = useRef<BoardCompletionPatch[]>([]);
  const timer = useRef<number | null>(null);

  return useMemo(() => {
    async function flush() {
      const patches = mergeBoardCompletionPatches(queue.current);
      queue.current = [];
      timer.current = null;
      if (patches.length > 0) {
        await apiPatch("/api/board/completions", { patches });
      }
    }

    function enqueue(patch: BoardCompletionPatch) {
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
