export interface BoundedIntegerDraftOptions {
  min: number;
  max: number;
  fallback: number;
}

export function normalizeBoundedIntegerDraft(value: string, options: BoundedIntegerDraftOptions): number {
  const trimmed = value.trim();
  if (!trimmed) return options.fallback;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return options.fallback;

  return Math.min(options.max, Math.max(options.min, Math.round(parsed)));
}
