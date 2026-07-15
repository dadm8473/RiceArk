import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiPost } from "../../api/client";
import {
  type BoardMutationRunner,
  runBoardMutationDirect
} from "../board/mutationBarrier";

type TaskResetType = "daily" | "weekly" | "biweekly" | "none";

interface TaskFormProps {
  tableId?: string | undefined;
  onSaved?: () => void | Promise<void>;
  runMutation?: BoardMutationRunner | undefined;
}

interface LostArkTaskPreset {
  id: string;
  title: string;
  label: string;
  resetType: TaskResetType;
  color: string;
}

const DEFAULT_TASK_COLOR = "#2563eb";

export const LOST_ARK_TASK_PRESETS: LostArkTaskPreset[] = [
  { id: "kurzan-chaos", title: "카오스 던전/쿠르잔 전선/혼돈의 균열", label: "카던", resetType: "daily", color: DEFAULT_TASK_COLOR },
  { id: "guardian", title: "가디언 토벌", label: "가토", resetType: "daily", color: "#13795b" },
  { id: "act-4", title: "4막 : 파멸의 성채", label: "4막", resetType: "weekly", color: "#b45309" },
  { id: "finale", title: "종막 : 최후의 날", label: "종막", resetType: "weekly", color: "#7c3aed" },
  { id: "serka", title: "고통의 마녀, 세르카", label: "세르카", resetType: "weekly", color: "#be123c" },
  { id: "cathedral", title: "지평의 성당", label: "성당", resetType: "weekly", color: "#0f766e" },
  { id: "paradise-heaven", title: "낙원 : 천상", label: "천상", resetType: "weekly", color: "#4f46e5" },
  { id: "paradise-proof", title: "낙원 : 증명", label: "증명", resetType: "weekly", color: "#db2777" }
];

function getTaskResetTypeLabel(resetType: TaskResetType): string {
  if (resetType === "daily") return "일간";
  if (resetType === "weekly") return "주간";
  if (resetType === "biweekly") return "격주";
  return "초기화 안함";
}

export function TaskForm({ tableId, onSaved, runMutation = runBoardMutationDirect }: TaskFormProps = {}) {
  const [name, setName] = useState("");
  const [resetType, setResetType] = useState<TaskResetType>("daily");
  const [color, setColor] = useState(DEFAULT_TASK_COLOR);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    requestIdRef.current = null;
    setErrorMessage("");
  }, [name, resetType, color]);

  async function submit() {
    const trimmedName = name.trim();
    if (pending || !trimmedName) return;

    const requestId = requestIdRef.current ?? `task-create:${crypto.randomUUID()}`;
    requestIdRef.current = requestId;
    setPending(true);
    setErrorMessage("");

    try {
      await runMutation(async () => {
        await apiPost(tableId ? `/api/board/tables/${encodeURIComponent(tableId)}/tasks` : "/api/tasks", {
          name: trimmedName,
          resetType,
          color,
          requestId
        });
        requestIdRef.current = null;
        setName("");
        setColor(DEFAULT_TASK_COLOR);
        if (onSaved) {
          await onSaved();
        } else {
          window.location.reload();
        }
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "숙제를 추가하지 못했습니다.");
    } finally {
      setPending(false);
    }
  }

  function applyPreset(preset: LostArkTaskPreset) {
    if (pending) return;
    requestIdRef.current = null;
    setErrorMessage("");
    setName(preset.label);
    setResetType(preset.resetType);
    setColor(preset.color);
  }

  const canSubmit = name.trim().length > 0;
  const submitTitle = pending ? "숙제를 추가하는 중입니다." : canSubmit ? "숙제 추가" : "숙제 이름을 입력해주세요";

  return (
    <section className="tool-panel compact-task-panel">
      <div className="task-preset-grid" aria-label="숙제 프리셋">
        {LOST_ARK_TASK_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className="task-preset-card"
            disabled={pending}
            type="button"
            aria-label={`${preset.label} 숙제 프리셋 적용`}
            onClick={() => applyPreset(preset)}
          >
            <strong>{preset.label}</strong>
            <span>{preset.title}</span>
            <small>{getTaskResetTypeLabel(preset.resetType)}</small>
          </button>
        ))}
      </div>
      <div className="inline-form compact-task-form">
        <input maxLength={40} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} placeholder="숙제 이름" />
        <label className="compact-task-color">
          색상
          <input
            aria-label="숙제 색상"
            className="compact-task-color-input"
            type="color"
            value={color}
            disabled={pending}
            onChange={(event) => setColor(event.target.value)}
          />
        </label>
        <label className="compact-task-reset">
          초기화 주기
          <select value={resetType} disabled={pending} onChange={(event) => setResetType(event.target.value as TaskResetType)}>
            <option value="daily">일간</option>
            <option value="weekly">주간</option>
            <option value="biweekly">격주</option>
            <option value="none">초기화 안함</option>
          </select>
        </label>
        <button className="primary-button" disabled={pending || !canSubmit} type="button" onClick={() => void submit()} title={submitTitle}>
          <Plus size={16} />
          {pending ? "추가 중" : "추가"}
        </button>
      </div>
      {errorMessage ? <p className="board-form-error">{errorMessage}</p> : null}
    </section>
  );
}
