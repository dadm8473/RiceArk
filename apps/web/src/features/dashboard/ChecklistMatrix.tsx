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
import { Save, Trash2, X } from "lucide-react";
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

type DashboardSettings = DashboardPayload["settings"];

interface CharacterDisplaySettings {
  displayName: boolean;
  serverName: boolean;
  className: boolean;
  itemLevel: boolean;
  combatPower: boolean;
}

function getCharacterDisplaySettings(settings: DashboardSettings): CharacterDisplaySettings {
  return {
    displayName: settings.show_display_name !== 0,
    serverName: settings.show_server_name === 1,
    className: settings.show_class_name === 1,
    itemLevel: settings.show_item_level !== 0,
    combatPower: settings.show_combat_power === 1
  };
}

function getCharacterLabel(character: DashboardCharacter, settings: DashboardSettings): string {
  return getCharacterDisplaySettings(settings).displayName ? character.display_name?.trim() || character.name : character.name;
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

function getCharacterMeta(character: DashboardCharacter, settings: DashboardSettings): string[] {
  const display = getCharacterDisplaySettings(settings);
  return [
    display.serverName ? character.server_name : null,
    display.className ? character.class_name : null,
    display.itemLevel ? character.item_level : null,
    display.combatPower ? character.combat_power : null
  ].filter((value): value is string => Boolean(value));
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
          <DragOverlay>{renderDragOverlay(activeSortableId, orderedTasks, orderedCharacters, dashboard.settings)}</DragOverlay>
        </DndContext>
      ) : (
        matrix
      )}
      {editingCharacter ? (
        <CharacterEditModal character={editingCharacter} settings={dashboard.settings} onClose={() => setEditingCharacter(null)} />
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
  isReorderMode,
  settings
}: {
  character: DashboardCharacter;
  isReorderMode: boolean;
  settings: DashboardSettings;
}) {
  const meta = getCharacterMeta(character, settings);
  return (
    <>
      <span className="matrix-label-line">
        <span className="character-label" title={isReorderMode ? undefined : getCharacterDetail(character)}>
          {getCharacterLabel(character, settings)}
        </span>
      </span>
      {meta.length > 0 ? <small className="character-meta">{meta.join(" · ")}</small> : null}
    </>
  );
}

function getResetTypeLabel(resetType: DashboardTask["reset_type"]): string {
  if (resetType === "daily") return "일간";
  if (resetType === "weekly") return "주간";
  if (resetType === "biweekly") return "격주";
  if (resetType === "none") return "초기화 안함";
  return "커스텀";
}

export function CharacterEditModal({
  character,
  settings,
  onClose
}: {
  character: DashboardCharacter;
  settings: DashboardSettings;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState(character.display_name ?? "");
  const [itemLevel, setItemLevel] = useState(character.item_level);
  const [combatPower, setCombatPower] = useState(character.combat_power ?? "");
  const [memo, setMemo] = useState(character.memo ?? "");
  const [displaySettings, setDisplaySettings] = useState<CharacterDisplaySettings>(() => getCharacterDisplaySettings(settings));
  const [message, setMessage] = useState<string | null>(null);

  function updateDisplaySetting(key: keyof CharacterDisplaySettings, value: boolean) {
    setDisplaySettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    try {
      await apiPatch(`/api/characters/${character.id}`, {
        displayName,
        itemLevel,
        combatPower: combatPower.trim() ? combatPower : null,
        memo: memo.trim() ? memo : null
      });
      await apiPatch("/api/settings", { characterDisplay: displaySettings });
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
          <button className="modal-close-button" type="button" aria-label="닫기" title="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="tool-modal-body edit-form">
          <div className="readonly-value">
            <span>캐릭터 이름</span>
            <strong>{character.name}</strong>
          </div>
          <div className="character-detail-panel">
            <span>서버 {character.server_name}</span>
            <span>닉네임 {character.name}</span>
            <span>직업 {character.class_name}</span>
          </div>
          <div className="compact-edit-grid">
            <label>
              축약 이름
              <input maxLength={20} placeholder={character.name} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <label>
              레벨
              <input maxLength={20} value={itemLevel} onChange={(event) => setItemLevel(event.target.value)} />
            </label>
            <label>
              전투력
              <input maxLength={20} placeholder="정보 없음" value={combatPower} onChange={(event) => setCombatPower(event.target.value)} />
            </label>
          </div>
          {!character.combat_power ? (
            <p className="notice-text compact-notice">전투력이 비어 있으면 캐릭터 가져오기를 다시 실행하면 업데이트됩니다.</p>
          ) : null}
          <label className="memo-field">
            메모
            <textarea maxLength={200} value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>
          <fieldset className="visibility-fieldset">
            <legend>표시 정보</legend>
            <label className="toggle-row">
              <input
                checked={displaySettings.displayName}
                type="checkbox"
                onChange={(event) => updateDisplaySetting("displayName", event.target.checked)}
              />
              축약 이름 표시
            </label>
            <label className="toggle-row">
              <input
                checked={displaySettings.serverName}
                type="checkbox"
                onChange={(event) => updateDisplaySetting("serverName", event.target.checked)}
              />
              서버 표시
            </label>
            <label className="toggle-row">
              <input
                checked={displaySettings.className}
                type="checkbox"
                onChange={(event) => updateDisplaySetting("className", event.target.checked)}
              />
              직업 표시
            </label>
            <label className="toggle-row">
              <input
                checked={displaySettings.itemLevel}
                type="checkbox"
                onChange={(event) => updateDisplaySetting("itemLevel", event.target.checked)}
              />
              레벨 표시
            </label>
            <label className="toggle-row">
              <input
                checked={displaySettings.combatPower}
                type="checkbox"
                onChange={(event) => updateDisplaySetting("combatPower", event.target.checked)}
              />
              전투력 표시
            </label>
          </fieldset>
          {message ? <p className="error-text">{message}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" type="button" onClick={() => void remove()}>
              <Trash2 size={16} />
              캐릭터 삭제
            </button>
            <button className="primary-button" type="button" onClick={() => void save()}>
              <Save size={16} />
              저장
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function TaskEditModal({ task, onClose }: { task: DashboardTask; onClose: () => void }) {
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
          <button className="modal-close-button" type="button" aria-label="닫기" title="닫기" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="tool-modal-body edit-form">
          <label>
            이름
            <input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            초기화 주기
            <select value={resetType} onChange={(event) => setResetType(event.target.value as DashboardTask["reset_type"])}>
              <option value="daily">일간</option>
              <option value="weekly">주간</option>
              <option value="biweekly">격주</option>
              <option value="none">초기화 안함</option>
            </select>
          </label>
          <p className="notice-text">현재 설정: {getResetTypeLabel(task.reset_type)}</p>
          {message ? <p className="error-text">{message}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" type="button" onClick={() => void remove()}>
              <Trash2 size={16} />
              숙제 삭제
            </button>
            <button className="primary-button" type="button" onClick={() => void save()}>
              <Save size={16} />
              저장
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
  characters: DashboardCharacter[],
  settings: DashboardSettings
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
      <CharacterLabelContent character={character} isReorderMode settings={settings} />
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
        label={getCharacterLabel(column, dashboard.settings)}
        onEdit={() => onEditCharacter?.(column)}
      >
        <CharacterLabelContent character={column} isReorderMode={isReorderMode} settings={dashboard.settings} />
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
          label={getCharacterLabel(row, dashboard.settings)}
          onEdit={() => onEditCharacter?.(row)}
        >
          <CharacterLabelContent character={row} isReorderMode={isReorderMode} settings={dashboard.settings} />
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
