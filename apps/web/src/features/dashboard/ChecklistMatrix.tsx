import { getPeriodKey, type ResetRule } from "@riceark/core";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useRef, useState } from "react";
import { apiDelete, apiPatch } from "../../api/client";
import { getSortableItemId, moveItem, parseSortableItemId, type ReorderKind } from "./reorder";
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

function getCompletionKey(task: DashboardTask, characterId: string): string {
  return `${task.id}:${characterId}:${getTaskPeriodKey(task)}`;
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
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [activeSortableId, setActiveSortableId] = useState<string | null>(null);
  const [editingCharacter, setEditingCharacter] = useState<DashboardCharacter | null>(null);
  const [editingTask, setEditingTask] = useState<DashboardTask | null>(null);
  const taskOrderRef = useRef(taskOrder);
  const characterOrderRef = useRef(characterOrder);
  const orientation = dashboard.settings.checklist_orientation ?? "tasks_rows";
  const orderedTasks = orderItems(dashboard.tasks, taskOrder);
  const orderedCharacters = orderItems(dashboard.characters, characterOrder);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

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

  function moveOrder(kind: ReorderKind, activeId: string, overId: string) {
    const setter = kind === "task" ? setTaskOrder : setCharacterOrder;
    const orderRef = kind === "task" ? taskOrderRef : characterOrderRef;
    const fromIndex = orderRef.current.indexOf(activeId);
    const toIndex = orderRef.current.indexOf(overId);
    const next = moveItem(orderRef.current, fromIndex, toIndex);

    orderRef.current = next;
    setter(next);
    void saveOrder(kind, next);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveSortableId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveSortableId(null);
    const active = parseSortableItemId(String(event.active.id));
    const over = event.over ? parseSortableItemId(String(event.over.id)) : null;
    if (!active || !over || active.kind !== over.kind || active.id === over.id) return;
    moveOrder(active.kind, active.id, over.id);
  }

  function handleDragCancel() {
    setActiveSortableId(null);
  }

  const matrix = orientation === "tasks_columns" ? (
    <TaskColumnsMatrix
      characters={orderedCharacters}
      checked={checked}
      dashboard={dashboard}
      isReorderMode={isReorderMode}
      setChecked={setChecked}
      tasks={orderedTasks}
      onEditCharacter={setEditingCharacter}
      onEditTask={setEditingTask}
      onToggle={enqueue}
    />
  ) : (
    <TaskRowsMatrix
      characters={orderedCharacters}
      checked={checked}
      dashboard={dashboard}
      isReorderMode={isReorderMode}
      setChecked={setChecked}
      tasks={orderedTasks}
      onEditCharacter={setEditingCharacter}
      onEditTask={setEditingTask}
      onToggle={enqueue}
    />
  );

  return (
    <div className="matrix-board">
      <div className="matrix-toolbar">
        <button
          className={`button matrix-reorder-button${isReorderMode ? " active" : ""}`}
          type="button"
          onClick={() => {
            setActiveSortableId(null);
            setIsReorderMode((current) => !current);
          }}
        >
          {isReorderMode ? "순서 변경 완료" : "순서 변경"}
        </button>
      </div>
      {isReorderMode ? (
        <DndContext
          collisionDetection={closestCenter}
          sensors={sensors}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
          onDragStart={handleDragStart}
        >
          {matrix}
          <DragOverlay>{renderDragOverlay(activeSortableId, orderedTasks, orderedCharacters)}</DragOverlay>
        </DndContext>
      ) : (
        matrix
      )}
      {editingCharacter ? (
        <CharacterEditModal character={editingCharacter} onClose={() => setEditingCharacter(null)} />
      ) : null}
      {editingTask ? <TaskEditModal task={editingTask} onClose={() => setEditingTask(null)} /> : null}
    </div>
  );
}

interface MatrixRendererProps {
  dashboard: DashboardPayload;
  characters: DashboardCharacter[];
  tasks: DashboardTask[];
  checked: Record<string, boolean>;
  isReorderMode: boolean;
  setChecked: Dispatch<SetStateAction<Record<string, boolean>>>;
  onToggle: (patch: { taskId: string; characterId: string | null; periodKey: string; completed: boolean }) => void;
  onEditCharacter?: (character: DashboardCharacter) => void;
  onEditTask?: (task: DashboardTask) => void;
}

interface LabelCellProps {
  children: ReactNode;
  className: string;
  id: string;
  isReorderMode: boolean;
  kind: ReorderKind;
  label: string;
  onEdit?: () => void;
}

function LabelCell({ children, className, id, isReorderMode, kind, label, onEdit }: LabelCellProps) {
  if (!isReorderMode) {
    if (onEdit) {
      return (
        <button className={`${className} matrix-label-button`} type="button" aria-label={`${label} 편집`} onClick={onEdit}>
          {children}
        </button>
      );
    }
    return <div className={className}>{children}</div>;
  }

  return (
    <SortableLabelCell className={className} id={id} kind={kind} label={label}>
      {children}
    </SortableLabelCell>
  );
}

