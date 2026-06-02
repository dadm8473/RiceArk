import { Columns3, Plus, Rows3, Save, Settings, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode } from "react";
import { apiDelete, apiPatch, apiPost } from "../../api/client";
import { CharacterImport } from "../characters/CharacterImport";
import { TaskForm } from "../tasks/TaskForm";
import { applyBoardCompletionPatch, getBoardCellPeriodKey, type BoardCompletionPatch } from "./completions";
import { normalizeBoundedIntegerDraft } from "./numberInput";
import {
  applyBoardTableLayoutPatch,
  getBoardTableMovePatch,
  type BoardTableLayoutPatch,
  type BoardTableLayoutPointerStart
} from "./tableLayout";
import type { BoardAxisItem, BoardOrientation, BoardPayload, BoardTable } from "./types";
import { useBoardCompletionQueue } from "./useBoardCompletionQueue";

interface Props {
  board: BoardPayload;
  onBoardChanged?: () => Promise<BoardPayload> | void;
}

type BoardDisplaySettings = BoardPayload["settings"];
type BoardDisplaySettingKey = keyof BoardDisplaySettings;

interface BoardCharacterDisplaySettings {
  displayName: boolean;
  serverName: boolean;
  className: boolean;
  itemLevel: boolean;
  combatPower: boolean;
}

interface BoardAxisSeparator {
  widthPx: number;
  style: "solid" | "dashed" | "dotted";
  color: string;
}

interface ActiveTableTool {
  table: BoardTable;
  tool: "characters" | "tasks";
}

interface TableMoveSession {
  tableId: string;
  pointerId: number;
  start: BoardTableLayoutPointerStart;
  patch: BoardTableLayoutPatch | null;
}

const BOARD_CANVAS_MIN_WIDTH = 480;
const BOARD_CANVAS_MIN_HEIGHT = 260;
const BOARD_TABLE_FALLBACK_WIDTH = 360;
const BOARD_TABLE_FALLBACK_HEIGHT = 240;
const BOARD_TABLE_HORIZONTAL_CHROME = 30;
const BOARD_TABLE_VERTICAL_CHROME = 96;

function cellKey(rowItemId: string, columnItemId: string): string {
  return JSON.stringify([rowItemId, columnItemId]);
}

function getTaskColor(row: BoardAxisItem, column: BoardAxisItem): string | null {
  if (row.kind === "task") return row.task_color;
  if (column.kind === "task") return column.task_color;
  return null;
}

function getCharacterDisplaySettings(settings: BoardDisplaySettings): BoardCharacterDisplaySettings {
  return {
    displayName: settings.show_display_name !== 0,
    serverName: settings.show_server_name === 1,
    className: settings.show_class_name === 1,
    itemLevel: settings.show_item_level !== 0,
    combatPower: settings.show_combat_power === 1
  };
}

function parseBoardDisplaySettings(settingsJson: string | null | undefined): BoardDisplaySettings | null {
  if (!settingsJson) return null;

  try {
    const value = JSON.parse(settingsJson) as Partial<BoardDisplaySettings>;
    const normalized: BoardDisplaySettings = {
      show_display_name: value.show_display_name === 0 ? 0 : 1,
      show_server_name: value.show_server_name === 1 ? 1 : 0,
      show_class_name: value.show_class_name === 1 ? 1 : 0,
      show_item_level: value.show_item_level === 0 ? 0 : 1,
      show_combat_power: value.show_combat_power === 1 ? 1 : 0
    };
    return normalized;
  } catch {
    return null;
  }
}

function getEffectiveBoardDisplaySettings(
  item: BoardAxisItem,
  table: BoardTable,
  boardSettings: BoardDisplaySettings
): BoardDisplaySettings {
  return parseBoardDisplaySettings(item.display_options_json) ?? parseBoardDisplaySettings(table.display_options_json) ?? boardSettings;
}

function getBoardCharacterName(item: BoardAxisItem): string {
  return item.character_name?.trim() || item.label;
}

function getBoardCharacterLabel(item: BoardAxisItem, settings: BoardDisplaySettings): string {
  const display = getCharacterDisplaySettings(settings);
  if (!display.displayName) return getBoardCharacterName(item);
  return item.character_display_name?.trim() || getBoardCharacterName(item);
}

function getBoardCharacterDetail(item: BoardAxisItem): string {
  return [
    item.character_server_name,
    getBoardCharacterName(item),
    item.character_class_name,
    item.character_item_level,
    item.character_combat_power
  ]
    .filter(Boolean)
    .join(" / ");
}

function getBoardCharacterMeta(item: BoardAxisItem, settings: BoardDisplaySettings): string[] {
  const display = getCharacterDisplaySettings(settings);
  return [
    display.serverName ? item.character_server_name : null,
    display.className ? item.character_class_name : null,
    display.itemLevel ? item.character_item_level : null,
    display.combatPower ? item.character_combat_power : null
  ].filter((value): value is string => Boolean(value));
}

export function shouldSaveBoardCharacterDetails(
  item: BoardAxisItem,
  displayName: string,
  itemLevel: string,
  combatPower: string
): boolean {
  if (item.kind !== "character" || !item.character_id) return false;

  return (
    displayName.trim() !== (item.character_display_name ?? "") ||
    itemLevel.trim() !== (item.character_item_level ?? "") ||
    combatPower.trim() !== (item.character_combat_power ?? "")
  );
}

function buildGridColumns(table: BoardTable, columns: BoardAxisItem[]): string {
  return `160px ${columns.map((column) => `${column.size_px ?? table.default_column_width}px`).join(" ")}`;
}

function parseBoardAxisSeparator(separatorJson: string | null | undefined): BoardAxisSeparator | null {
  if (!separatorJson) return null;

  try {
    const value = JSON.parse(separatorJson) as Partial<BoardAxisSeparator>;
    if (typeof value.widthPx !== "number" || !Number.isInteger(value.widthPx) || value.widthPx < 1 || value.widthPx > 8) {
      return null;
    }
    if (value.style !== "solid" && value.style !== "dashed" && value.style !== "dotted") return null;
    if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) return null;

    return {
      widthPx: value.widthPx,
      style: value.style,
      color: value.color.toLowerCase()
    };
  } catch {
    return null;
  }
}

