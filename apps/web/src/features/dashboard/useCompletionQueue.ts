import { useMemo, useRef } from "react";
import { apiPatch } from "../../api/client";

interface CompletionPatch {
  taskId: string;
  characterId: string | null;
  periodKey: string;
  completed: boolean;
}

export function useCompletionQueue() {
  const queue = useRef<CompletionPatch[]>([]);
  const timer = useRef<number | null>(null);

  return useMemo(() => {
    async function flush() {
      const patches = queue.current;
      queue.current = [];
      timer.current = null;
      if (patches.length > 0) {
        await apiPatch("/api/completions", { patches });
      }
    }

    function enqueue(patch: CompletionPatch) {
      queue.current.push(patch);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
      timer.current = window.setTimeout(() => {
        void flush();
      }, 800);
    }

    return { enqueue };
  }, []);
}
