import { getPeriodKey, type ResetRule } from "@riceark/core";
import { GripVertical } from "lucide-react";
import type { CSSProperties, Dispatch, PointerEvent, ReactNode, SetStateAction } from "react";
import { useRef, useState } from "react";
import { apiPatch } from "../../api/client";
import { getReorderTargetId, moveItem, type ReorderKind } from "./reorder";
import { useCompletionQueue } from "./useCompletionQueue";
import type { DashboardCharacter, DashboardPayload, DashboardTask } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

interface DragState {
  kind: ReorderKind;
  id: string;
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

function orderItems<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const ordered = orderedIds.flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });
  const missing = items.filter((item) => !orderedIds.includes(item.id));
  return [...ordered, ...missing];
}

function getReorderTargetProps(kind: ReorderKind, id: string) {
  return {
    "data-reorder-id": id,
    "data-reorder-kind": kind,
    "data-reorder-target": "true"
  };
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
  const [taskOrder, setTaskOrder] = useState<string[]>(() => dashboard.tasks.map((task) => task.id));
  const [characterOrder, setCharacterOrder] = useState<string[]>(() =>
    dashboard.characters.map((character) => character.id)
  );
  const [dragging, setDragging] = useState<DragState | null>(null);
  const draggingRef = useRef<DragState | null>(null);
  const taskOrderRef = useRef(taskOrder);
  const characterOrderRef = useRef(characterOrder);
  const orientation = dashboard.settings.checklist_orientation ?? "tasks_rows";
  const orderedTasks = orderItems(dashboard.tasks, taskOrder);
  const orderedCharacters = orderItems(dashboard.characters, characterOrder);

  function beginDrag(kind: ReorderKind, id: string, event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextDrag = { kind, id };
    draggingRef.current = nextDrag;
    setDragging(nextDrag);
  }

  function moveDrag(kind: ReorderKind, targetId: string) {
    const currentDrag = draggingRef.current;
    if (!currentDrag || currentDrag.kind !== kind || currentDrag.id === targetId) return;
    const setter = kind === "task" ? setTaskOrder : setCharacterOrder;
    setter((current) => {
      const fromIndex = current.indexOf(currentDrag.id);
      const toIndex = current.indexOf(targetId);
      const next = moveItem(current, fromIndex, toIndex);
      if (kind === "task") taskOrderRef.current = next;
      if (kind === "character") characterOrderRef.current = next;
      return next;
    });
  }

  function moveDragOverPointer(event: PointerEvent<HTMLButtonElement>) {
    const currentDrag = draggingRef.current;
    if (!currentDrag) return;
    const targetId = getReorderTargetId(document.elementFromPoint(event.clientX, event.clientY), currentDrag.kind);
    if (targetId) moveDrag(currentDrag.kind, targetId);
  }

  async function saveOrder(kind: ReorderKind, ids: string[]) {
    try {
      if (kind === "task") {
        await apiPatch("/api/tasks/order", { taskIds: ids });
      } else {
        await apiPatch("/api/characters/order", { characterIds: ids });
      }
    } catch {
      window.location.reload();
    }
  }

  function endDrag() {
    const currentDrag = draggingRef.current;
    if (!currentDrag) return;
    const kind = currentDrag.kind;
    draggingRef.current = null;
    setDragging(null);
    void saveOrder(kind, kind === "task" ? taskOrderRef.current : characterOrderRef.current);
  }

  function renderDragHandle(kind: ReorderKind, id: string, label: string) {
    const active = dragging?.kind === kind && dragging.id === id;
    return (
      <button
        className={`drag-handle${active ? " active" : ""}`}
        data-reorder-id={id}
        data-reorder-kind={kind}
        type="button"
        aria-label={`${label} 순서 이동`}
        title="드래그해서 순서 변경"
        onPointerCancel={endDrag}
        onPointerDown={(event) => beginDrag(kind, id, event)}
        onPointerMove={moveDragOverPointer}
        onPointerUp={endDrag}
      >
        <GripVertical size={14} />
      </button>
    );
  }

  if (orientation === "tasks_columns") {
    return (
      <TaskColumnsMatrix
        characters={orderedCharacters}
        checked={checked}
        dashboard={dashboard}
        renderDragHandle={renderDragHandle}
        setChecked={setChecked}
        tasks={orderedTasks}
        onToggle={enqueue}
      />
    );
  }

  return (
    <TaskRowsMatrix
      characters={orderedCharacters}
      checked={checked}
      dashboard={dashboard}
      renderDragHandle={renderDragHandle}
      setChecked={setChecked}
      tasks={orderedTasks}
      onToggle={enqueue}
    />
  );
}

