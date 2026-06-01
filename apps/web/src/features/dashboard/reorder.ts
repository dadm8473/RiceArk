export type ReorderKind = "task" | "character";

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return items;
  next.splice(toIndex, 0, item);
  return next;
}

export function getSortableItemId(kind: ReorderKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseSortableItemId(sortableId: string): { kind: ReorderKind; id: string } | null {
  const [kind, ...idParts] = sortableId.split(":");
  const id = idParts.join(":");
  if ((kind !== "task" && kind !== "character") || !id) return null;
  return { kind, id };
}
