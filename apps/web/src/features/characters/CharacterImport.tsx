import { Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPatch, apiPost } from "../../api/client";
import type { DashboardCharacter } from "../dashboard/types";

interface Candidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

interface CharacterCandidateListProps {
  candidates: Candidate[];
  selected: Record<string, boolean>;
  onToggle: (key: string, checked: boolean) => void;
}

export function CharacterCandidateList({ candidates, selected, onToggle }: CharacterCandidateListProps) {
  if (candidates.length === 0) return null;

  return (
    <div className="candidate-list">
      <div className="candidate-row candidate-header">
        <span>선택</span>
        <span>서버</span>
        <span>닉네임</span>
        <span>직업</span>
        <span>아이템 레벨</span>
        <span>전투력</span>
      </div>
      {candidates.map((character) => {
        const key = `${character.serverName}:${character.name}`;
        return (
          <label className="candidate-row" key={key}>
            <input checked={Boolean(selected[key])} type="checkbox" onChange={(event) => onToggle(key, event.target.checked)} />
            <span>{character.serverName}</span>
            <strong>{character.name}</strong>
            <span>{character.className}</span>
            <span>{character.itemLevel}</span>
            <span>{character.combatPower ?? "-"}</span>
          </label>
        );
      })}
    </div>
  );
}

interface CharacterImportPanelProps {
  name: string;
  candidates: Candidate[];
  existingCharacters?: DashboardCharacter[];
  displayNames?: Record<string, string>;
  selected: Record<string, boolean>;
  message?: string | null;
  searching?: boolean;
  saving?: boolean;
  onNameChange: (name: string) => void;
  onSearch: () => void;
  onSave: () => void;
  onToggle: (key: string, checked: boolean) => void;
  onDisplayNameChange?: (characterId: string, displayName: string) => void;
  onDisplayNameSave?: (characterId: string) => void;
}

export function CharacterImportPanel({
  name,
  candidates,
  existingCharacters = [],
  displayNames = {},
  selected,
  message,
  searching = false,
  saving = false,
  onNameChange,
  onSearch,
  onSave,
  onToggle,
  onDisplayNameChange,
  onDisplayNameSave
}: CharacterImportPanelProps) {
  return (
    <section className="tool-panel">
      <div className="inline-form">
        <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="대표 캐릭터명" />
        <button disabled={searching} type="button" onClick={onSearch} title="원정대 검색">
          <Search size={16} />
          {searching ? "검색 중..." : "검색"}
        </button>
        {candidates.length > 0 ? (
          <button disabled={saving} type="button" onClick={onSave} title="선택 캐릭터 등록">
            <UserPlus size={16} />
            {saving ? "등록 중..." : "선택 캐릭터 등록"}
          </button>
        ) : null}
      </div>
      {message ? <p className="notice-text">{message}</p> : null}
      <CharacterCandidateList candidates={candidates} selected={selected} onToggle={onToggle} />
      {existingCharacters.length > 0 ? (
        <section className="alias-list">
          <h3>축약 이름</h3>
          <div className="alias-grid">
            {existingCharacters.map((character) => (
              <div className="alias-row" key={character.id}>
                <div>
                  <strong>{character.name}</strong>
                  <small>
                    {character.server_name} / {character.class_name} / {character.item_level}
                  </small>
                </div>
                <input
                  aria-label={`${character.name} 축약 이름`}
                  maxLength={20}
                  placeholder={character.name}
                  value={displayNames[character.id] ?? character.display_name ?? ""}
                  onChange={(event) => onDisplayNameChange?.(character.id, event.target.value)}
                />
                <button type="button" onClick={() => onDisplayNameSave?.(character.id)}>
                  저장
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

interface CharacterImportProps {
  existingCharacters?: DashboardCharacter[];
}

export function CharacterImport({ existingCharacters = [] }: CharacterImportProps) {
  const [name, setName] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [displayNames, setDisplayNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(existingCharacters.map((character) => [character.id, character.display_name ?? ""]))
  );
  const [message, setMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  async function search() {
    setSearching(true);
    setMessage(null);
    try {
      const result = await apiGet<{ characters: Candidate[] }>(`/api/characters/search?name=${encodeURIComponent(name)}`);
      setCandidates(result.characters);
      setSelected(Object.fromEntries(result.characters.map((character) => [`${character.serverName}:${character.name}`, true])));
      if (result.characters.length === 0) setMessage("검색 결과가 없습니다.");
    } catch (err) {
      setCandidates([]);
      setSelected({});
      setMessage(err instanceof Error ? err.message : "캐릭터 검색에 실패했습니다.");
    } finally {
      setSearching(false);
    }
  }

  async function save() {
    const characters = candidates.filter((character) => selected[`${character.serverName}:${character.name}`]);
    if (characters.length === 0) {
      setMessage("등록할 캐릭터를 선택해주세요.");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/api/characters/import", { characters });
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "선택 캐릭터 등록에 실패했습니다.");
      setSaving(false);
    }
  }

  async function saveDisplayName(characterId: string) {
    try {
      await apiPatch(`/api/characters/${characterId}/display-name`, {
        displayName: displayNames[characterId] ?? ""
      });
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "축약 이름 저장에 실패했습니다.");
    }
  }

  return (
    <CharacterImportPanel
      candidates={candidates}
      displayNames={displayNames}
      existingCharacters={existingCharacters}
      message={message}
      name={name}
      saving={saving}
      searching={searching}
      selected={selected}
      onNameChange={setName}
      onSave={() => void save()}
      onSearch={() => void search()}
      onToggle={(key, checked) => setSelected((current) => ({ ...current, [key]: checked }))}
      onDisplayNameChange={(characterId, displayName) =>
        setDisplayNames((current) => ({ ...current, [characterId]: displayName }))
      }
      onDisplayNameSave={(characterId) => void saveDisplayName(characterId)}
    />
  );
}