function getSeparatorBorder(item: BoardAxisItem): string | undefined {
  const separator = parseBoardAxisSeparator(item.separator_json);
  return separator ? `${separator.widthPx}px ${separator.style} ${separator.color}` : undefined;
}

function getEstimatedBoardTableSize(table: BoardTable, axisItems: BoardAxisItem[]): { width: number; height: number } {
  const rows = axisItems.filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1);
  const columns = axisItems.filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1);
  if (rows.length === 0 || columns.length === 0) {
    return {
      width: BOARD_TABLE_FALLBACK_WIDTH,
      height: BOARD_TABLE_FALLBACK_HEIGHT
    };
  }

  const rowHeight = rows.reduce((total, row) => total + (row.size_px ?? table.default_row_height), 0);
  const columnWidth = columns.reduce((total, column) => total + (column.size_px ?? table.default_column_width), 0);

  return {
    width: Math.max(BOARD_TABLE_FALLBACK_WIDTH, 160 + columnWidth + BOARD_TABLE_HORIZONTAL_CHROME),
    height: Math.max(BOARD_TABLE_FALLBACK_HEIGHT, rowHeight + BOARD_TABLE_VERTICAL_CHROME)
  };
}

function getBoardCanvasStyle(tables: BoardTable[], axisItems: BoardAxisItem[]): CSSProperties {
  const width = Math.max(
    BOARD_CANVAS_MIN_WIDTH,
    ...tables.map((table) => table.x + getEstimatedBoardTableSize(table, axisItems).width)
  );
  const height = Math.max(
    BOARD_CANVAS_MIN_HEIGHT,
    ...tables.map((table) => table.y + getEstimatedBoardTableSize(table, axisItems).height)
  );

  return {
    "--board-canvas-width": `${width}px`,
    "--board-canvas-height": `${height}px`
  } as CSSProperties;
}

function getBoardTableStyle(table: BoardTable): CSSProperties {
  return {
    left: `${table.x}px`,
    top: `${table.y}px`
  };
}

