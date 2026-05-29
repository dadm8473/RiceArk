import { getPeriodKey, type ResetRule } from "@riceark/core";
import type { CSSProperties } from "react";
import { useState } from "react";
import { useCompletionQueue } from "./useCompletionQueue";
import type { DashboardPayload } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

export function ChecklistMatrix({ dashboard }: Props) {
  const { enqueue } = useCompletionQueue();
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      dashboard.completions.map((completion) => [
        `${completion.task_id}:${completion.character_id ?? "roster"}:${completion.period_key}`,
        completion.completed === 1
      ])
    )
  );
  const columns = [
    { id: "roster", name: "원정대" },
    ...dashboard.characters.map((character) => ({
      id: character.id,
      name: character.name
    }))
  ];
  const rowStyle = {
    "--column-count": columns.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;

  return (
    <div className={`matrix density-${dashboard.settings.density}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">숙제</div>
        {columns.map((column) => (
          <div className="matrix-cell" key={column.id}>
            {column.name}
          </div>
        ))}
      </div>
      {dashboard.tasks.map((task) => {
        const resetRule = JSON.parse(task.reset_rule_json) as ResetRule;
        const periodKey = getPeriodKey(resetRule);
        return (
          <div className="matrix-row" key={task.id} style={rowStyle}>
            <div className="matrix-task-cell">
              <span>{task.name}</span>
              <small>{task.reset_type}</small>
            </div>
            {columns.map((column) => {
              const disabled = task.scope === "character" && column.id === "roster";
              const rosterOnly = task.scope === "roster" && column.id !== "roster";
              const characterId = column.id === "roster" ? null : column.id;
              const key = `${task.id}:${characterId ?? "roster"}:${periodKey}`;
              return (
                <button
                  className="matrix-cell matrix-check"
                  disabled={disabled || rosterOnly}
                  key={key}
                  type="button"
                  onClick={() => {
                    const next = !checked[key];
                    setChecked((current) => ({ ...current, [key]: next }));
                    enqueue({ taskId: task.id, characterId, periodKey, completed: next });
                  }}
                >
                  {disabled || rosterOnly ? "" : checked[key] ? "V" : ""}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
