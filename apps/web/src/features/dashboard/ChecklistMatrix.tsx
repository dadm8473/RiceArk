import { getPeriodKey, type ResetRule } from "@riceark/core";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { useCompletionQueue } from "./useCompletionQueue";
import type { DashboardCharacter, DashboardPayload, DashboardTask } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

function getTaskPeriodKey(task: DashboardTask): string {
  return getPeriodKey(JSON.parse(task.reset_rule_json) as ResetRule);
}

function getCharacterLabel(character: DashboardCharacter): string {
  return character.display_name?.trim() || character.name;
}

function getCharacterDetail(character: DashboardCharacter): string {
  return [
    character.server_name,
    character.name,
    character.class_name,
    character.item_level,
    character.combat_power
  ]
    .filter(Boolean)
    .join(" / ");
}

function getCompletionKey(task: DashboardTask, characterId: string | null): string {
  return `${task.id}:${characterId ?? "roster"}:${getTaskPeriodKey(task)}`;
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
  const orientation = dashboard.settings.checklist_orientation ?? "tasks_rows";

  if (orientation === "tasks_columns") {
    return <TaskColumnsMatrix checked={checked} dashboard={dashboard} setChecked={setChecked} onToggle={enqueue} />;
  }

  return <TaskRowsMatrix checked={checked} dashboard={dashboard} setChecked={setChecked} onToggle={enqueue} />;
}

interface MatrixRendererProps {
  dashboard: DashboardPayload;
  checked: Record<string, boolean>;
  setChecked: Dispatch<SetStateAction<Record<string, boolean>>>;
  onToggle: (patch: { taskId: string; characterId: string | null; periodKey: string; completed: boolean }) => void;
}

function TaskRowsMatrix({ dashboard, checked, setChecked, onToggle }: MatrixRendererProps) {
  const columns = [{ id: "roster", name: "원정대" }, ...dashboard.characters];
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
            {"server_name" in column ? (
              <span className="character-label" title={getCharacterDetail(column)}>
                {getCharacterLabel(column)}
              </span>
            ) : null}
            {"server_name" in column ? <small>{column.item_level}</small> : <span>{column.name}</span>}
          </div>
        ))}
      </div>
      {dashboard.tasks.map((task) => {
        const periodKey = getTaskPeriodKey(task);
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
              const key = getCompletionKey(task, characterId);
              return (
                <button
                  className="matrix-cell matrix-check"
                  disabled={disabled || rosterOnly}
                  key={key}
                  type="button"
                  onClick={() => {
                    const next = !checked[key];
                    setChecked((current) => ({ ...current, [key]: next }));
                    onToggle({ taskId: task.id, characterId, periodKey, completed: next });
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

function TaskColumnsMatrix({ dashboard, checked, setChecked, onToggle }: MatrixRendererProps) {
  const rows = [{ id: "roster", name: "원정대" }, ...dashboard.characters];
  const rowStyle = {
    "--column-count": dashboard.tasks.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;

  return (
    <div className={`matrix density-${dashboard.settings.density}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">캐릭터</div>
        {dashboard.tasks.map((task) => (
          <div className="matrix-cell" key={task.id}>
            <span>{task.name}</span>
            <small>{task.reset_type}</small>
          </div>
        ))}
      </div>
      {rows.map((row) => {
        const characterId = row.id === "roster" ? null : row.id;
        return (
          <div className="matrix-row" key={row.id} style={rowStyle}>
            <div className="matrix-task-cell">
              {"server_name" in row ? (
                <>
                  <span className="character-label" title={getCharacterDetail(row)}>
                    {getCharacterLabel(row)}
                  </span>
                  <small>{row.item_level}</small>
                </>
              ) : (
                <span>{row.name}</span>
              )}
            </div>
            {dashboard.tasks.map((task) => {
              const disabled = task.scope === "character" && row.id === "roster";
              const rosterOnly = task.scope === "roster" && row.id !== "roster";
              const periodKey = getTaskPeriodKey(task);
              const key = getCompletionKey(task, characterId);
              return (
                <button
                  className="matrix-cell matrix-check"
                  disabled={disabled || rosterOnly}
                  key={key}
                  type="button"
                  onClick={() => {
                    const next = !checked[key];
                    setChecked((current) => ({ ...current, [key]: next }));
                    onToggle({ taskId: task.id, characterId, periodKey, completed: next });
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
