import { compareCharactersByImportOrder } from "@riceark/core";

export interface LostArkArmoryCharacter {
  CharacterName: string;
  ServerName: string;
  CharacterClassName: string;
  ItemAvgLevel: string;
  CombatPower?: string | number | null;
}

export interface ImportedCharacterCandidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export function normalizeLostArkCharacter(character: LostArkArmoryCharacter): ImportedCharacterCandidate {
  return {
    name: character.CharacterName,
    serverName: character.ServerName,
    className: character.CharacterClassName,
    itemLevel: character.ItemAvgLevel,
    combatPower: normalizeCombatPower(character.CombatPower)
  };
}

export function normalizeCombatPower(combatPower: unknown): string | null {
  if (combatPower === null || combatPower === undefined) return null;
  const text = String(combatPower).trim();
  return text.length > 0 ? text : null;
}

export function sortImportedCharacters(characters: ImportedCharacterCandidate[]): ImportedCharacterCandidate[] {
  return [...characters].sort(compareCharactersByImportOrder);
}
