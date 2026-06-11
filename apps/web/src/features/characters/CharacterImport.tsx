import {
  isValidLostArkCharacterName,
  LOSTARK_CHARACTER_NAME_MAX_LENGTH,
  normalizeLostArkCharacterNameInput
} from "@riceark/core";
import { LoaderCircle, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost } from "../../api/client";

interface Candidate {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export interface ManualCharacterDraft {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string;
}

type CharacterImportMessageTone = "notice" | "error";

interface CharacterImportMessage {
  text: string;
  tone: CharacterImportMessageTone;
}

export const CHARACTER_SEARCH_NAME_ERROR =
  "캐릭터 닉네임은 12자 이하의 한글, 영문, 숫자만 입력해주세요. 특수문자와 띄어쓰기는 사용할 수 없습니다.";

export function getCharacterSearchNameError(name: string): string | null {
  return isValidLostArkCharacterName(name) ? null : CHARACTER_SEARCH_NAME_ERROR;
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
  messageTone?: CharacterImportMessageTone;
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
  messageTone = "notice",
  searching = false,
  saving = false,
  onNameChange,
  onSearch,
  onSave,
  onToggle
}: CharacterImportPanelProps) {
  return (
    <section className="tool-panel">
      <form
        className="inline-form"
        aria-busy={searching}
        onSubmit={(event) => {
          event.preventDefault();
          if (!searching) onSearch();
        }}
      >
        <input
          maxLength={LOSTARK_CHARACTER_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="대표 캐릭터명"
        />
        <button disabled={searching} type="submit" title="원정대 검색">
          {searching ? <LoaderCircle className="spin-icon" size={16} /> : <Search size={16} />}
          {searching ? "검색 중..." : "검색"}
        </button>
        {candidates.length > 0 ? (
          <button disabled={saving} type="button" onClick={onSave} title="선택 캐릭터 등록">
            <UserPlus size={16} />
            {saving ? "등록 중..." : "선택 캐릭터 등록"}
          </button>
        ) : null}
      </form>
      {message ? (
        <p className={`status-text ${messageTone === "error" ? "error-text" : "notice-text"}`} role={messageTone === "error" ? "alert" : "status"}>
          {message}
        </p>
      ) : null}
      <CharacterCandidateList candidates={candidates} selected={selected} onToggle={onToggle} />
    </section>
  );
}

interface ManualCharacterCreatePanelProps {
  manualCharacter: ManualCharacterDraft;
  saving?: boolean;
  onChange: (next: ManualCharacterDraft) => void;
  onSave: () => void;
}

export function ManualCharacterCreatePanel({
  manualCharacter,
  saving = false,
  onChange,
  onSave
}: ManualCharacterCreatePanelProps) {
  const canSave = manualCharacter.name.trim().length > 0;
  const update = (patch: Partial<ManualCharacterDraft>) => onChange({ ...manualCharacter, ...patch });

  return (
    <section className="tool-panel manual-character-panel">
      <form
        className="inline-form manual-character-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && canSave) onSave();
        }}
      >
        <strong className="manual-character-heading">직접 추가</strong>
        <input
          maxLength={20}
          value={manualCharacter.name}
          onChange={(event) => update({ name: event.currentTarget.value })}
          placeholder="닉네임"
        />
        <input
          maxLength={20}
          value={manualCharacter.serverName}
          onChange={(event) => update({ serverName: event.currentTarget.value })}
          placeholder="서버"
        />
        <input
          maxLength={20}
          value={manualCharacter.className}
          onChange={(event) => update({ className: event.currentTarget.value })}
          placeholder="직업"
        />
        <input
          maxLength={20}
          value={manualCharacter.itemLevel}
          onChange={(event) => update({ itemLevel: event.currentTarget.value })}
          placeholder="아이템 레벨"
        />
        <input
          maxLength={20}
          value={manualCharacter.combatPower}
          onChange={(event) => update({ combatPower: event.currentTarget.value })}
          placeholder="전투력"
        />
        <button disabled={saving || !canSave} type="submit" title={canSave ? "수동 캐릭터 추가" : "닉네임을 입력해주세요"}>
          <UserPlus size={16} />
          {saving ? "추가 중..." : "직접 추가"}
        </button>
      </form>
    </section>
  );
}

