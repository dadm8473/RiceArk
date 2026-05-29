import type { CompletionPatch } from "./types";

function patchKey(patch: CompletionPatch): string {
  return [patch.taskId, patch.characterId ?? "roster", patch.periodKey].join(":");
}

export function mergeCompletionPatches(patches: CompletionPatch[]): CompletionPatch[] {
  const latest = new Map<string, CompletionPatch>();
  for (const patch of patches) {
    latest.set(patchKey(patch), patch);
  }
  return [...latest.values()];
}