function SortableLabelCell({ children, className, id, kind, label }: Omit<LabelCellProps, "isReorderMode">) {
  const sortableId = getSortableItemId(kind, id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      className={`${className} matrix-sortable-cell${isDragging ? " dragging" : ""}`}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-label={`${label} 순서 이동`}
      data-reorder-id={id}
      data-reorder-kind={kind}
      data-reorder-target="true"
    >
      {children}
    </div>
  );
}

function TaskLabelContent({ task }: { task: DashboardTask }) {
  return (
    <>
      <span className="matrix-label-line">
        <span>{task.name}</span>
      </span>
      <small>{getResetTypeLabel(task.reset_type)}</small>
    </>
  );
}

function CharacterLabelContent({
  character,
  isReorderMode
}: {
  character: DashboardCharacter;
  isReorderMode: boolean;
}) {
  return (
    <>
      <span className="matrix-label-line">
        <span className="character-label" title={isReorderMode ? undefined : getCharacterDetail(character)}>
          {getCharacterLabel(character)}
        </span>
      </span>
      <small>{character.item_level}</small>
    </>
  );
}

function getResetTypeLabel(resetType: DashboardTask["reset_type"]): string {
  return resetType === "daily" ? "일간" : resetType === "weekly" ? "주간" : resetType === "biweekly" ? "격주간" : "커스텀";
}

