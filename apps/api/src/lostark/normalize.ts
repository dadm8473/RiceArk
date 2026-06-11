import { compareCharactersByImportOrder } from "@riceark/core";

const LOSTARK_NUMERIC_STAT_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

export interface LostArkArmoryCharacter {
  CharacterName: string;
  ServerName: string;
  CharacterClassName: string;
  ItemAvgLevel?: string | number | null;
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
    itemLevel: normalizeItemLevel(character.ItemAvgLevel),
    combatPower: normalizeCombatPower(character.CombatPower)
  };
}

export function normalizeItemLevel(itemLevel: unknown): string {
  if (itemLevel === null || itemLevel === undefined) return "0";
  const text = String(itemLevel).normalize("NFKC").trim();
  return LOSTARK_NUMERIC_STAT_PATTERN.test(text) ? text : "0";
}

export function normalizeCombatPower(combatPower: unknown): string | null {
  if (combatPower === null || combatPower === undefined) return null;
  const text = String(combatPower).normalize("NFKC").trim();
  return LOSTARK_NUMERIC_STAT_PATTERN.test(text) ? text : null;
}

export function sortImportedCharacters(characters: ImportedCharacterCandidate[]): ImportedCharacterCandidate[] {
  return [...characters].sort(compareCharactersByImportOrder);
}