interface CharacterImportProps {
  tableId?: string | undefined;
  onSaved?: () => void | Promise<void>;
}

export function CharacterImport({ tableId, onSaved }: CharacterImportProps = {}) {
  const [name, setName] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<CharacterImportMessage | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualCharacter, setManualCharacter] = useState<ManualCharacterDraft>({
    name: "",
    serverName: "",
    className: "",
    itemLevel: "",
    combatPower: ""
  });
  const [manualSaving, setManualSaving] = useState(false);

  async function search() {
    const normalizedName = normalizeLostArkCharacterNameInput(name);
    const validationError = getCharacterSearchNameError(normalizedName);
    setName(normalizedName);
    if (validationError) {
      setCandidates([]);
      setSelected({});
      setMessage({ text: validationError, tone: "error" });
      return;
    }

    setSearching(true);
    setMessage(null);
    try {
      const result = await apiGet<{ characters: Candidate[] }>(`/api/characters/search?name=${encodeURIComponent(normalizedName)}`);
      setCandidates(result.characters);
      setSelected(Object.fromEntries(result.characters.map((character) => [`${character.serverName}:${character.name}`, true])));
      if (result.characters.length === 0) {
        setMessage({ text: "검색 결과가 없습니다. 대표 캐릭터명을 다시 확인해주세요.", tone: "notice" });
      }
    } catch {
      setCandidates([]);
      setSelected({});
      setMessage({
        text: "캐릭터 정보를 불러오지 못했습니다. 대표 캐릭터명을 확인하거나 잠시 후 다시 시도해주세요.",
        tone: "error"
      });
    } finally {
      setSearching(false);
    }
  }

  async function save() {
    const characters = candidates.filter((character) => selected[`${character.serverName}:${character.name}`]);
    if (characters.length === 0) {
      setMessage({ text: "등록할 캐릭터를 하나 이상 선택해주세요.", tone: "error" });
      return;
    }
    setSaving(true);
    try {
      await apiPost(tableId ? `/api/board/tables/${encodeURIComponent(tableId)}/characters/import` : "/api/characters/import", {
        characters
      });
      if (onSaved) {
        await onSaved();
      } else {
        window.location.reload();
      }
    } catch {
      setMessage({
        text: "선택한 캐릭터를 등록하지 못했습니다. 잠시 후 다시 시도해주세요.",
        tone: "error"
      });
      setSaving(false);
    }
  }

  async function saveManual() {
    const trimmedName = manualCharacter.name.trim();
    if (!trimmedName) {
      setMessage({ text: "직접 추가할 캐릭터의 닉네임을 입력해주세요.", tone: "error" });
      return;
    }
    setManualSaving(true);
    setMessage(null);
    try {
      await apiPost(tableId ? `/api/board/tables/${encodeURIComponent(tableId)}/characters/manual` : "/api/characters/manual", {
        name: trimmedName,
        serverName: manualCharacter.serverName.trim(),
        className: manualCharacter.className.trim(),
        itemLevel: manualCharacter.itemLevel.trim(),
        combatPower: manualCharacter.combatPower.trim() || null
      });
      setManualCharacter({ name: "", serverName: "", className: "", itemLevel: "", combatPower: "" });
      if (onSaved) {
        await onSaved();
      } else {
        window.location.reload();
      }
    } catch {
      setMessage({ text: "캐릭터를 직접 추가하지 못했습니다. 입력값을 확인하거나 잠시 후 다시 시도해주세요.", tone: "error" });
      setManualSaving(false);
    }
  }

  return (
    <>
      <CharacterImportPanel
        candidates={candidates}
        message={message ? message.text : null}
        messageTone={message?.tone ?? "notice"}
        name={name}
        saving={saving}
        searching={searching}
        selected={selected}
        onNameChange={setName}
        onSave={() => void save()}
        onSearch={() => void search()}
        onToggle={(key, checked) => setSelected((current) => ({ ...current, [key]: checked }))}
      />
      <ManualCharacterCreatePanel
        manualCharacter={manualCharacter}
        saving={manualSaving}
        onChange={setManualCharacter}
        onSave={() => void saveManual()}
      />
    </>
  );
}