export function BoardOverview({ board, onBoardChanged }: Props) {
  const { enqueue } = useBoardCompletionQueue();
  const [completions, setCompletions] = useState(board.completions);
  const [cellStates, setCellStates] = useState(board.cellStates);
  const [axisItems, setAxisItems] = useState(board.axisItems);
  const [tables, setTables] = useState(board.tables);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [tableName, setTableName] = useState("");
  const [tableOrientation, setTableOrientation] = useState<BoardOrientation>("custom");
  const [tableDefaultRowHeight, setTableDefaultRowHeight] = useState("40");
  const [tableDefaultColumnWidth, setTableDefaultColumnWidth] = useState("132");
  const [tableDisplaySettings, setTableDisplaySettings] = useState<BoardDisplaySettings>(board.settings);
  const [isCreateTableOpen, setIsCreateTableOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"sheet" | "table" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingAxisItem, setEditingAxisItem] = useState<BoardAxisItem | null>(null);
  const [activeTableTool, setActiveTableTool] = useState<ActiveTableTool | null>(null);
  const [editingTable, setEditingTable] = useState<BoardTable | null>(null);
  const [movingTableId, setMovingTableId] = useState<string | null>(null);
  const tableMoveSessionRef = useRef<TableMoveSession | null>(null);
  const sortedSheets = useMemo(
    () => board.sheets.slice().sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)),
    [board.sheets]
  );
  const activeSheet =
    sortedSheets.find((sheet) => sheet.id === activeSheetId) ??
    sortedSheets.find((sheet) => sheet.is_default === 1) ??
    sortedSheets[0];
  useEffect(() => {
    setCompletions(board.completions);
  }, [board.completions]);

  useEffect(() => {
    setCellStates(board.cellStates);
  }, [board.cellStates]);

  useEffect(() => {
    setAxisItems(board.axisItems);
  }, [board.axisItems]);

  useEffect(() => {
    setTables(board.tables);
  }, [board.tables]);

  function handleCompletionToggle(patch: BoardCompletionPatch) {
    setCompletions((current) => applyBoardCompletionPatch(current, patch));
    enqueue(patch);
  }

  async function handleAxisItemSave(
    axisItemId: string,
    label: string,
    taskColor?: string | null,
    separator?: BoardAxisSeparator | null,
    sizePx?: number | null,
    displaySettings?: BoardDisplaySettings | null,
    shouldUpdateDetails = true
  ) {
    if (shouldUpdateDetails) {
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(axisItemId), {
        label,
        taskColor,
        separator,
        displaySettings
      });
    }
    if (sizePx !== undefined && sizePx !== null) {
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(axisItemId) + "/size", { sizePx });
    }
    setAxisItems((current) =>
      current.map((item) =>
        item.id === axisItemId
          ? {
              ...item,
              label: shouldUpdateDetails ? label : item.label,
              task_color: shouldUpdateDetails && taskColor !== undefined ? taskColor : item.task_color,
              separator_json: shouldUpdateDetails
                ? separator === undefined
                  ? item.separator_json
                  : separator === null
                    ? null
                    : JSON.stringify(separator)
                : item.separator_json,
              size_px: sizePx === undefined || sizePx === null ? item.size_px : sizePx,
              display_options_json:
                !shouldUpdateDetails || displaySettings === undefined
                  ? item.display_options_json
                  : displaySettings === null
                    ? null
                    : JSON.stringify(displaySettings)
            }
          : item
      )
    );
    setEditingAxisItem(null);
  }

  async function handleBoardCharacterSave(
    characterId: string,
    input: {
      displayName: string | null;
      itemLevel: string;
      combatPower: string | null;
    }
  ) {
    await apiPatch("/api/characters/" + encodeURIComponent(characterId), input);
    setAxisItems((current) =>
      current.map((item) =>
        item.character_id === characterId
          ? {
              ...item,
              character_display_name: input.displayName,
              character_item_level: input.itemLevel,
              character_combat_power: input.combatPower
            }
          : item
      )
    );
  }

  async function handleAxisItemDelete(axisItemId: string) {
    await apiDelete("/api/board/axis-items/" + encodeURIComponent(axisItemId));
    setAxisItems((current) => current.map((item) => (item.id === axisItemId ? { ...item, visible: 0 } : item)));
    setEditingAxisItem(null);
  }

  async function refreshBoard() {
    if (onBoardChanged) {
      await onBoardChanged();
      return;
    }
    window.location.reload();
  }

  async function handleCreateSheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sheetName.trim();
    if (!name) return;

    setPendingAction("sheet");
    setFormError(null);
    try {
      const sheet = await apiPost<{ id: string }>("/api/board/sheets", { name });
      setSheetName("");
      setActiveSheetId(sheet.id);
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "시트를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCreateTable() {
    if (!activeSheet) return;
    const name = tableName.trim();
    if (!name) return;

    setPendingAction("table");
    setFormError(null);
    try {
      await apiPost<{ id: string }>("/api/board/tables", {
        sheetId: activeSheet.id,
        name,
        orientation: tableOrientation,
        defaultRowHeight: normalizeBoundedIntegerDraft(tableDefaultRowHeight, { min: 16, max: 1024, fallback: 40 }),
        defaultColumnWidth: normalizeBoundedIntegerDraft(tableDefaultColumnWidth, { min: 16, max: 1024, fallback: 132 }),
        displaySettings: tableDisplaySettings
      });
      setTableName("");
      setTableOrientation("custom");
      setTableDefaultRowHeight("40");
      setTableDefaultColumnWidth("132");
      setTableDisplaySettings(board.settings);
      setIsCreateTableOpen(false);
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "표를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleTableSettingsSave(
    tableId: string,
    input: {
      name: string;
      defaultRowHeight: number;
      defaultColumnWidth: number;
      displaySettings: BoardDisplaySettings | null;
      applyRowSize: boolean;
      applyColumnSize: boolean;
      characterSeparator?: BoardAxisSeparator | null | undefined;
    }
  ) {
    await apiPatch("/api/board/tables/" + encodeURIComponent(tableId), {
      name: input.name,
      defaultRowHeight: input.defaultRowHeight,
      defaultColumnWidth: input.defaultColumnWidth,
      displaySettings: input.displaySettings
    });
    const rows = axisItems.filter((item) => item.table_id === tableId && item.axis === "row" && item.visible === 1);
    const columns = axisItems.filter((item) => item.table_id === tableId && item.axis === "column" && item.visible === 1);
    const characterItems = axisItems.filter((item) => item.table_id === tableId && item.kind === "character" && item.visible === 1);

    if (input.applyRowSize) {
      await Promise.all(rows.map((item) => apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id) + "/size", { sizePx: input.defaultRowHeight })));
    }
    if (input.applyColumnSize) {
      await Promise.all(
        columns.map((item) => apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id) + "/size", { sizePx: input.defaultColumnWidth }))
      );
    }
    if (input.characterSeparator !== undefined) {
      await Promise.all(
        characterItems.map((item) =>
          apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id), {
            label: item.label,
            separator: input.characterSeparator
          })
        )
      );
    }

    setTables((current) =>
      current.map((table) =>
        table.id === tableId
          ? {
              ...table,
              name: input.name,
              default_row_height: input.defaultRowHeight,
              default_column_width: input.defaultColumnWidth,
              display_options_json: input.displaySettings ? JSON.stringify(input.displaySettings) : null
            }
          : table
      )
    );
    setAxisItems((current) =>
      current.map((item) => {
        if (item.table_id !== tableId) return item;
        if (input.applyRowSize && item.axis === "row") return { ...item, size_px: input.defaultRowHeight };
        if (input.applyColumnSize && item.axis === "column") return { ...item, size_px: input.defaultColumnWidth };
        if (input.characterSeparator !== undefined && item.kind === "character") {
          return {
            ...item,
            separator_json: input.characterSeparator === null ? null : JSON.stringify(input.characterSeparator)
          };
        }
        return item;
      })
    );
    setEditingTable(null);
  }

  async function handleTableDelete(tableId: string) {
    await apiDelete("/api/board/tables/" + encodeURIComponent(tableId));
    setTables((current) => current.filter((table) => table.id !== tableId));
    setAxisItems((current) => current.filter((item) => item.table_id !== tableId));
    setEditingTable(null);
  }

  function handleTableMoveStart(table: BoardTable, event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setFormError(null);
    setMovingTableId(table.id);
    tableMoveSessionRef.current = {
      tableId: table.id,
      pointerId: event.pointerId,
      start: {
        x: table.x,
        y: table.y,
        width: table.width,
        height: table.height,
        pointerX: event.clientX,
        pointerY: event.clientY
      },
      patch: null
    };
  }

  function handleTableMove(tableId: string, event: PointerEvent<HTMLButtonElement>) {
    const session = tableMoveSessionRef.current;
    if (!session || session.tableId !== tableId || session.pointerId !== event.pointerId) return;

    const patch = getBoardTableMovePatch(session.start, {
      pointerX: event.clientX,
      pointerY: event.clientY
    });
    session.patch = patch;
    setTables((current) => applyBoardTableLayoutPatch(current, tableId, patch));
  }

  function finishTableMove(tableId: string, event: PointerEvent<HTMLButtonElement>) {
    const session = tableMoveSessionRef.current;
    if (!session || session.tableId !== tableId || session.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    tableMoveSessionRef.current = null;
    setMovingTableId(null);

    if (session.patch) {
      void persistTableLayout(tableId, session.patch);
    }
  }

  async function persistTableLayout(tableId: string, patch: BoardTableLayoutPatch) {
    try {
      await apiPatch("/api/board/tables/" + encodeURIComponent(tableId) + "/layout", patch);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "표 위치를 저장하지 못했습니다.");
      await refreshBoard();
    }
  }

  if (!activeSheet) {
    return (
      <section className="board-overview" aria-label="보드">
        <p className="board-empty">보드 데이터를 준비하는 중입니다.</p>
      </section>
    );
  }

  const activeTables = tables
    .filter((table) => table.sheet_id === activeSheet.id)
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name));

  const boardCanvas = (
    <div className="board-canvas" style={getBoardCanvasStyle(activeTables, axisItems)}>
      {activeTables.length === 0 ? <p className="board-empty">이 시트에는 아직 표가 없습니다.</p> : null}
      {activeTables.length > 0 ? (
        <div className="board-canvas-space">
          {activeTables.map((table) => (
            <article
              key={table.id}
              className={`board-table-summary${movingTableId === table.id ? " moving" : ""}`}
              style={getBoardTableStyle(table)}
            >
              <div className="board-table-heading">
                <button
                  className="board-table-title board-table-move-handle"
                  type="button"
                  aria-label={`${table.name} 표 이동`}
                  title="표 제목을 드래그해서 이동"
                  onPointerCancel={(event) => finishTableMove(table.id, event)}
                  onPointerDown={(event) => handleTableMoveStart(table, event)}
                  onPointerMove={(event) => handleTableMove(table.id, event)}
                  onPointerUp={(event) => finishTableMove(table.id, event)}
                >
                  <strong>{table.name}</strong>
                </button>
                <div className="board-table-actions">
                  <button
                    type="button"
                    aria-label={`${table.name} 캐릭터 추가 또는 가져오기`}
                    title="캐릭터 추가/가져오기"
                    onClick={() => setActiveTableTool({ table, tool: "characters" })}
                  >
                    <UserPlus aria-hidden="true" size={14} />
                    캐릭터
                  </button>
                  <button
                    type="button"
                    aria-label={`${table.name} 숙제 추가`}
                    title="숙제 추가"
                    onClick={() => setActiveTableTool({ table, tool: "tasks" })}
                  >
                    <Plus aria-hidden="true" size={14} />
                    숙제
                  </button>
                  <button type="button" aria-label={`${table.name} 표 설정`} title="표 설정" onClick={() => setEditingTable(table)}>
                    <Settings aria-hidden="true" size={14} />
                    설정
                  </button>
                </div>
              </div>
              <BoardTableGrid
                axisItems={axisItems}
                cellStates={cellStates}
                completions={completions}
                table={table}
                onAxisItemEdit={setEditingAxisItem}
                onToggle={handleCompletionToggle}
                settings={board.settings}
              />
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <section className="board-overview" aria-label="보드">
      <div className="sheet-tab-bar" aria-label="시트">
        <span className="sheet-tab-label">시트</span>
        {sortedSheets.map((sheet) => (
          <button
            key={sheet.id}
            type="button"
            className={`sheet-tab${sheet.id === activeSheet.id ? " active" : ""}`}
            aria-current={sheet.id === activeSheet.id ? "page" : undefined}
            onClick={() => setActiveSheetId(sheet.id)}
          >
            {sheet.name}
          </button>
        ))}
        <form className="board-create-form" aria-label="시트 추가" onSubmit={handleCreateSheet}>
          <input
            aria-label="새 시트 이름"
            maxLength={30}
            placeholder="새 시트"
            value={sheetName}
            onChange={(event) => setSheetName(event.currentTarget.value)}
          />
          <button disabled={pendingAction === "sheet"} type="submit">
            시트 추가
          </button>
        </form>
      </div>
      <div className="board-toolbar">
        <button className="button" disabled={!activeSheet} type="button" onClick={() => setIsCreateTableOpen(true)}>
          <Plus aria-hidden="true" size={16} />
          표 추가
        </button>
        {formError ? <p className="board-form-error">{formError}</p> : null}
      </div>
      {boardCanvas}
      {isCreateTableOpen ? (
        <BoardTableCreateModal
          defaultColumnWidth={tableDefaultColumnWidth}
          defaultRowHeight={tableDefaultRowHeight}
          displaySettings={tableDisplaySettings}
          isPending={pendingAction === "table"}
          name={tableName}
          orientation={tableOrientation}
          onClose={() => setIsCreateTableOpen(false)}
          onDefaultColumnWidthChange={setTableDefaultColumnWidth}
          onDefaultRowHeightChange={setTableDefaultRowHeight}
          onDisplaySettingsChange={setTableDisplaySettings}
          onNameChange={setTableName}
          onOrientationChange={setTableOrientation}
          onSubmit={() => void handleCreateTable()}
        />
      ) : null}
      {activeTableTool ? (
        <BoardTableToolModal
          table={activeTableTool.table}
          tool={activeTableTool.tool}
          onClose={() => setActiveTableTool(null)}
          onSaved={async () => {
            setActiveTableTool(null);
            await refreshBoard();
          }}
        />
      ) : null}
      {editingAxisItem ? (
        <BoardAxisItemEditModal
          item={editingAxisItem}
          settings={board.settings}
          table={tables.find((table) => table.id === editingAxisItem.table_id) ?? null}
          onClose={() => setEditingAxisItem(null)}
          onCharacterSave={handleBoardCharacterSave}
          onDelete={handleAxisItemDelete}
          onSave={handleAxisItemSave}
        />
      ) : null}
      {editingTable ? (
        <BoardTableSettingsModal
          axisItems={axisItems.filter((item) => item.table_id === editingTable.id && item.visible === 1)}
          settings={board.settings}
          table={editingTable}
          onClose={() => setEditingTable(null)}
          onDelete={handleTableDelete}
          onSave={handleTableSettingsSave}
        />
      ) : null}
    </section>
  );
}

function BoardDisplayOptions({ onChange, settings }: { onChange: (settings: BoardDisplaySettings) => void; settings: BoardDisplaySettings }) {
  const options: Array<{ key: BoardDisplaySettingKey; label: string }> = [
    { key: "show_display_name", label: "축약" },
    { key: "show_server_name", label: "서버" },
    { key: "show_class_name", label: "직업" },
    { key: "show_item_level", label: "레벨" },
    { key: "show_combat_power", label: "전투력" }
  ];

  return (
    <fieldset className="board-display-options">
      <legend>표시 옵션</legend>
      {options.map((option) => (
        <label key={option.key}>
          <input
            checked={settings[option.key] !== 0}
            type="checkbox"
            onChange={(event) => onChange({ ...settings, [option.key]: event.currentTarget.checked ? 1 : 0 })}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function BoardTableToolModal({
  onClose,
  onSaved,
  table,
  tool
}: {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  table: BoardTable;
  tool: "characters" | "tasks";
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`tool-modal${tool === "tasks" ? " task-tool-modal" : ""}`} aria-modal="true" role="dialog">
        <header className="tool-modal-header">
          <h2>{tool === "characters" ? "캐릭터 추가/가져오기" : "숙제 추가"}</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body">
          {tool === "characters" ? <CharacterImport tableId={table.id} onSaved={onSaved} /> : <TaskForm tableId={table.id} onSaved={onSaved} />}
        </div>
      </section>
    </div>
  );
}

function BoardTableCreateModal({
  defaultColumnWidth,
  defaultRowHeight,
  displaySettings,
  isPending,
  name,
  onClose,
  onDefaultColumnWidthChange,
  onDefaultRowHeightChange,
  onDisplaySettingsChange,
  onNameChange,
  onOrientationChange,
  onSubmit,
  orientation
}: {
  defaultColumnWidth: string;
  defaultRowHeight: string;
  displaySettings: BoardDisplaySettings;
  isPending: boolean;
  name: string;
  onClose: () => void;
  onDefaultColumnWidthChange: (value: string) => void;
  onDefaultRowHeightChange: (value: string) => void;
  onDisplaySettingsChange: (settings: BoardDisplaySettings) => void;
  onNameChange: (name: string) => void;
  onOrientationChange: (orientation: BoardOrientation) => void;
  onSubmit: () => void;
  orientation: BoardOrientation;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal table-config-modal" aria-modal="true" role="dialog" aria-label="표 추가">
        <header className="tool-modal-header">
          <h2>표 추가</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form
          className="tool-modal-body edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label>
            표 이름
            <input aria-label="새 표 이름" maxLength={30} value={name} onChange={(event) => onNameChange(event.currentTarget.value)} />
          </label>
          <fieldset className="visibility-fieldset">
            <legend>행/열 표시 방향</legend>
            <div className="orientation-option-grid">
              <label className="orientation-option">
                <input
                  checked={orientation === "tasks_rows"}
                  type="radio"
                  name="table-orientation"
                  onChange={() => onOrientationChange("tasks_rows")}
                />
                <Columns3 aria-hidden="true" size={16} />
                숙제 행 / 캐릭터 열
                <small>예: 쿠르잔 전선 x 냠수나이스1</small>
              </label>
              <label className="orientation-option">
                <input
                  checked={orientation === "tasks_columns"}
                  type="radio"
                  name="table-orientation"
                  onChange={() => onOrientationChange("tasks_columns")}
                />
                <Rows3 aria-hidden="true" size={16} />
                캐릭터 행 / 숙제 열
                <small>예: 냠수나이스1 x 쿠르잔 전선</small>
              </label>
            </div>
          </fieldset>
          <div className="compact-edit-grid">
            <label>
              각 행의 높이
              <input
                max={1024}
                min={16}
                type="number"
                value={defaultRowHeight}
                onChange={(event) => onDefaultRowHeightChange(event.currentTarget.value)}
              />
            </label>
            <label>
              각 열의 너비
              <input
                max={1024}
                min={16}
                type="number"
                value={defaultColumnWidth}
                onChange={(event) => onDefaultColumnWidthChange(event.currentTarget.value)}
              />
            </label>
          </div>
          <BoardDisplayOptions settings={displaySettings} onChange={onDisplaySettingsChange} />
          <div className="edit-actions">
            <button disabled={isPending} type="button" onClick={onClose}>
              취소
            </button>
            <button className="primary-button" disabled={isPending || !name.trim()} type="submit">
              <Save aria-hidden="true" size={16} />표 추가
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function BoardTableSettingsModal({
  axisItems,
  onClose,
  onDelete,
  onSave,
  settings,
  table
}: {
  axisItems: BoardAxisItem[];
  onClose: () => void;
  onDelete: (tableId: string) => Promise<void>;
  onSave: (
    tableId: string,
    input: {
      name: string;
      defaultRowHeight: number;
      defaultColumnWidth: number;
      displaySettings: BoardDisplaySettings | null;
      applyRowSize: boolean;
      applyColumnSize: boolean;
      characterSeparator?: BoardAxisSeparator | null | undefined;
    }
  ) => Promise<void>;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const [name, setName] = useState(table.name);
  const [rowHeight, setRowHeight] = useState(String(table.default_row_height));
  const [columnWidth, setColumnWidth] = useState(String(table.default_column_width));
  const [displaySettings, setDisplaySettings] = useState(parseBoardDisplaySettings(table.display_options_json) ?? settings);
  const [applyRowSize, setApplyRowSize] = useState(true);
  const [applyColumnSize, setApplyColumnSize] = useState(true);
  const [applyCharacterSeparator, setApplyCharacterSeparator] = useState(false);
  const [separatorWidthPx, setSeparatorWidthPx] = useState("2");
  const [separatorStyle, setSeparatorStyle] = useState<BoardAxisSeparator["style"]>("solid");
  const [separatorColor, setSeparatorColor] = useState("#64748b");
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const characterSeparators = axisItems.filter((item) => item.kind === "character").map((item) => item.separator_json ?? null);
  const mixedCharacterSeparators = new Set(characterSeparators).size > 1;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    try {
      await onSave(table.id, {
        name: name.trim(),
        defaultRowHeight: normalizeBoundedIntegerDraft(rowHeight, { min: 16, max: 1024, fallback: table.default_row_height }),
        defaultColumnWidth: normalizeBoundedIntegerDraft(columnWidth, { min: 16, max: 1024, fallback: table.default_column_width }),
        displaySettings,
        applyRowSize,
        applyColumnSize,
        characterSeparator: applyCharacterSeparator
          ? {
              widthPx: normalizeBoundedIntegerDraft(separatorWidthPx, { min: 1, max: 8, fallback: 2 }),
              style: separatorStyle,
              color: separatorColor
            }
          : undefined
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "표 설정을 저장하지 못했습니다.");
      setPending(null);
    }
  }

  async function remove() {
    setPending("delete");
    setError(null);
    try {
      await onDelete(table.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "표를 삭제하지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal table-config-modal" aria-modal="true" role="dialog" aria-label="표 설정">
        <header className="tool-modal-header">
          <h2>표 설정</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="tool-modal-body edit-form" onSubmit={submit}>
          <label>
            표 이름
            <input maxLength={30} value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <div className="compact-edit-grid">
            <label>
              행 높이 일괄값
              <input max={1024} min={16} type="number" value={rowHeight} onChange={(event) => setRowHeight(event.currentTarget.value)} />
              <span className="inline-check">
                <input checked={applyRowSize} type="checkbox" onChange={(event) => setApplyRowSize(event.currentTarget.checked)} />
                기존 행 적용
              </span>
            </label>
            <label>
              열 너비 일괄값
              <input
                max={1024}
                min={16}
                type="number"
                value={columnWidth}
                onChange={(event) => setColumnWidth(event.currentTarget.value)}
              />
              <span className="inline-check">
                <input checked={applyColumnSize} type="checkbox" onChange={(event) => setApplyColumnSize(event.currentTarget.checked)} />
                기존 열 적용
              </span>
            </label>
          </div>
          <fieldset className="visibility-fieldset">
            <legend>캐릭터 구분선</legend>
            <p className="compact-notice">
              현재 값: {characterSeparators.length === 0 ? "없음" : mixedCharacterSeparators ? "섞임" : characterSeparators[0] ? "설정됨" : "없음"}
            </p>
            <label className="toggle-row">
              <input
                checked={applyCharacterSeparator}
                type="checkbox"
                onChange={(event) => setApplyCharacterSeparator(event.currentTarget.checked)}
              />
              캐릭터 구분선 일괄 추가
            </label>
            {applyCharacterSeparator ? (
              <div className="separator-edit-grid">
                <label>
                  두께
                  <input
                    max={8}
                    min={1}
                    type="number"
                    value={separatorWidthPx}
                    onChange={(event) => setSeparatorWidthPx(event.currentTarget.value)}
                  />
                </label>
                <label>
                  종류
                  <select value={separatorStyle} onChange={(event) => setSeparatorStyle(event.currentTarget.value as BoardAxisSeparator["style"])}>
                    <option value="solid">실선</option>
                    <option value="dashed">파선</option>
                    <option value="dotted">점선</option>
                  </select>
                </label>
                <label>
                  색상
                  <input
                    aria-label={`${table.name} 캐릭터 구분선 색상`}
                    className="color-edit-input"
                    type="color"
                    value={separatorColor}
                    onChange={(event) => setSeparatorColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </fieldset>
          <BoardDisplayOptions settings={displaySettings} onChange={setDisplaySettings} />
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" disabled={pending !== null} type="button" onClick={() => void remove()}>
              <Trash2 aria-hidden="true" size={16} />
              표 삭제
            </button>
            <button className="primary-button" disabled={pending !== null || !name.trim()} type="submit">
              <Save aria-hidden="true" size={16} />
              저장
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function BoardTableGrid({
  axisItems,
  cellStates,
  completions,
  table,
  onAxisItemEdit,
  onToggle,
  settings
}: {
  axisItems: BoardAxisItem[];
  cellStates: BoardPayload["cellStates"];
  completions: BoardPayload["completions"];
  table: BoardTable;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
  settings: BoardDisplaySettings;
}) {
  const rows = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const columns = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const hiddenCells = new Set(
    cellStates
      .filter((cell) => cell.table_id === table.id && cell.checkbox_visible === 0)
      .map((cell) => cellKey(cell.row_item_id, cell.column_item_id))
  );
  const completedCells = new Set(
    completions
      .filter((completion) => completion.table_id === table.id && completion.completed === 1)
      .map((completion) => cellKey(completion.row_item_id, completion.column_item_id))
  );

  if (rows.length === 0 || columns.length === 0) {
    return <p className="board-empty">이 표에는 아직 행 또는 열이 없습니다.</p>;
  }

  return (
    <div className="board-check-grid" style={{ gridTemplateColumns: buildGridColumns(table, columns) }}>
      <div className="board-axis-corner" />
      {columns.map((column) => (
        <BoardColumnHeader key={column.id} column={column} onAxisItemEdit={onAxisItemEdit} settings={settings} table={table} />
      ))}
      {rows.map((row) => (
        <BoardGridRow
          key={row.id}
          columns={columns}
          completedCells={completedCells}
          hiddenCells={hiddenCells}
          onAxisItemEdit={onAxisItemEdit}
          onToggle={onToggle}
          row={row}
          rowHeight={row.size_px ?? table.default_row_height}
          settings={settings}
          table={table}
        />
      ))}
    </div>
  );
}

function BoardColumnHeader({
  column,
  onAxisItemEdit,
  settings,
  table
}: {
  column: BoardAxisItem;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const columnSeparator = getSeparatorBorder(column);

  return (
    <BoardAxisLabel
      className="board-axis-label board-column-label"
      item={column}
      onEdit={() => onAxisItemEdit(column)}
      style={columnSeparator ? { borderRight: columnSeparator } : undefined}
    >
      <BoardAxisLabelText item={column} settings={getEffectiveBoardDisplaySettings(column, table, settings)} />
    </BoardAxisLabel>
  );
}

function BoardAxisLabelText({
  item,
  settings
}: {
  item: BoardAxisItem;
  settings: BoardDisplaySettings;
}) {
  if (item.kind === "character") {
    const meta = getBoardCharacterMeta(item, settings);
    const detail = getBoardCharacterDetail(item);
    return (
      <span className="board-axis-label-text board-character-axis-label">
        <span className="board-character-label" title={detail}>
          {getBoardCharacterLabel(item, settings)}
        </span>
        {meta.length > 0 ? <small className="board-character-meta">{meta.join(" · ")}</small> : null}
      </span>
    );
  }

  return (
    <span className="board-axis-label-text">
      {item.kind === "task" && item.task_color ? (
        <span
          aria-label={`${item.label} 색상 ${item.task_color}`}
          className="board-task-color-swatch"
          style={{ background: item.task_color }}
        />
      ) : null}
      <span className="board-task-label">{item.label}</span>
    </span>
  );
}

function BoardAxisLabel({
  children,
  className,
  item,
  onEdit,
  style
}: {
  children: ReactNode;
  className: string;
  item: BoardAxisItem;
  onEdit?: () => void;
  style?: CSSProperties | undefined;
}) {
  if (onEdit) {
    return (
      <button className={`${className} board-axis-edit-button`} style={style} type="button" aria-label={`${item.label} 편집`} onClick={onEdit}>
        {children}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

function BoardGridRow({
  columns,
  completedCells,
  hiddenCells,
  onAxisItemEdit,
  onToggle,
  row,
  rowHeight,
  settings,
  table
}: {
  columns: BoardAxisItem[];
  completedCells: Set<string>;
  hiddenCells: Set<string>;
  onAxisItemEdit: (item: BoardAxisItem) => void;
  onToggle: (patch: BoardCompletionPatch) => void;
  row: BoardAxisItem;
  rowHeight: number;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const rowSeparator = getSeparatorBorder(row);

  return (
    <>
      <BoardAxisLabel
        className="board-axis-label board-row-label"
        item={row}
        onEdit={() => onAxisItemEdit(row)}
        style={{ minHeight: `${rowHeight}px`, ...(rowSeparator ? { borderBottom: rowSeparator } : {}) }}
      >
        <BoardAxisLabelText item={row} settings={getEffectiveBoardDisplaySettings(row, table, settings)} />
      </BoardAxisLabel>
      {columns.map((column) => {
        const key = cellKey(row.id, column.id);
        const taskColor = getTaskColor(row, column);
        const colorStyle = taskColor ? ({ "--task-color": taskColor } as CSSProperties) : undefined;
        const columnSeparator = getSeparatorBorder(column);
        const periodKey = getBoardCellPeriodKey(row, column);
        const isHidden = hiddenCells.has(key);
        const cellStyle: CSSProperties = {
          minHeight: `${rowHeight}px`,
          ...(rowSeparator ? { borderBottom: rowSeparator } : {}),
          ...(columnSeparator ? { borderRight: columnSeparator } : {})
        };

        return (
          <div key={column.id} className="board-check-cell" style={cellStyle}>
            {isHidden ? (
              <span className="board-check-placeholder" aria-label={`${row.label} / ${column.label} 숨김`} />
            ) : (
              <input
                aria-label={`${row.label} / ${column.label}`}
                checked={completedCells.has(key)}
                className="board-check"
                disabled={!periodKey}
                onChange={(event) => {
                  if (!periodKey) return;
                  onToggle({
                    tableId: table.id,
                    rowItemId: row.id,
                    columnItemId: column.id,
                    periodKey,
                    completed: event.currentTarget.checked
                  });
                }}
                style={colorStyle}
                type="checkbox"
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function BoardAxisItemEditModal({
  item,
  onClose,
  onCharacterSave,
  onDelete,
  onSave,
  settings,
  table
}: {
  item: BoardAxisItem;
  settings: BoardDisplaySettings;
  table: BoardTable | null;
  onClose: () => void;
  onCharacterSave: (
    characterId: string,
    input: {
      displayName: string | null;
      itemLevel: string;
      combatPower: string | null;
    }
  ) => Promise<void>;
  onDelete: (axisItemId: string) => Promise<void>;
  onSave: (
    axisItemId: string,
    label: string,
    taskColor?: string | null,
    separator?: BoardAxisSeparator | null,
    sizePx?: number | null,
    displaySettings?: BoardDisplaySettings | null,
    shouldUpdateDetails?: boolean
  ) => Promise<void>;
}) {
  const initialSeparator = parseBoardAxisSeparator(item.separator_json);
  const [label, setLabel] = useState(item.label);
  const sizeFallback = item.axis === "row" ? table?.default_row_height ?? 40 : table?.default_column_width ?? 132;
  const [sizePx, setSizePx] = useState(String(item.size_px ?? sizeFallback));
  const [characterDisplayName, setCharacterDisplayName] = useState(item.character_display_name ?? "");
  const [characterItemLevel, setCharacterItemLevel] = useState(item.character_item_level ?? "");
  const [characterCombatPower, setCharacterCombatPower] = useState(item.character_combat_power ?? "");
  const initialTaskColor = item.task_color ?? "#2563eb";
  const [taskColor, setTaskColor] = useState(initialTaskColor);
  const initialDisplaySettings =
    parseBoardDisplaySettings(item.display_options_json) ?? (table ? parseBoardDisplaySettings(table.display_options_json) : null) ?? settings;
  const [displaySettings, setDisplaySettings] = useState(initialDisplaySettings);
  const [separatorEnabled, setSeparatorEnabled] = useState(initialSeparator !== null);
  const [separatorWidthPx, setSeparatorWidthPx] = useState(String(initialSeparator?.widthPx ?? 2));
  const [separatorStyle, setSeparatorStyle] = useState<BoardAxisSeparator["style"]>(initialSeparator?.style ?? "solid");
  const [separatorColor, setSeparatorColor] = useState(initialSeparator?.color ?? "#64748b");
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const normalizedLabel = label.trim();
  const isTaskItem = item.kind === "task";
  const isCharacterItem = item.kind === "character";
  const isImportedCharacterItem = isCharacterItem && Boolean(item.character_id);
  const normalizedCharacterDisplayName = characterDisplayName.trim();
  const normalizedCharacterItemLevel = characterItemLevel.trim();
  const normalizedCharacterCombatPower = characterCombatPower.trim();
  const canSave = isImportedCharacterItem ? Boolean(normalizedCharacterItemLevel) : Boolean(normalizedLabel);
  const separator = separatorEnabled
    ? {
        widthPx: normalizeBoundedIntegerDraft(separatorWidthPx, { min: 1, max: 8, fallback: initialSeparator?.widthPx ?? 2 }),
        style: separatorStyle,
        color: separatorColor
      }
    : null;
  const shouldUpdateAxisDetails =
    (!isImportedCharacterItem && normalizedLabel !== item.label) ||
    (isTaskItem && taskColor !== initialTaskColor) ||
    JSON.stringify(separator) !== JSON.stringify(initialSeparator) ||
    (isCharacterItem && JSON.stringify(displaySettings) !== JSON.stringify(initialDisplaySettings));

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedLabel) return;

    setPending("save");
    setError(null);
    try {
      if (
        isImportedCharacterItem &&
        item.character_id &&
        shouldSaveBoardCharacterDetails(item, characterDisplayName, characterItemLevel, characterCombatPower)
      ) {
        await onCharacterSave(item.character_id, {
          displayName: normalizedCharacterDisplayName ? normalizedCharacterDisplayName : null,
          itemLevel: normalizedCharacterItemLevel,
          combatPower: normalizedCharacterCombatPower ? normalizedCharacterCombatPower : null
        });
      }
      await onSave(
        item.id,
        isImportedCharacterItem ? item.label : normalizedLabel,
        isTaskItem ? taskColor : undefined,
        separator,
        normalizeBoundedIntegerDraft(sizePx, { min: 16, max: 1024, fallback: sizeFallback }),
        isCharacterItem ? displaySettings : undefined,
        shouldUpdateAxisDetails
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "항목을 저장하지 못했습니다.");
      setPending(null);
    }
  }

  async function handleDelete() {
    setPending("delete");
    setError(null);
    try {
      await onDelete(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "항목을 삭제하지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal" aria-modal="true" role="dialog" aria-label="행 또는 열 수정">
        <header className="tool-modal-header">
          <h2>항목 수정</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="tool-modal-body edit-form" onSubmit={handleSave}>
          {isImportedCharacterItem ? null : (
            <label>
              이름
              <input maxLength={30} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
            </label>
          )}
          {isCharacterItem ? (
            <div className="character-detail-panel">
              <span>서버 {item.character_server_name ?? "-"}</span>
              <span>닉네임 {getBoardCharacterName(item)}</span>
              <span>직업 {item.character_class_name ?? "-"}</span>
            </div>
          ) : null}
          {isImportedCharacterItem ? (
            <div className="compact-edit-grid">
              <label>
                축약 이름
                <input
                  maxLength={20}
                  placeholder={getBoardCharacterName(item)}
                  value={characterDisplayName}
                  onChange={(event) => setCharacterDisplayName(event.currentTarget.value)}
                />
              </label>
              <label>
                레벨
                <input
                  maxLength={20}
                  value={characterItemLevel}
                  onChange={(event) => setCharacterItemLevel(event.currentTarget.value)}
                />
              </label>
              <label>
                전투력
                <input
                  maxLength={20}
                  placeholder="정보 없음"
                  value={characterCombatPower}
                  onChange={(event) => setCharacterCombatPower(event.currentTarget.value)}
                />
              </label>
            </div>
          ) : null}
          <label>
            {item.axis === "row" ? "행 높이" : "열 너비"}
            <input
              max={1024}
              min={16}
              type="number"
              value={sizePx}
              onChange={(event) => setSizePx(event.currentTarget.value)}
            />
          </label>
          {isTaskItem ? (
            <label>
              체크 색상
              <span className="color-edit-row">
                <input
                  aria-label={`${item.label} 체크 색상`}
                  className="color-edit-input"
                  type="color"
                  value={taskColor}
                  onChange={(event) => setTaskColor(event.currentTarget.value)}
                />
                <span>{taskColor}</span>
              </span>
            </label>
          ) : null}
          {isCharacterItem ? <BoardDisplayOptions settings={displaySettings} onChange={setDisplaySettings} /> : null}
          <fieldset className="visibility-fieldset">
            <legend>구분선</legend>
            <label className="toggle-row">
              <input
                checked={separatorEnabled}
                type="checkbox"
                onChange={(event) => setSeparatorEnabled(event.currentTarget.checked)}
              />
              이 항목 뒤에 구분선 표시
            </label>
            {separatorEnabled ? (
              <div className="separator-edit-grid">
                <label>
                  두께
                  <input
                    max={8}
                    min={1}
                    type="number"
                    value={separatorWidthPx}
                    onChange={(event) => setSeparatorWidthPx(event.currentTarget.value)}
                  />
                </label>
                <label>
                  종류
                  <select
                    value={separatorStyle}
                    onChange={(event) => setSeparatorStyle(event.currentTarget.value as BoardAxisSeparator["style"])}
                  >
                    <option value="solid">실선</option>
                    <option value="dashed">파선</option>
                    <option value="dotted">점선</option>
                  </select>
                </label>
                <label>
                  색상
                  <input
                    aria-label={`${item.label} 구분선 색상`}
                    className="color-edit-input"
                    type="color"
                    value={separatorColor}
                    onChange={(event) => setSeparatorColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </fieldset>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" disabled={pending !== null} type="button" onClick={() => void handleDelete()}>
              <Trash2 aria-hidden="true" size={16} />
              항목 삭제
            </button>
            <button className="primary-button" disabled={pending !== null || !canSave} type="submit">
              <Save aria-hidden="true" size={16} />
              저장
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