interface MatrixRendererProps {
  dashboard: DashboardPayload;
  characters: DashboardCharacter[];
  tasks: DashboardTask[];
  checked: Record<string, boolean>;
  renderDragHandle: (kind: ReorderKind, id: string, label: string) => ReactNode;
  setChecked: Dispatch<SetStateAction<Record<string, boolean>>>;
  onToggle: (patch: { taskId: string; characterId: string | null; periodKey: string; completed: boolean }) => void;
}

function TaskRowsMatrix({ dashboard, characters, tasks, checked, renderDragHandle, setChecked, onToggle }: MatrixRendererProps) {
  const columns = [{ id: "roster", name: "원정대" }, ...characters];
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
          <div
            className="matrix-cell"
            key={column.id}
            {...("server_name" in column ? getReorderTargetProps("character", column.id) : {})}
          >
            {"server_name" in column ? (
              <span className="matrix-label-line">
                {renderDragHandle("character", column.id, getCharacterLabel(column))}
                <span className="character-label" title={getCharacterDetail(column)}>
                  {getCharacterLabel(column)}
                </span>
              </span>
            ) : null}
            {"server_name" in column ? <small>{column.item_level}</small> : <span>{column.name}</span>}
          </div>
        ))}
      </div>
      {tasks.map((task) => {
        const periodKey = getTaskPeriodKey(task);
        return (
          <div className="matrix-row" key={task.id} style={rowStyle}>
            <div className="matrix-task-cell" {...getReorderTargetProps("task", task.id)}>
              <span className="matrix-label-line">
                {renderDragHandle("task", task.id, task.name)}
                <span>{task.name}</span>
              </span>
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

function TaskColumnsMatrix({
  dashboard,
  characters,
  tasks,
  checked,
  renderDragHandle,
  setChecked,
  onToggle
}: MatrixRendererProps) {
  const rows = [{ id: "roster", name: "원정대" }, ...characters];
  const rowStyle = {
    "--column-count": tasks.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;

  return (
    <div className={`matrix density-${dashboard.settings.density}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">캐릭터</div>
        {tasks.map((task) => (
          <div className="matrix-cell" key={task.id} {...getReorderTargetProps("task", task.id)}>
            <span className="matrix-label-line">
              {renderDragHandle("task", task.id, task.name)}
              <span>{task.name}</span>
            </span>
            <small>{task.reset_type}</small>
          </div>
        ))}
      </div>
      {rows.map((row) => {
        const characterId = row.id === "roster" ? null : row.id;
        return (
          <div className="matrix-row" key={row.id} style={rowStyle}>
            <div
              className="matrix-task-cell"
              {...("server_name" in row ? getReorderTargetProps("character", row.id) : {})}
            >
              {"server_name" in row ? (
                <>
                  <span className="matrix-label-line">
                    {renderDragHandle("character", row.id, getCharacterLabel(row))}
                    <span className="character-label" title={getCharacterDetail(row)}>
                      {getCharacterLabel(row)}
                    </span>
                  </span>
                  <small>{row.item_level}</small>
                </>
              ) : (
                <span>{row.name}</span>
              )}
            </div>
            {tasks.map((task) => {
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
