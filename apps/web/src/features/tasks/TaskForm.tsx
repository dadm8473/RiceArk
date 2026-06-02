import { Plus } from "lucide-react";
import { useState } from "react";
import { apiPost } from "../../api/client";

interface TaskFormProps {
  tableId?: string | undefined;
  onSaved?: () => void | Promise<void>;
}

export function TaskForm({ tableId, onSaved }: TaskFormProps = {}) {
  const [name, setName] = useState("");
  const [resetType, setResetType] = useState<"daily" | "weekly" | "biweekly" | "custom">("daily");

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
        <select value={resetType} onChange={(event) => setResetType(event.target.value as "daily" | "weekly" | "biweekly" | "custom")}>
          <option value="daily">일간</option>
          <option value="weekly">주간</option>
          <option value="biweekly">격주간</option>
          <option value="custom">커스텀</option>
        </select>
        <button className="primary-button" type="button" onClick={() => void submit()} title="숙제 추가">
          <Plus size={16} />
          추가
        </button>
      </div>
    </section>
  );
}
