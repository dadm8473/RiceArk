import { Plus } from "lucide-react";
import { useState } from "react";
import { apiPost } from "../../api/client";

type TaskResetType = "daily" | "weekly" | "biweekly" | "none";

interface TaskFormProps {
  tableId?: string | undefined;
  onSaved?: () => void | Promise<void>;
}

export function TaskForm({ tableId, onSaved }: TaskFormProps = {}) {
  const [name, setName] = useState("");
  const [resetType, setResetType] = useState<TaskResetType>("daily");

  async function submit() {
    await apiPost(tableId ? `/api/board/tables/${encodeURIComponent(tableId)}/tasks` : "/api/tasks", { name, resetType });
    if (onSaved) {
      await onSaved();
    } else {
      window.location.reload();
    }
  }

  return (
    <section className="tool-panel compact-task-panel">
      <div className="inline-form compact-task-form">
        <input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="숙제 이름" />
        <label className="compact-task-reset">
          초기화 주기
          <select value={resetType} onChange={(event) => setResetType(event.target.value as TaskResetType)}>
            <option value="daily">일간</option>
            <option value="weekly">주간</option>
            <option value="biweekly">격주</option>
            <option value="none">초기화 안함</option>
          </select>
        </label>
        <button className="primary-button" type="button" onClick={() => void submit()} title="숙제 추가">
          <Plus size={16} />
          추가
        </button>
      </div>
    </section>
  );
}
