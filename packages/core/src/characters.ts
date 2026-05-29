export interface CharacterSelection {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower?: string | null;
}

export function parseItemLevel(itemLevel: string): number {
  return Number(itemLevel.replaceAll(",", "")) || 0;
}

export function compareCharactersByImportOrder(a: CharacterSelection, b: CharacterSelection): number {
  return (
    parseItemLevel(b.itemLevel) - parseItemLevel(a.itemLevel) ||
    a.name.localeCompare(b.name, "ko-KR") ||
    a.serverName.localeCompare(b.serverName, "ko-KR")
  );
}

export function normalizeCharacterSelection(characters: CharacterSelection[]): CharacterSelection[] {
  const byKey = new Map<string, CharacterSelection>();
  for (const character of characters) {
    byKey.set(`${character.serverName}:${character.name}`, character);
  }
  return [...byKey.values()].sort(compareCharactersByImportOrder);
}
