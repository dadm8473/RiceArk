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

export function getReorderTargetId(element: Element | null, kind: ReorderKind): string | null {
  const target = element?.closest("[data-reorder-kind][data-reorder-id]");
  if (!target || target.getAttribute("data-reorder-kind") !== kind) return null;
  return target.getAttribute("data-reorder-id");
}