function CharacterEditModal({ character, onClose }: { character: DashboardCharacter; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(character.display_name ?? "");
  const [serverName, setServerName] = useState(character.server_name);
  const [className, setClassName] = useState(character.class_name);
  const [itemLevel, setItemLevel] = useState(character.item_level);
  const [combatPower, setCombatPower] = useState(character.combat_power ?? "");
  const [memo, setMemo] = useState(character.memo ?? "");
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    try {
      await apiPatch(`/api/characters/${character.id}`, {
        displayName,
        serverName,
        className,
        itemLevel,
        combatPower: combatPower.trim() ? combatPower : null,
        memo: memo.trim() ? memo : null
      });
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "캐릭터 저장에 실패했습니다.");
    }
  }

  async function remove() {
    try {
      await apiDelete(`/api/characters/${character.id}`);
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "캐릭터 삭제에 실패했습니다.");
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="tool-modal edit-modal">
        <div className="tool-modal-header">
          <h2>캐릭터 수정</h2>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="tool-modal-body edit-form">
          <label>
            캐릭터 이름
            <input readOnly value={character.name} />
          </label>
          <label>
            축약 이름
            <input maxLength={20} placeholder={character.name} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            서버
            <input maxLength={20} value={serverName} onChange={(event) => setServerName(event.target.value)} />
          </label>
          <label>
            직업
            <input maxLength={30} value={className} onChange={(event) => setClassName(event.target.value)} />
          </label>
          <label>
            레벨
            <input maxLength={20} value={itemLevel} onChange={(event) => setItemLevel(event.target.value)} />
          </label>
          <label>
            전투력
            <input maxLength={30} value={combatPower} onChange={(event) => setCombatPower(event.target.value)} />
          </label>
          <label>
            메모
            <textarea maxLength={200} value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>
          {message ? <p className="error-text">{message}</p> : null}
          <div className="edit-actions">
            <button type="button" onClick={() => void save()}>
              저장
            </button>
            <button className="danger-button" type="button" onClick={() => void remove()}>
              삭제
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function TaskEditModal({ task, onClose }: { task: DashboardTask; onClose: () => void }) {
  const [name, setName] = useState(task.name);
  const [resetType, setResetType] = useState<DashboardTask["reset_type"]>(task.reset_type);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    try {
      await apiPatch(`/api/tasks/${task.id}`, { name, resetType });
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "숙제 저장에 실패했습니다.");
    }
  }

  async function remove() {
    try {
      await apiDelete(`/api/tasks/${task.id}`);
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "숙제 삭제에 실패했습니다.");
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="tool-modal edit-modal">
        <div className="tool-modal-header">
          <h2>숙제 수정</h2>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="tool-modal-body edit-form">
          <label>
            이름
            <input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            초기화 기간
            <select value={resetType} onChange={(event) => setResetType(event.target.value as DashboardTask["reset_type"])}>
              <option value="daily">일간</option>
              <option value="weekly">주간</option>
              <option value="biweekly">격주간</option>
              <option value="custom">커스텀</option>
            </select>
          </label>
          <p className="notice-text">현재 설정: {getResetTypeLabel(task.reset_type)}</p>
          {message ? <p className="error-text">{message}</p> : null}
          <div className="edit-actions">
            <button type="button" onClick={() => void save()}>
              저장
            </button>
            <button className="danger-button" type="button" onClick={() => void remove()}>
              삭제
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function renderDragOverlay(
  activeSortableId: string | null,
  tasks: DashboardTask[],
  characters: DashboardCharacter[]
): ReactNode {
  const active = activeSortableId ? parseSortableItemId(activeSortableId) : null;
  if (!active) return null;

  if (active.kind === "task") {
    const task = tasks.find((item) => item.id === active.id);
    return task ? (
      <div className="matrix-drag-overlay">
        <TaskLabelContent task={task} />
      </div>
    ) : null;
  }

  const character = characters.find((item) => item.id === active.id);
  return character ? (
    <div className="matrix-drag-overlay">
      <CharacterLabelContent character={character} isReorderMode />
    </div>
  ) : null;
}

function TaskRowsMatrix({
  dashboard,
  characters,
  tasks,
  checked,
  isReorderMode,
  setChecked,
  onToggle,
  onEditCharacter,
  onEditTask
}: MatrixRendererProps) {
  const columns = characters;
  const rowStyle = {
    "--column-count": columns.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;
  const taskSortableIds = tasks.map((task) => getSortableItemId("task", task.id));
  const characterSortableIds = characters.map((character) => getSortableItemId("character", character.id));

  const headerCells = columns.map((column) => {
    return (
      <LabelCell
        className="matrix-cell"
        id={column.id}
        isReorderMode={isReorderMode}
        key={column.id}
        kind="character"
        label={getCharacterLabel(column)}
        onEdit={() => onEditCharacter?.(column)}
      >
        <CharacterLabelContent character={column} isReorderMode={isReorderMode} />
      </LabelCell>
    );
  });

  const taskRows = tasks.map((task) => {
    const periodKey = getTaskPeriodKey(task);
    return (
      <div className="matrix-row" key={task.id} style={rowStyle}>
        <LabelCell
          className="matrix-task-cell"
          id={task.id}
          isReorderMode={isReorderMode}
          kind="task"
          label={task.name}
          onEdit={() => onEditTask?.(task)}
        >
          <TaskLabelContent task={task} />
        </LabelCell>
        {columns.map((column) => {
          const characterId = column.id;
          const key = getCompletionKey(task, characterId);
          return (
            <button
              className="matrix-cell matrix-check"
              disabled={isReorderMode}
              key={key}
              type="button"
              onClick={() => {
                const next = !checked[key];
                setChecked((current) => ({ ...current, [key]: next }));
                onToggle({ taskId: task.id, characterId, periodKey, completed: next });
              }}
            >
              {checked[key] ? "V" : ""}
            </button>
          );
        })}
      </div>
    );
  });

  return (
    <div className={`matrix density-${dashboard.settings.density}${isReorderMode ? " reorder-mode" : ""}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">숙제</div>
        {isReorderMode ? (
          <SortableContext items={characterSortableIds} strategy={horizontalListSortingStrategy}>
            {headerCells}
          </SortableContext>
        ) : (
          headerCells
        )}
      </div>
      {isReorderMode ? (
        <SortableContext items={taskSortableIds} strategy={verticalListSortingStrategy}>
          {taskRows}
        </SortableContext>
      ) : (
        taskRows
      )}
    </div>
  );
}

function TaskColumnsMatrix({
  dashboard,
  characters,
  tasks,
  checked,
  isReorderMode,
  setChecked,
  onToggle,
  onEditCharacter,
  onEditTask
}: MatrixRendererProps) {
  const rows = characters;
  const rowStyle = {
    "--column-count": tasks.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;
  const taskSortableIds = tasks.map((task) => getSortableItemId("task", task.id));
  const characterSortableIds = characters.map((character) => getSortableItemId("character", character.id));

  const taskHeaderCells = tasks.map((task) => (
    <LabelCell
      className="matrix-cell"
      id={task.id}
      isReorderMode={isReorderMode}
      key={task.id}
      kind="task"
      label={task.name}
      onEdit={() => onEditTask?.(task)}
    >
      <TaskLabelContent task={task} />
    </LabelCell>
  ));

  const matrixRows = rows.map((row) => {
    const characterId = row.id;
    return (
      <div className="matrix-row" key={row.id} style={rowStyle}>
        <LabelCell
          className="matrix-task-cell"
          id={row.id}
          isReorderMode={isReorderMode}
          kind="character"
          label={getCharacterLabel(row)}
          onEdit={() => onEditCharacter?.(row)}
        >
          <CharacterLabelContent character={row} isReorderMode={isReorderMode} />
        </LabelCell>
        {tasks.map((task) => {
          const periodKey = getTaskPeriodKey(task);
          const key = getCompletionKey(task, characterId);
          return (
            <button
              className="matrix-cell matrix-check"
              disabled={isReorderMode}
              key={key}
              type="button"
              onClick={() => {
                const next = !checked[key];
                setChecked((current) => ({ ...current, [key]: next }));
                onToggle({ taskId: task.id, characterId, periodKey, completed: next });
              }}
            >
              {checked[key] ? "V" : ""}
            </button>
          );
        })}
      </div>
    );
  });

  return (
    <div className={`matrix density-${dashboard.settings.density}${isReorderMode ? " reorder-mode" : ""}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">캐릭터</div>
        {isReorderMode ? (
          <SortableContext items={taskSortableIds} strategy={horizontalListSortingStrategy}>
            {taskHeaderCells}
          </SortableContext>
        ) : (
          taskHeaderCells
        )}
      </div>
      {isReorderMode ? (
        <SortableContext items={characterSortableIds} strategy={verticalListSortingStrategy}>
          {matrixRows}
        </SortableContext>
      ) : (
        matrixRows
      )}
    </div>
  );
}
