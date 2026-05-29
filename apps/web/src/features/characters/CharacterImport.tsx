import { Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Candidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
}

export function CharacterImport() {
  const [name, setName] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  async function search() {
    const result = await apiGet<{ characters: Candidate[] }>(`/api/characters/search?name=${encodeURIComponent(name)}`);
    setCandidates(result.characters);
    setSelected(Object.fromEntries(result.characters.map((character) => [`${character.serverName}:${character.name}`, true])));
  }

  async function save() {
    const characters = candidates.filter((character) => selected[`${character.serverName}:${character.name}`]);
    await apiPost("/api/characters/import", { characters });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <h2>캐릭터 가져오기</h2>
      <div className="inline-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="대표 캐릭터명" />
        <button type="button" onClick={() => void search()} title="원정대 검색">
          <Search size={16} />
          검색
        </button>
      </div>
      <div className="candidate-list">
        {candidates.map((character) => {
          const key = `${character.serverName}:${character.name}`;
          return (
            <label className="candidate-row" key={key}>
              <input
                checked={Boolean(selected[key])}
                type="checkbox"
                onChange={(event) => setSelected((current) => ({ ...current, [key]: event.target.checked }))}
              />
              <span>{character.serverName}</span>
              <strong>{character.name}</strong>
              <span>{character.className}</span>
              <span>{character.itemLevel}</span>
            </label>
          );
        })}
      </div>
      {candidates.length > 0 ? (
        <button type="button" onClick={() => void save()} title="선택 캐릭터 등록">
          <UserPlus size={16} />
          선택 캐릭터 등록
        </button>
      ) : null}
    </section>
  );
}
