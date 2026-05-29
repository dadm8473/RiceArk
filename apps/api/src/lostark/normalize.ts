export interface LostArkArmoryCharacter {
  CharacterName: string;
  ServerName: string;
  CharacterClassName: string;
  ItemAvgLevel: string;
}

export interface ImportedCharacterCandidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function normalizeLostArkCharacter(character: LostArkArmoryCharacter): ImportedCharacterCandidate {
  return {
    name: character.CharacterName,
    serverName: character.ServerName,
    className: character.CharacterClassName,
    itemLevel: character.ItemAvgLevel
  };
}
