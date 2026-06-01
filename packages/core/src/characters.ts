export interface CharacterSelection {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower?: string | null;
}

export const LOSTARK_CHARACTER_NAME_MAX_LENGTH = 12;
const LOSTARK_CHARACTER_NAME_PATTERN = /^[가-힣A-Za-z0-9]+$/u;

export function normalizeLostArkCharacterNameInput(value: string): string {
  return value.normalize("NFKC").trim();
}

export function isValidLostArkCharacterName(value: string): boolean {
  const normalized = normalizeLostArkCharacterNameInput(value);
  return (
    Array.from(normalized).length > 0 &&
    Array.from(normalized).length <= LOSTARK_CHARACTER_NAME_MAX_LENGTH &&
    LOSTARK_CHARACTER_NAME_PATTERN.test(normalized)
  );
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
