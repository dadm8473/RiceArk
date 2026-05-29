import { Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost } from "../../api/client";

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
  selected: Record<string, boolean>;
  message?: string | null;
  searching?: boolean;
  saving?: boolean;
  onNameChange: (name: string) => void;
  onSearch: () => void;
  onSave: () => void;
  onToggle: (key: string, checked: boolean) => void;
}

export function CharacterImportPanel({
  name,
  candidates,
  selected,
  message,
  searching = false,
  saving = false,
  onNameChange,
  onSearch,
  onSave,
  onToggle
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
    </section>
  );
}

export function CharacterImport() {
  const [name, setName] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
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

  return (
    <CharacterImportPanel
      candidates={candidates}
      message={message}
      name={name}
      saving={saving}
      searching={searching}
      selected={selected}
      onNameChange={setName}
      onSave={() => void save()}
      onSearch={() => void search()}
      onToggle={(key, checked) => setSelected((current) => ({ ...current, [key]: checked }))}
    />
  );
}
