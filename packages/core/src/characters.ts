export interface CharacterSelection {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function normalizeCharacterSelection(characters: CharacterSelection[]): CharacterSelection[] {
  const byKey = new Map<string, CharacterSelection>();
  for (const character of characters) {
    byKey.set(`${character.serverName}:${character.name}`, character);
  }
  return [...byKey.values()].sort((a, b) => a.serverName.localeCompare(b.serverName) || a.name.localeCompare(b.name));
}
