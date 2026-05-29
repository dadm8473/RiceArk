import { Plus } from "lucide-react";
import { useState } from "react";
import { apiPost } from "../../api/client";

export function TaskForm() {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"character" | "roster">("character");
  const [resetType, setResetType] = useState<"daily" | "weekly" | "biweekly" | "custom">("daily");

  async function submit() {
    await apiPost("/api/tasks", { name, scope, resetType });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <div className="inline-form">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="숙제 이름" />
        <select value={scope} onChange={(event) => setScope(event.target.value as "character" | "roster")}>
          <option value="character">캐릭터</option>
          <option value="roster">원정대</option>
        </select>
        <select value={resetType} onChange={(event) => setResetType(event.target.value as "daily" | "weekly" | "biweekly" | "custom")}>
          <option value="daily">일간</option>
          <option value="weekly">주간</option>
          <option value="biweekly">격주간</option>
          <option value="custom">커스텀</option>
        </select>
        <button type="button" onClick={() => void submit()} title="숙제 추가">
          <Plus size={16} />
          추가
        </button>
      </div>
    </section>
  );
}
