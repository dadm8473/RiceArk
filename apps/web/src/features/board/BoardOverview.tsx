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
import { AlertTriangle, Bell, Check, Clock, Columns3, Flag, Lock, Minus, Pencil, Pin, Plus, RefreshCw, Rows3, Save, Settings, Shuffle, Star, StickyNote, Tag, Trash2, Unlock, UserPlus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../api/client";
import { CharacterImport } from "../characters/CharacterImport";
import { TaskForm } from "../tasks/TaskForm";
import { BoardNoteMarkdown } from "./BoardNoteMarkdown";
import {
  applyBoardCellStatePatch,
  resolveBoardCellMark,
  type BoardCellMark,
  type BoardCellMarkIcon,
  type BoardCellMarkRetention,
  type BoardCellMarkType,
  type BoardCellStatePatch
} from "./cellStates";
import {
  applyBoardCompletionPatch,
  applyPendingBoardCompletionPatches,
  getBoardCellPeriodKey,
  type BoardCompletionPatch
} from "./completions";
import { normalizeBoundedIntegerDraft } from "./numberInput";
import {
  applyBoardAxisOrder,
  getBoardAxisSortableId,
  moveBoardAxisItemIds,
  parseBoardAxisSortableId
} from "./reorder";
import {
  applyBoardTableLayoutPatch,
  getBoardTableMovePatch,
  type BoardTableLayoutPatch,
  type BoardTableLayoutPointerStart
} from "./tableLayout";
import type { BoardAxis, BoardAxisItem, BoardCellState, BoardNote, BoardOrientation, BoardPayload, BoardSheet, BoardTable } from "./types";
import { useBoardCompletionQueue } from "./useBoardCompletionQueue";

interface Props {
  board: BoardPayload;
  onBoardChanged?: () => Promise<BoardPayload | null> | void;
  readOnly?: boolean | undefined;
}

type BoardDisplaySettings = BoardPayload["settings"];
type BoardDisplaySettingKey = keyof BoardDisplaySettings;
type BoardTaskResetType = Exclude<NonNullable<BoardAxisItem["task_reset_type"]>, "custom">;
type BoardTableTemplate = "custom" | "lostark_event";
type LostArkEventRewardFilter = "gold" | "card" | "coin" | "silver" | "cardXp";

interface BoardCharacterDisplaySettings {
  displayName: boolean;
  serverName: boolean;
  className: boolean;
  itemLevel: boolean;
  combatPower: boolean;
}

interface BoardCharacterSaveInput {
  name?: string | undefined;
  serverName?: string | null | undefined;
  className?: string | null | undefined;
  displayName: string | null;
  itemLevel: string | null;
  combatPower: string | null;
}

interface BoardCharacterRefreshResult {
  name: string;
  serverName: string;
  className: string;
  itemLevel: string;
  combatPower: string | null;
}

export interface TableCharacterRefreshSummary {
  failedCount: number;
  refreshedCount: number;
  totalCount: number;
}

interface BoardAxisSeparator {
  widthPx: number;
  style: "solid" | "dashed" | "dotted";
  color: string;
}

interface ActiveTableTool {
  table: BoardTable;
  tool: "characters" | "tasks" | "event-columns";
}

interface BoardNoteSaveInput {
  title: string;
  body: string;
  color: string;
  width: number;
  height: number;
  locked?: 0 | 1 | undefined;
}

type BoardNoteSavePatch = Partial<BoardNoteSaveInput>;

interface TableMoveSession {
  tableId: string;
  pointerId: number;
  start: BoardTableLayoutPointerStart;
  patch: BoardTableLayoutPatch | null;
}

interface BoardNoteLayoutPatch {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function buildBoardNoteSavePatch(_note: BoardNote, input: Partial<BoardNoteSaveInput>): BoardNoteSavePatch {
  const patch: BoardNoteSavePatch = {};
  if (input.title !== undefined) patch.title = input.title.trim() || "메모";
  if (input.body !== undefined) patch.body = input.body;
  if (input.color !== undefined) patch.color = input.color;
  if (input.width !== undefined) patch.width = input.width;
  if (input.height !== undefined) patch.height = input.height;
  if (input.locked !== undefined) patch.locked = input.locked;
  return patch;
}

interface NoteMoveSession {
  noteId: string;
  pointerId: number;
  start: BoardNoteLayoutPatch & {
    pointerX: number;
    pointerY: number;
  };
  patch: BoardNoteLayoutPatch | null;
}

interface NoteResizeSession {
  noteId: string;
  pointerId: number;
  start: BoardNoteLayoutPatch & {
    pointerX: number;
    pointerY: number;
  };
  patch: BoardNoteLayoutPatch | null;
}

interface BoardEventOptions {
  rewardFilters: LostArkEventRewardFilter[];
}

interface LostArkSimpleEventSummary {
  available: boolean;
  detail: string | null;
  futureTimes: string[];
  nextTime: string | null;
  remainingMinutes: number | null;
}

interface LostArkAdventureIslandEntry {
  claimLabel: string;
  continent: string;
  futureTimes: string[];
  islandName: string;
  rewards: string[];
  slotLabel: string;
}

interface LostArkEventTodaySummary {
  adventureIsland: {
    endedRewardLabels: string[];
    entries: LostArkAdventureIslandEntry[];
    nextTime: string | null;
    remainingMinutes: number | null;
    rewardLabels: string[];
    rule: string;
  };
  chaosGate: LostArkSimpleEventSummary;
  fieldBoss: LostArkSimpleEventSummary;
  today: string;
}

export interface BoardEventNotificationSettings {
  enabled: boolean;
  leadMinutes: number[];
}

export interface BoardEventNotificationDueItem {
  body: string;
  label: string;
  leadMinutes: number;
  sentKey: string;
  title: string;
}

type BoardEventNotificationPermission = NotificationPermission | "unsupported";

const BOARD_CANVAS_MIN_WIDTH = 480;
const BOARD_CANVAS_MIN_HEIGHT = 260;
const BOARD_CANVAS_EDGE_PADDING = 40;
const BOARD_TABLE_FALLBACK_WIDTH = 360;
const BOARD_TABLE_FALLBACK_HEIGHT = 240;
const BOARD_NOTE_DEFAULT_COLOR = "#fef3c7";
const BOARD_NOTE_TITLE_MAX_LENGTH = 80;
const BOARD_NOTE_BODY_MAX_LENGTH = 5000;
const BOARD_NOTE_MIN_WIDTH = 80;
const BOARD_NOTE_MIN_HEIGHT = 64;
const BOARD_NOTE_MAX_WIDTH = 2400;
const BOARD_NOTE_MAX_HEIGHT = 2400;
const BOARD_ROW_HEADER_FALLBACK_WIDTH = 160;
const BOARD_COLUMN_HEADER_FALLBACK_HEIGHT = 30;
const BOARD_TABLE_HORIZONTAL_CHROME = 30;
const BOARD_TABLE_VERTICAL_CHROME = 96;
const BOARD_AXIS_PRIMARY_SIZE_MIN = 16;
const BOARD_AXIS_LABEL_SIZE_MIN = 1;
const BOARD_AXIS_SIZE_MAX = 1024;
const CHARACTER_REFRESH_CLIENT_COOLDOWN_MS = 60_000;
const BOARD_ZOOM_STORAGE_KEY = "riceark-board-zoom";
const BOARD_ZOOM_DEFAULT = 100;
const BOARD_ZOOM_MIN = 50;
const BOARD_ZOOM_MAX = 150;
const BOARD_ZOOM_STEP = 5;
const BOARD_EVENT_COUNTDOWN_REFRESH_MS = 30_000;
const BOARD_EVENT_NOTIFICATION_STORAGE_PREFIX = "riceark-board-event-notifications:";
const BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTE = 5;
const BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES = [BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTE];
const BOARD_EVENT_NOTIFICATION_PRESET_MINUTES = [5, 10];
const BOARD_EVENT_NOTIFICATION_MIN_MINUTES = 1;
const BOARD_EVENT_NOTIFICATION_MAX_MINUTES = 180;
const BOARD_DISPLAY_OPTIONS: Array<{ key: BoardDisplaySettingKey; label: string }> = [
  { key: "show_display_name", label: "축약" },
  { key: "show_server_name", label: "서버" },
  { key: "show_class_name", label: "직업" },
  { key: "show_item_level", label: "레벨" },
  { key: "show_combat_power", label: "전투력" }
];
const BOARD_DISPLAY_OPTION_KEYS = BOARD_DISPLAY_OPTIONS.map((option) => option.key);
const BOARD_TASK_RESET_OPTIONS: Array<{ value: BoardTaskResetType; label: string }> = [
  { value: "daily", label: "일간" },
  { value: "weekly", label: "주간" },
  { value: "biweekly", label: "격주" },
  { value: "none", label: "초기화 안함" }
];
const BOARD_CELL_MARK_ICON_OPTIONS: Array<{ value: BoardCellMarkIcon; label: string }> = [
  { value: "memo", label: "메모" },
  { value: "pin", label: "핀" },
  { value: "clock", label: "시계" },
  { value: "star", label: "별" },
  { value: "alert", label: "주의" },
  { value: "flag", label: "깃발" },
  { value: "tag", label: "태그" }
];
const BOARD_CELL_MARK_ICON_LABELS: Record<BoardCellMarkIcon, string> = {
  memo: "메모",
  pin: "핀",
  clock: "시계",
  star: "별",
  alert: "주의",
  flag: "깃발",
  tag: "태그"
};

export interface BoardCellMarkBrush {
  disabled: boolean;
  icon: BoardCellMarkIcon | null;
  retention: BoardCellMarkRetention;
  memo: string;
}

type BoardCellMarkPaintHandler = (
  row: BoardAxisItem,
  column: BoardAxisItem,
  currentMark: BoardCellMark | null,
  periodKey: string | null
) => void;
const LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS: LostArkEventRewardFilter[] = ["gold", "card", "coin", "silver", "cardXp"];
const LOST_ARK_EVENT_TABLE_DEFAULT_COMPLETION_COLUMN = "완료";
const LOST_ARK_EVENT_TABLE_ROW_HEADER_WIDTH = 420;
const LOST_ARK_EVENT_TABLE_COMPLETION_COLUMN_WIDTH = 86;
const LOST_ARK_EVENT_TABLE_ROWS: Array<{ color: string; height: number; label: string }> = [
  { label: "카게", color: "#2563eb", height: 62 },
  { label: "필보", color: "#be123c", height: 62 },
  { label: "모험섬", color: "#7c3aed", height: 138 }
];
const LOST_ARK_EVENT_REWARD_FILTER_OPTIONS: Array<{ value: LostArkEventRewardFilter; label: string }> = [
  { value: "gold", label: "쌀(골드)" },
  { value: "card", label: "카드 팩" },
  { value: "coin", label: "해적 주화" },
  { value: "silver", label: "실링" },
  { value: "cardXp", label: "카드 경험치" }
];

export function normalizeBoardZoom(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return BOARD_ZOOM_DEFAULT;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return BOARD_ZOOM_DEFAULT;

  const stepped = Math.round(numeric / BOARD_ZOOM_STEP) * BOARD_ZOOM_STEP;
  return Math.min(BOARD_ZOOM_MAX, Math.max(BOARD_ZOOM_MIN, stepped));
}

export function getStoredBoardZoom(storage: Pick<Storage, "getItem"> | null | undefined): number {
  try {
    const storedZoom = storage?.getItem(BOARD_ZOOM_STORAGE_KEY);
    return storedZoom === null || storedZoom === undefined ? BOARD_ZOOM_DEFAULT : normalizeBoardZoom(storedZoom);
  } catch {
    return BOARD_ZOOM_DEFAULT;
  }
}

function getBoardEventNotificationStorageKey(tableId: string): string {
  return `${BOARD_EVENT_NOTIFICATION_STORAGE_PREFIX}${tableId}`;
}

export function normalizeBoardEventNotificationMinutes(values: unknown): number[] {
  const source = Array.isArray(values) ? values : [];
  const normalized = source
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value))
    .filter((value) => value >= BOARD_EVENT_NOTIFICATION_MIN_MINUTES && value <= BOARD_EVENT_NOTIFICATION_MAX_MINUTES);
  return normalized.length > 0 ? [Math.max(...normalized)] : BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES;
}

export function getBoardEventNotificationCurrentLabel(settings: BoardEventNotificationSettings): string {
  const [selectedMinute] = normalizeBoardEventNotificationMinutes(settings.leadMinutes);
  return `현재 설정: ${selectedMinute ?? BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTE}분 전`;
}

export function getBoardEventNotificationSettingsForMinuteSelection(
  settings: BoardEventNotificationSettings,
  minute: number,
  permission: BoardEventNotificationPermission
): BoardEventNotificationSettings {
  const [selectedMinute] = normalizeBoardEventNotificationMinutes([minute]);
  return {
    ...settings,
    enabled: permission === "granted",
    leadMinutes: [selectedMinute ?? BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTE]
  };
}

function normalizeBoardEventNotificationSettings(value: unknown): BoardEventNotificationSettings {
  if (!value || typeof value !== "object") {
    return { enabled: false, leadMinutes: BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES };
  }
  const input = value as Partial<BoardEventNotificationSettings>;
  return {
    enabled: input.enabled === true,
    leadMinutes: normalizeBoardEventNotificationMinutes(input.leadMinutes)
  };
}

export function getStoredBoardEventNotificationSettings(
  storage: Pick<Storage, "getItem"> | null | undefined,
  tableId: string
): BoardEventNotificationSettings {
  try {
    const stored = storage?.getItem(getBoardEventNotificationStorageKey(tableId));
    return stored ? normalizeBoardEventNotificationSettings(JSON.parse(stored)) : { enabled: false, leadMinutes: BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES };
  } catch {
    return { enabled: false, leadMinutes: BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES };
  }
}

function storeBoardEventNotificationSettings(storage: Pick<Storage, "setItem"> | null | undefined, tableId: string, settings: BoardEventNotificationSettings) {
  const nextSettings = normalizeBoardEventNotificationSettings(settings);
  storage?.setItem(getBoardEventNotificationStorageKey(tableId), JSON.stringify(nextSettings));
}

function getBoardEventNotificationPermission(): BoardEventNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

async function requestBoardEventNotificationPermission(): Promise<BoardEventNotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission === "default") {
    return window.Notification.requestPermission();
  }
  return window.Notification.permission;
}

function getBoardZoomScale(boardZoom: number): number {
  return normalizeBoardZoom(boardZoom) / 100;
}

function isLostArkEventRewardFilter(value: unknown): value is LostArkEventRewardFilter {
  return LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.some((option) => option.value === value);
}

export function parseBoardEventOptions(optionsJson: string | null | undefined): BoardEventOptions {
  if (!optionsJson) return { rewardFilters: LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS };

  try {
    const value = JSON.parse(optionsJson) as Partial<BoardEventOptions>;
    const rewardFilters = Array.isArray(value.rewardFilters)
      ? value.rewardFilters.filter(isLostArkEventRewardFilter)
      : LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS;
    return {
      rewardFilters: value.rewardFilters === undefined ? LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS : [...new Set(rewardFilters)]
    };
  } catch {
    return { rewardFilters: LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS };
  }
}

export function getBoardEventRewardFilterSummary(rewardFilters: LostArkEventRewardFilter[]): string {
  const uniqueFilters = [...new Set(rewardFilters)];
  if (uniqueFilters.length === LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.length) return "전부";
  return uniqueFilters
    .map((filter) => LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.find((option) => option.value === filter)?.label)
    .filter((label): label is string => Boolean(label))
    .join(" / ");
}

function getKstClockMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: "Asia/Seoul"
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return Number(value("hour")) * 60 + Number(value("minute"));
}

function getClockMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function getEventRemainingMinutes(nextTime: string | null, now: Date = new Date()): number | null {
  if (!nextTime) return null;
  const currentMinutes = getKstClockMinutes(now);
  const targetMinutes = getClockMinutes(nextTime);
  const adjustedTargetMinutes = targetMinutes < currentMinutes ? targetMinutes + 24 * 60 : targetMinutes;
  return Math.max(0, adjustedTargetMinutes - currentMinutes);
}

function formatEventRemaining(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === 0) return "곧 시작";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}시간 ${rest}분 남음` : `${rest}분 남음`;
}

export function getLostArkScheduleCountdownLabel(label: string, nextTime: string | null, now: Date = new Date()): string {
  if (!nextTime) return `${label} 오늘 남은 시간 없음`;
  const remaining = formatEventRemaining(getEventRemainingMinutes(nextTime, now));
  return `${label} ${nextTime}${remaining ? ` · ${remaining}` : ""}`;
}

export function getLostArkAdventureRuleLabel(rule: string): string {
  return rule.includes("9/11/13") ? "일일 2회" : "일일 1회";
}

export function getBoardScheduleRowAvailable(label: string, summary: LostArkEventTodaySummary | null | undefined): boolean {
  if (!summary) return true;
  if (label === "카게") return summary.chaosGate.available;
  if (label === "필보") return summary.fieldBoss.available;
  if (label === "모험섬") return summary.adventureIsland.entries.length > 0 || summary.adventureIsland.endedRewardLabels.length > 0;
  return true;
}

function getBoardEventNotificationSentKey(tableId: string, today: string, label: string, nextTime: string): string {
  return [tableId, today, label, nextTime].join(":");
}

function getBoardEventNotificationMatchedLeadMinutes(settings: BoardEventNotificationSettings, remainingMinutes: number | null): number | null {
  if (remainingMinutes === null || remainingMinutes < 0) return null;
  const [leadMinutes] = normalizeBoardEventNotificationMinutes(settings.leadMinutes);
  if (!leadMinutes || remainingMinutes > leadMinutes) return null;
  return leadMinutes;
}

function getBoardSimpleEventNotificationDueItem({
  label,
  now,
  sentKeys,
  settings,
  summary,
  tableId,
  today
}: {
  label: string;
  now: Date;
  sentKeys: Set<string>;
  settings: BoardEventNotificationSettings;
  summary: LostArkSimpleEventSummary;
  tableId: string;
  today: string;
}): BoardEventNotificationDueItem | null {
  if (!summary.nextTime) return null;
  const remainingMinutes = getEventRemainingMinutes(summary.nextTime, now);
  const leadMinutes = getBoardEventNotificationMatchedLeadMinutes(settings, remainingMinutes);
  if (!leadMinutes) return null;
  const sentKey = getBoardEventNotificationSentKey(tableId, today, label, summary.nextTime);
  if (sentKeys.has(sentKey)) return null;
  return {
    body: `${summary.nextTime} 시작 예정`,
    label,
    leadMinutes,
    sentKey,
    title: `${label} ${leadMinutes}분 전`
  };
}

export function getBoardEventNotificationDueItems({
  now,
  sentKeys,
  settings,
  summary,
  tableId
}: {
  now: Date;
  sentKeys: Set<string>;
  settings: BoardEventNotificationSettings;
  summary: LostArkEventTodaySummary;
  tableId: string;
}): BoardEventNotificationDueItem[] {
  if (!settings.enabled) return [];
  const dueItems: BoardEventNotificationDueItem[] = [];
  const chaosGate = getBoardSimpleEventNotificationDueItem({
    label: "카게",
    now,
    sentKeys,
    settings,
    summary: summary.chaosGate,
    tableId,
    today: summary.today
  });
  if (chaosGate) dueItems.push(chaosGate);

  const fieldBoss = getBoardSimpleEventNotificationDueItem({
    label: "필보",
    now,
    sentKeys,
    settings,
    summary: summary.fieldBoss,
    tableId,
    today: summary.today
  });
  if (fieldBoss) dueItems.push(fieldBoss);

  if (summary.adventureIsland.nextTime) {
    const remainingMinutes = getEventRemainingMinutes(summary.adventureIsland.nextTime, now);
    const leadMinutes = getBoardEventNotificationMatchedLeadMinutes(settings, remainingMinutes);
    if (leadMinutes) {
      const sentKey = getBoardEventNotificationSentKey(tableId, summary.today, "모험섬", summary.adventureIsland.nextTime);
      if (!sentKeys.has(sentKey)) {
        const islandSummary = summary.adventureIsland.entries
          .map((entry) => `${entry.islandName} · ${entry.rewards.join(", ")}`)
          .join("\n");
        dueItems.push({
          body: [`${summary.adventureIsland.nextTime} 시작 예정`, islandSummary].filter(Boolean).join("\n"),
          label: "모험섬",
          leadMinutes,
          sentKey,
          title: `모험섬 ${leadMinutes}분 전`
        });
      }
    }
  }

  return dueItems;
}

function shouldRefreshEventSummary(summary: LostArkEventTodaySummary, now: Date): boolean {
  return [summary.chaosGate.nextTime, summary.fieldBoss.nextTime, summary.adventureIsland.nextTime].some(
    (nextTime) => getEventRemainingMinutes(nextTime, now) === 0
  );
}

function getZoomAdjustedPointer(
  start: { pointerX: number; pointerY: number },
  event: { clientX: number; clientY: number },
  boardZoom: number
): { pointerX: number; pointerY: number } {
  const scale = getBoardZoomScale(boardZoom);
  return {
    pointerX: start.pointerX + (event.clientX - start.pointerX) / scale,
    pointerY: start.pointerY + (event.clientY - start.pointerY) / scale
  };
}

function cellKey(rowItemId: string, columnItemId: string): string {
  return JSON.stringify([rowItemId, columnItemId]);
}

function cellPeriodKey(rowItemId: string, columnItemId: string, periodKey: string): string {
  return JSON.stringify([rowItemId, columnItemId, periodKey]);
}

function sortBoardAxisItems(left: BoardAxisItem, right: BoardAxisItem): number {
  return left.sort_order - right.sort_order || left.label.localeCompare(right.label);
}

function getMissingBoardAxisPrompt(table: BoardTable, axis: BoardAxis): string {
  const role = axis === "row" ? table.row_role : table.column_role;
  if (role === "character") return "캐릭터를 추가해주세요";
  if (role === "task") return "숙제를 추가해주세요";
  return axis === "row" ? "행을 추가해주세요" : "열을 추가해주세요";
}

function getTaskColor(row: BoardAxisItem, column: BoardAxisItem): string | null {
  if (row.kind === "task") return row.task_color;
  if (column.kind === "task") return column.task_color;
  return null;
}

function getBoardTaskResetRuleJson(resetType: BoardTaskResetType): string {
  if (resetType === "daily") return '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}';
  if (resetType === "weekly") return '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}';
  if (resetType === "biweekly") {
    return '{"type":"biweekly","weekday":3,"hour":6,"timezone":"Asia/Seoul","anchorDate":"2026-05-27"}';
  }
  return '{"type":"none"}';
}

export function getCharacterRefreshCooldownState(blockedUntilMs: number, nowMs = Date.now()) {
  const remainingMs = Math.max(0, blockedUntilMs - nowMs);
  if (remainingMs <= 0) {
    return {
      isBlocked: false,
      label: "최신 정보 갱신",
      remainingMs: 0,
      title: "로스트아크 API에서 최신 정보 갱신"
    };
  }
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return {
    isBlocked: true,
    label: "1분 후 갱신 가능",
    remainingMs,
    title: `캐릭터 갱신은 1분에 한 번만 시도할 수 있습니다. ${remainingSeconds}초 후 다시 시도해주세요.`
  };
}

export function getRefreshableBoardCharacterIds(tableId: string, items: BoardAxisItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.table_id !== tableId || item.kind !== "character" || item.visible !== 1 || !item.character_id) continue;
    if (item.character_source === "manual") continue;
    ids.add(item.character_id);
  }
  return [...ids];
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

export function getMixedBoardDisplaySettingKeys(
  axisItems: BoardAxisItem[],
  table: BoardTable,
  boardSettings: BoardDisplaySettings
): Set<BoardDisplaySettingKey> {
  const characterItems = axisItems.filter((item) => item.kind === "character" && item.visible === 1);
  const mixedKeys = new Set<BoardDisplaySettingKey>();

  for (const key of BOARD_DISPLAY_OPTION_KEYS) {
    const values = new Set(characterItems.map((item) => getEffectiveBoardDisplaySettings(item, table, boardSettings)[key]));
    if (values.size > 1) mixedKeys.add(key);
  }

  return mixedKeys;
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

function getBoardCharacterIdentityMeta(item: BoardAxisItem, settings: BoardDisplaySettings): string[] {
  const display = getCharacterDisplaySettings(settings);
  return [
    display.serverName ? item.character_server_name : null,
    display.className ? item.character_class_name : null
  ].filter((value): value is string => Boolean(value));
}

function getBoardCharacterProgressMeta(item: BoardAxisItem, settings: BoardDisplaySettings): string[] {
  const display = getCharacterDisplaySettings(settings);
  return [
    display.itemLevel && item.character_item_level ? `Lv.${item.character_item_level}` : null,
    display.combatPower && item.character_combat_power ? `⚔️${item.character_combat_power}` : null
  ].filter((value): value is string => Boolean(value));
}

export function shouldSaveBoardCharacterDetails(
  item: BoardAxisItem,
  displayName: string,
  itemLevel: string,
  combatPower: string,
  name?: string,
  serverName?: string,
  className?: string
): boolean {
  if (item.kind !== "character" || !item.character_id) return false;

  return (
    (item.character_source === "manual" && name !== undefined && name.trim() !== getBoardCharacterName(item)) ||
    (item.character_source === "manual" && serverName !== undefined && serverName.trim() !== (item.character_server_name ?? "")) ||
    (item.character_source === "manual" && className !== undefined && className.trim() !== (item.character_class_name ?? "")) ||
    displayName.trim() !== (item.character_display_name ?? "") ||
    itemLevel.trim() !== (item.character_item_level ?? "") ||
    combatPower.trim() !== (item.character_combat_power ?? "")
  );
}

function getBoardRowHeaderWidth(rows: BoardAxisItem[]): number {
  if (rows.length === 0) return BOARD_ROW_HEADER_FALLBACK_WIDTH;
  return Math.max(...rows.map((row) => row.cross_size_px ?? BOARD_ROW_HEADER_FALLBACK_WIDTH));
}

function getBoardColumnHeaderHeight(columns: BoardAxisItem[]): number {
  if (columns.length === 0) return BOARD_COLUMN_HEADER_FALLBACK_HEIGHT;
  return Math.max(...columns.map((column) => column.cross_size_px ?? BOARD_COLUMN_HEADER_FALLBACK_HEIGHT));
}

function buildGridColumns(table: BoardTable, rows: BoardAxisItem[], columns: BoardAxisItem[]): string {
  return [`${getBoardRowHeaderWidth(rows)}px`, ...columns.map((column) => `${column.size_px ?? table.default_column_width}px`)].join(" ");
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
    width: Math.max(BOARD_TABLE_FALLBACK_WIDTH, getBoardRowHeaderWidth(rows) + columnWidth + BOARD_TABLE_HORIZONTAL_CHROME),
    height: Math.max(
      BOARD_TABLE_FALLBACK_HEIGHT,
      rowHeight + BOARD_TABLE_VERTICAL_CHROME + Math.max(0, getBoardColumnHeaderHeight(columns) - BOARD_COLUMN_HEADER_FALLBACK_HEIGHT)
    )
  };
}

function getBoardCanvasStyle(tables: BoardTable[], axisItems: BoardAxisItem[], notes: BoardNote[] = [], boardZoom = BOARD_ZOOM_DEFAULT): CSSProperties {
  const width = Math.max(
    BOARD_CANVAS_MIN_WIDTH + BOARD_CANVAS_EDGE_PADDING,
    ...tables.map((table) => table.x + getEstimatedBoardTableSize(table, axisItems).width + BOARD_CANVAS_EDGE_PADDING),
    ...notes.map((note) => note.x + note.width + BOARD_CANVAS_EDGE_PADDING)
  );
  const height = Math.max(
    BOARD_CANVAS_MIN_HEIGHT + BOARD_CANVAS_EDGE_PADDING,
    ...tables.map((table) => table.y + getEstimatedBoardTableSize(table, axisItems).height + BOARD_CANVAS_EDGE_PADDING),
    ...notes.map((note) => note.y + note.height + BOARD_CANVAS_EDGE_PADDING)
  );

  return {
    "--board-canvas-width": `${width}px`,
    "--board-canvas-height": `${height}px`,
    "--board-zoom": `${getBoardZoomScale(boardZoom)}`
  } as CSSProperties;
}

export function applyBoardTableSettingsToAxisItems(
  axisItems: BoardAxisItem[],
  tableId: string,
  input: {
    defaultRowHeight: number;
    defaultColumnWidth: number;
    displaySettings?: BoardDisplaySettings | null | undefined;
    applyRowSize: boolean;
    applyColumnSize: boolean;
    characterSeparator?: BoardAxisSeparator | null | undefined;
  }
): BoardAxisItem[] {
  return axisItems.map((item) => {
    if (item.table_id !== tableId || item.visible !== 1) return item;

    let next = item;
    if (input.applyRowSize && item.axis === "row") {
      next = { ...next, size_px: input.defaultRowHeight };
    }
    if (input.applyColumnSize && item.axis === "column") {
      next = { ...next, size_px: input.defaultColumnWidth };
    }
    if (item.kind === "character" && input.characterSeparator !== undefined) {
      next = {
        ...next,
        separator_json: input.characterSeparator === null ? null : JSON.stringify(input.characterSeparator)
      };
    }
    if (item.kind === "character" && input.displaySettings !== undefined) {
      next = {
        ...next,
        display_options_json: input.displaySettings === null ? null : JSON.stringify(input.displaySettings)
      };
    }

    return next;
  });
}

export function applyBoardAxisItemSaveToAxisItems(
  axisItems: BoardAxisItem[],
  input: {
    axisItemId: string;
    label: string;
    taskColor?: string | null | undefined;
    taskResetType?: BoardTaskResetType | undefined;
    taskResetRuleJson?: string | undefined;
    separator?: BoardAxisSeparator | null | undefined;
    sizePx?: number | null | undefined;
    crossSizePx?: number | null | undefined;
    displaySettings?: BoardDisplaySettings | null | undefined;
    shouldUpdateDetails: boolean;
  }
): BoardAxisItem[] {
  const editedItem = axisItems.find((item) => item.id === input.axisItemId);

  return axisItems.map((item) => {
    let next = item;
    if (
      input.crossSizePx !== undefined &&
      input.crossSizePx !== null &&
      editedItem &&
      item.table_id === editedItem.table_id &&
      item.axis === editedItem.axis &&
      item.visible === 1
    ) {
      next = { ...next, cross_size_px: input.crossSizePx };
    }
    if (item.id !== input.axisItemId) return next;

    return {
      ...next,
      label: input.shouldUpdateDetails ? input.label : next.label,
      task_color: input.shouldUpdateDetails && input.taskColor !== undefined ? input.taskColor : next.task_color,
      ...(input.shouldUpdateDetails && input.taskResetType !== undefined ? { task_reset_type: input.taskResetType } : {}),
      ...(input.shouldUpdateDetails && input.taskResetRuleJson !== undefined ? { task_reset_rule_json: input.taskResetRuleJson } : {}),
      separator_json: input.shouldUpdateDetails
        ? input.separator === undefined
          ? next.separator_json
          : input.separator === null
            ? null
            : JSON.stringify(input.separator)
        : next.separator_json,
      size_px: input.sizePx === undefined || input.sizePx === null ? next.size_px : input.sizePx,
      display_options_json:
        !input.shouldUpdateDetails || input.displaySettings === undefined
          ? next.display_options_json
          : input.displaySettings === null
            ? null
            : JSON.stringify(input.displaySettings)
    };
  });
}

function getBoardTableStyle(table: BoardTable): CSSProperties {
  return {
    left: `${table.x}px`,
    top: `${table.y}px`
  };
}

function getBoardNoteStyle(note: BoardNote, zDepth: number | undefined): CSSProperties {
  return {
    left: `${note.x}px`,
    top: `${note.y}px`,
    width: `${note.width}px`,
    height: `${note.height}px`,
    background: note.color,
    ...(zDepth ? { zIndex: zDepth } : {})
  };
}

function clampBoardNoteLayoutValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function getBoardNoteMovePatch(
  start: NoteMoveSession["start"],
  current: {
    pointerX: number;
    pointerY: number;
  }
): BoardNoteLayoutPatch {
  const deltaX = current.pointerX - start.pointerX;
  const deltaY = current.pointerY - start.pointerY;

  return {
    x: clampBoardNoteLayoutValue(start.x + deltaX, 0, 10000),
    y: clampBoardNoteLayoutValue(start.y + deltaY, 0, 10000),
    width: start.width,
    height: start.height
  };
}

function getBoardNoteResizePatch(
  start: NoteResizeSession["start"],
  current: {
    pointerX: number;
    pointerY: number;
  }
): BoardNoteLayoutPatch {
  const deltaX = current.pointerX - start.pointerX;
  const deltaY = current.pointerY - start.pointerY;

  return {
    x: start.x,
    y: start.y,
    width: clampBoardNoteLayoutValue(start.width + deltaX, BOARD_NOTE_MIN_WIDTH, BOARD_NOTE_MAX_WIDTH),
    height: clampBoardNoteLayoutValue(start.height + deltaY, BOARD_NOTE_MIN_HEIGHT, BOARD_NOTE_MAX_HEIGHT)
  };
}

export function bringBoardTableToFront(depths: Record<string, number>, tableId: string): Record<string, number> {
  const nextDepth = Math.max(0, ...Object.values(depths)) + 1;
  return {
    ...depths,
    [tableId]: nextDepth
  };
}

function getBoardTableZStyle(table: BoardTable, zDepth: number | undefined): CSSProperties {
  return {
    ...getBoardTableStyle(table),
    ...(zDepth ? { zIndex: zDepth } : {})
  };
}

function isBoardTableLocked(table: BoardTable): boolean {
  return table.locked === 1;
}

export function BoardOverview({ board, onBoardChanged, readOnly = false }: Props) {
  const isReadOnly = readOnly || board.readOnly === true;
  const [completions, setCompletions] = useState(board.completions);
  const pendingCompletionPatchesRef = useRef<BoardCompletionPatch[]>([]);
  const handlePendingCompletionPatchesChange = useCallback((patches: BoardCompletionPatch[]) => {
    pendingCompletionPatchesRef.current = patches;
    setCompletions((current) => applyPendingBoardCompletionPatches(current, patches));
  }, []);
  const { enqueue } = useBoardCompletionQueue({ onPendingPatchesChange: handlePendingCompletionPatchesChange });
  const [cellStates, setCellStates] = useState(board.cellStates);
  const [axisItems, setAxisItems] = useState(board.axisItems);
  const [tables, setTables] = useState(board.tables);
  const [notes, setNotes] = useState(board.notes ?? []);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [tableName, setTableName] = useState("");
  const [tableOrientation, setTableOrientation] = useState<BoardOrientation>("custom");
  const [tableDefaultRowHeight, setTableDefaultRowHeight] = useState("40");
  const [tableDefaultColumnWidth, setTableDefaultColumnWidth] = useState("132");
  const [tableDisplaySettings, setTableDisplaySettings] = useState<BoardDisplaySettings>(board.settings);
  const [tableTemplate, setTableTemplate] = useState<BoardTableTemplate>("custom");
  const [tableEventRewardFilters, setTableEventRewardFilters] = useState<LostArkEventRewardFilter[]>(LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS);
  const [tableEventCompletionColumnName, setTableEventCompletionColumnName] = useState(LOST_ARK_EVENT_TABLE_DEFAULT_COMPLETION_COLUMN);
  const [isSheetSettingsOpen, setIsSheetSettingsOpen] = useState(false);
  const [isCreateTableOpen, setIsCreateTableOpen] = useState(false);
  const [isCreateNoteOpen, setIsCreateNoteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<"sheet" | "sheet-update" | "sheet-delete" | "table" | "note" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [refreshingCharacterTableId, setRefreshingCharacterTableId] = useState<string | null>(null);
  const [editingAxisItem, setEditingAxisItem] = useState<BoardAxisItem | null>(null);
  const [editingNote, setEditingNote] = useState<BoardNote | null>(null);
  const [activeTableTool, setActiveTableTool] = useState<ActiveTableTool | null>(null);
  const [editingTable, setEditingTable] = useState<BoardTable | null>(null);
  const [movingTableId, setMovingTableId] = useState<string | null>(null);
  const [movingNoteId, setMovingNoteId] = useState<string | null>(null);
  const [resizingNoteId, setResizingNoteId] = useState<string | null>(null);
  const [openNoteMenuId, setOpenNoteMenuId] = useState<string | null>(null);
  const [openTableMenuId, setOpenTableMenuId] = useState<string | null>(null);
  const [openEventNotificationTableId, setOpenEventNotificationTableId] = useState<string | null>(null);
  const [eventNotificationSettingsByTable, setEventNotificationSettingsByTable] = useState<Record<string, BoardEventNotificationSettings>>({});
  const [eventNotificationDraftsByTable, setEventNotificationDraftsByTable] = useState<Record<string, string>>({});
  const [eventNotificationPermission, setEventNotificationPermission] = useState<BoardEventNotificationPermission>(() => getBoardEventNotificationPermission());
  const [editingNoteTitleId, setEditingNoteTitleId] = useState<string | null>(null);
  const [editingNoteBodyId, setEditingNoteBodyId] = useState<string | null>(null);
  const [boardItemZDepths, setBoardItemZDepths] = useState<Record<string, number>>({});
  const [reorderTableId, setReorderTableId] = useState<string | null>(null);
  const [activeSortableId, setActiveSortableId] = useState<string | null>(null);
  const [markEditTableId, setMarkEditTableId] = useState<string | null>(null);
  const [markBrush, setMarkBrush] = useState<BoardCellMarkBrush>({ disabled: false, icon: "pin", retention: "permanent", memo: "" });
  const [markBrushNotice, setMarkBrushNotice] = useState<string | null>(null);
  const [boardZoom, setBoardZoom] = useState(() =>
    typeof window === "undefined" ? BOARD_ZOOM_DEFAULT : getStoredBoardZoom(window.localStorage)
  );
  const tableMoveSessionRef = useRef<TableMoveSession | null>(null);
  const noteMoveSessionRef = useRef<NoteMoveSession | null>(null);
  const noteResizeSessionRef = useRef<NoteResizeSession | null>(null);
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
  const sortedSheets = useMemo(
    () => board.sheets.slice().sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name)),
    [board.sheets]
  );
  const activeSheet =
    sortedSheets.find((sheet) => sheet.id === activeSheetId) ??
    sortedSheets.find((sheet) => sheet.is_default === 1) ??
    sortedSheets[0];
  useEffect(() => {
    setCompletions(applyPendingBoardCompletionPatches(board.completions, pendingCompletionPatchesRef.current));
  }, [board.completions]);

  useEffect(() => {
    setCellStates(board.cellStates);
  }, [board.cellStates]);

  useEffect(() => {
    setAxisItems(board.axisItems);
  }, [board.axisItems]);

  useEffect(() => {
    setTables(board.tables);
    setNotes(board.notes ?? []);
    setBoardItemZDepths((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([itemId]) => board.tables.some((table) => table.id === itemId) || (board.notes ?? []).some((note) => note.id === itemId)
        )
      )
    );
  }, [board.notes, board.tables]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(BOARD_ZOOM_STORAGE_KEY, String(boardZoom));
    } catch {
      // The board still works if browser storage is blocked.
    }
  }, [boardZoom]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setEventNotificationPermission(getBoardEventNotificationPermission());
    setEventNotificationSettingsByTable((current) => {
      const next = { ...current };
      for (const table of board.tables) {
        if (table.template_type !== "lostark_event" || next[table.id]) continue;
        next[table.id] = getStoredBoardEventNotificationSettings(window.localStorage, table.id);
      }
      return next;
    });
  }, [board.tables]);

  useEffect(() => {
    if (!openNoteMenuId && !openTableMenuId && !openEventNotificationTableId) return;

    function handleBoardMenuDocumentPointerDown(event: Event) {
      const target = event.target;
      if (target instanceof Element && target.closest(".board-note-menu-wrap")) return;
      if (target instanceof Element && target.closest(".board-table-menu-wrap")) return;
      if (target instanceof Element && target.closest(".board-event-notification-wrap")) return;
      setOpenNoteMenuId(null);
      setOpenTableMenuId(null);
      setOpenEventNotificationTableId(null);
    }

    function handleBoardMenuDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenNoteMenuId(null);
        setOpenTableMenuId(null);
        setOpenEventNotificationTableId(null);
      }
    }

    document.addEventListener("pointerdown", handleBoardMenuDocumentPointerDown);
    document.addEventListener("keydown", handleBoardMenuDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleBoardMenuDocumentPointerDown);
      document.removeEventListener("keydown", handleBoardMenuDocumentKeyDown);
    };
  }, [openEventNotificationTableId, openNoteMenuId, openTableMenuId]);

  function getEventNotificationSettings(tableId: string): BoardEventNotificationSettings {
    return (
      eventNotificationSettingsByTable[tableId] ??
      (typeof window === "undefined"
        ? { enabled: false, leadMinutes: BOARD_EVENT_NOTIFICATION_DEFAULT_LEAD_MINUTES }
        : getStoredBoardEventNotificationSettings(window.localStorage, tableId))
    );
  }

  function saveEventNotificationSettings(tableId: string, settings: BoardEventNotificationSettings) {
    const nextSettings = normalizeBoardEventNotificationSettings(settings);
    setEventNotificationSettingsByTable((current) => ({ ...current, [tableId]: nextSettings }));
    try {
      storeBoardEventNotificationSettings(typeof window === "undefined" ? null : window.localStorage, tableId, nextSettings);
    } catch {
      // The current screen state still works if browser storage is blocked.
    }
  }

  async function handleEventNotificationEnabledChange(tableId: string, enabled: boolean) {
    const currentSettings = getEventNotificationSettings(tableId);
    if (!enabled) {
      saveEventNotificationSettings(tableId, { ...currentSettings, enabled: false });
      return;
    }

    const permission = await requestBoardEventNotificationPermission();
    setEventNotificationPermission(permission);
    if (permission === "unsupported") {
      saveEventNotificationSettings(tableId, { ...currentSettings, enabled: false });
      return;
    }
    if (permission !== "granted") {
      saveEventNotificationSettings(tableId, { ...currentSettings, enabled: false });
      return;
    }

    saveEventNotificationSettings(tableId, { ...currentSettings, enabled: true });
  }

  async function handleEventNotificationMinuteSelect(tableId: string, minute: number) {
    const currentSettings = getEventNotificationSettings(tableId);
    const permission = await requestBoardEventNotificationPermission();
    setEventNotificationPermission(permission);
    saveEventNotificationSettings(tableId, getBoardEventNotificationSettingsForMinuteSelection(currentSettings, minute, permission));
  }

  async function handleEventNotificationCustomMinuteSubmit(tableId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rawValue = eventNotificationDraftsByTable[tableId] ?? "";
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) {
      return;
    }
    const minute = Math.round(numeric);
    if (minute < BOARD_EVENT_NOTIFICATION_MIN_MINUTES || minute > BOARD_EVENT_NOTIFICATION_MAX_MINUTES) {
      return;
    }
    const currentSettings = getEventNotificationSettings(tableId);
    const permission = await requestBoardEventNotificationPermission();
    setEventNotificationPermission(permission);
    saveEventNotificationSettings(tableId, getBoardEventNotificationSettingsForMinuteSelection(currentSettings, minute, permission));
    setEventNotificationDraftsByTable((current) => ({ ...current, [tableId]: "" }));
  }

  function handleEventNotificationDelivered(tableId: string) {
    const currentSettings = getEventNotificationSettings(tableId);
    saveEventNotificationSettings(tableId, { ...currentSettings, enabled: false });
  }

  async function handleEventNotificationTest(tableId: string) {
    const permission = await requestBoardEventNotificationPermission();
    setEventNotificationPermission(permission);
    if (permission !== "granted" || typeof window === "undefined" || !("Notification" in window)) return;
    const notification = new window.Notification("RiceArk 테스트 알림", {
      body: "브라우저와 운영체제 알림 설정을 확인합니다.",
      icon: "/icons/icon-192.png",
      tag: `riceark-test:${tableId}`
    });
    notification.onclick = () => {
      window.focus();
    };
  }

  function handleCompletionToggle(patch: BoardCompletionPatch) {
    if (isReadOnly) return;
    setCompletions((current) => applyBoardCompletionPatch(current, patch));
    enqueue(patch);
  }

  async function handleCellStatesSave(patches: BoardCellStatePatch[]) {
    if (patches.length === 0) return;

    await apiPatch("/api/board/cell-states", { patches });
    setCellStates((current) => patches.reduce((next, patch) => applyBoardCellStatePatch(next, patch), current));
  }

  function handleCellMarkPaint(
    table: BoardTable,
    row: BoardAxisItem,
    column: BoardAxisItem,
    currentMark: BoardCellMark | null,
    periodKey: string | null
  ) {
    if (isReadOnly) return;
    setMarkBrushNotice(null);
    if (!markBrush.disabled && markBrush.retention === "period" && (!periodKey || periodKey === "none:permanent")) {
      setMarkBrushNotice("초기화되지 않는 숙제에는 이번주만 옵션을 사용할 수 없습니다.");
      return;
    }

    const memoEnabled = !markBrush.disabled;
    const brushMemo = memoEnabled && markBrush.memo.trim() ? markBrush.memo.trim() : null;
    const brushIcon = memoEnabled ? markBrush.icon : null;
    const markType: BoardCellMarkType = markBrush.disabled ? "disabled" : markBrush.retention === "period" ? "reserved" : "default";
    const isSameAsBrush =
      currentMark !== null &&
      (markBrush.disabled
        ? currentMark.type === "disabled"
        : currentMark.type !== "disabled" &&
          currentMark.retention === markBrush.retention &&
          currentMark.icon === brushIcon &&
          (currentMark.memo ?? null) === brushMemo);
    const nextMarkType: BoardCellMarkType = isSameAsBrush ? "default" : markType;
    const memo = isSameAsBrush || nextMarkType === "disabled" ? null : brushMemo;
    const markIcon = isSameAsBrush || nextMarkType === "disabled" ? null : brushIcon;
    const patch: BoardCellStatePatch = {
      tableId: table.id,
      rowItemId: row.id,
      columnItemId: column.id,
      markType: nextMarkType,
      markIcon,
      memo,
      ...(nextMarkType === "reserved" && periodKey ? { periodKey } : {})
    };

    setCellStates((current) => applyBoardCellStatePatch(current, patch));
    void apiPatch("/api/board/cell-states", { patches: [patch] }).catch(async (err) => {
      setFormError(err instanceof Error ? err.message : "체크마크 설정을 저장하지 못했습니다.");
      await refreshBoard();
    });
  }

  async function handleAxisItemSave(
    axisItemId: string,
    label: string,
    taskColor?: string | null,
    taskResetType?: BoardTaskResetType,
    taskResetRuleJson?: string,
    separator?: BoardAxisSeparator | null,
    sizePx?: number | null,
    crossSizePx?: number | null,
    displaySettings?: BoardDisplaySettings | null,
    shouldUpdateDetails = true
  ) {
    if (shouldUpdateDetails) {
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(axisItemId), {
        label,
        taskColor,
        taskResetType,
        separator,
        displaySettings
      });
    }
    const sizePatch = {
      ...(sizePx !== undefined && sizePx !== null ? { sizePx } : {}),
      ...(crossSizePx !== undefined && crossSizePx !== null ? { crossSizePx } : {})
    };
    const editedItem = axisItems.find((item) => item.id === axisItemId);
    const sizePatches = new Map<string, typeof sizePatch>();
    if (Object.keys(sizePatch).length > 0) {
      sizePatches.set(axisItemId, sizePatch);
    }
    if (crossSizePx !== undefined && crossSizePx !== null && editedItem) {
      for (const item of axisItems) {
        if (item.table_id !== editedItem.table_id || item.axis !== editedItem.axis || item.visible !== 1) continue;
        sizePatches.set(item.id, { ...(sizePatches.get(item.id) ?? {}), crossSizePx });
      }
    }
    if (sizePatches.size > 0) {
      await Promise.all(
        [...sizePatches.entries()].map(([targetAxisItemId, patch]) =>
          apiPatch("/api/board/axis-items/" + encodeURIComponent(targetAxisItemId) + "/size", patch)
        )
      );
    }
    setAxisItems((current) =>
      applyBoardAxisItemSaveToAxisItems(current, {
        axisItemId,
        label,
        taskColor,
        taskResetType,
        taskResetRuleJson,
        separator,
        sizePx,
        crossSizePx,
        displaySettings,
        shouldUpdateDetails
      })
    );
    setEditingAxisItem(null);
  }

  async function handleBoardCharacterSave(
    characterId: string,
    input: BoardCharacterSaveInput
  ) {
    await apiPatch("/api/characters/" + encodeURIComponent(characterId), input);
    setAxisItems((current) =>
      current.map((item) =>
        item.character_id === characterId
          ? {
              ...item,
              label: input.name ?? item.label,
              character_name: input.name ?? item.character_name,
              character_server_name: input.serverName === undefined ? item.character_server_name : input.serverName,
              character_class_name: input.className === undefined ? item.character_class_name : input.className,
              character_display_name: input.displayName,
              character_item_level: input.itemLevel,
              character_combat_power: input.combatPower
            }
          : item
      )
    );
  }

  async function handleBoardCharacterRefresh(characterId: string): Promise<BoardCharacterRefreshResult> {
    const updated = await apiPost<BoardCharacterRefreshResult>("/api/characters/" + encodeURIComponent(characterId) + "/refresh", {});
    setAxisItems((current) =>
      current.map((item) =>
        item.character_id === characterId
          ? {
              ...item,
              label: updated.name,
              character_name: updated.name,
              character_server_name: updated.serverName,
              character_class_name: updated.className,
              character_item_level: updated.itemLevel,
              character_combat_power: updated.combatPower,
              character_source: "lostark"
            }
          : item
      )
    );
    return updated;
  }

  async function handleRefreshTableCharacters(table: BoardTable): Promise<TableCharacterRefreshSummary> {
    if (isReadOnly || isBoardTableLocked(table) || refreshingCharacterTableId !== null) {
      return { failedCount: 0, refreshedCount: 0, totalCount: 0 };
    }

    const characterIds = getRefreshableBoardCharacterIds(table.id, axisItems);
    if (characterIds.length === 0) {
      return { failedCount: 0, refreshedCount: 0, totalCount: 0 };
    }

    setRefreshingCharacterTableId(table.id);
    setFormError(null);
    let failedCount = 0;

    try {
      for (const characterId of characterIds) {
        try {
          await handleBoardCharacterRefresh(characterId);
        } catch {
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        setFormError(
          `캐릭터 ${characterIds.length - failedCount}명 갱신, ${failedCount}명 실패했습니다. 1분 제한 또는 로스트아크 API 상태를 확인해주세요.`
        );
      }
      return {
        failedCount,
        refreshedCount: characterIds.length - failedCount,
        totalCount: characterIds.length
      };
    } finally {
      setRefreshingCharacterTableId(null);
    }
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

  async function handleCreateSheet(nameInput: string) {
    const name = nameInput.trim();
    if (!name) return;

    setPendingAction("sheet");
    setFormError(null);
    try {
      const sheet = await apiPost<{ id: string }>("/api/board/sheets", { name });
      setActiveSheetId(sheet.id);
      await refreshBoard();
    } catch (err) {
      const message = err instanceof Error ? err.message : "탭을 추가하지 못했습니다.";
      setFormError(message);
      throw new Error(message);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleUpdateSheet(sheetId: string, nameInput: string) {
    const name = nameInput.trim();
    if (!name) return;

    setPendingAction("sheet-update");
    setFormError(null);
    try {
      await apiPatch("/api/board/sheets/" + encodeURIComponent(sheetId), { name });
      await refreshBoard();
    } catch (err) {
      const message = err instanceof Error ? err.message : "탭을 저장하지 못했습니다.";
      setFormError(message);
      throw new Error(message);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDeleteSheet(sheetId: string) {
    setPendingAction("sheet-delete");
    setFormError(null);
    try {
      await apiDelete("/api/board/sheets/" + encodeURIComponent(sheetId));
      if (activeSheet?.id === sheetId) setActiveSheetId(null);
      await refreshBoard();
    } catch (err) {
      const message = err instanceof Error ? err.message : "탭을 삭제하지 못했습니다.";
      setFormError(message);
      throw new Error(message);
    } finally {
      setPendingAction(null);
    }
  }

  async function createLostArkEventTableAxisItems(tableId: string, completionColumnName: string) {
    for (const row of LOST_ARK_EVENT_TABLE_ROWS) {
      const created = await apiPost<{ id: string }>("/api/board/axis-items", {
        tableId,
        axis: "row",
        label: row.label
      });
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(created.id), {
        label: row.label,
        taskColor: row.color,
        taskResetType: "daily"
      });
      await apiPatch("/api/board/axis-items/" + encodeURIComponent(created.id) + "/size", {
        sizePx: row.height,
        crossSizePx: LOST_ARK_EVENT_TABLE_ROW_HEADER_WIDTH
      });
    }

    const completionColumn = await apiPost<{ id: string }>("/api/board/axis-items", {
      tableId,
      axis: "column",
      label: completionColumnName.trim() || LOST_ARK_EVENT_TABLE_DEFAULT_COMPLETION_COLUMN
    });
    await apiPatch("/api/board/axis-items/" + encodeURIComponent(completionColumn.id) + "/size", {
      sizePx: LOST_ARK_EVENT_TABLE_COMPLETION_COLUMN_WIDTH
    });
  }

  async function handleCreateTable() {
    if (!activeSheet) return;
    const name = tableName.trim();
    if (!name) return;
    const isLostArkEventTable = tableTemplate === "lostark_event";

    setPendingAction("table");
    setFormError(null);
    try {
      const tablePayload = {
        sheetId: activeSheet.id,
        name,
        orientation: isLostArkEventTable ? "custom" : tableOrientation,
        defaultRowHeight: normalizeBoundedIntegerDraft(tableDefaultRowHeight, { min: 16, max: 1024, fallback: 40 }),
        defaultColumnWidth: normalizeBoundedIntegerDraft(tableDefaultColumnWidth, { min: 16, max: 1024, fallback: 132 }),
        displaySettings: tableDisplaySettings,
        ...(isLostArkEventTable
          ? {
              templateType: "lostark_event",
              eventOptions: { rewardFilters: tableEventRewardFilters }
            }
          : {})
      };
      const table = await apiPost<{ id: string }>("/api/board/tables", tablePayload);
      bringCreatedBoardItemToFront(table.id);
      if (isLostArkEventTable) {
        await createLostArkEventTableAxisItems(table.id, tableEventCompletionColumnName);
      }
      setTableName("");
      setTableTemplate("custom");
      setTableOrientation("custom");
      setTableDefaultRowHeight("40");
      setTableDefaultColumnWidth("132");
      setTableDisplaySettings(board.settings);
      setTableEventRewardFilters(LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS);
      setTableEventCompletionColumnName(LOST_ARK_EVENT_TABLE_DEFAULT_COMPLETION_COLUMN);
      setIsCreateTableOpen(false);
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "표를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleCreateNote(input: { title: string; body: string; color: string }) {
    if (!activeSheet) return;
    const title = input.title.trim();
    if (!title) return;

    setPendingAction("note");
    setFormError(null);
    try {
      const note = await apiPost<{ id: string }>("/api/board/notes", {
        sheetId: activeSheet.id,
        title,
        body: input.body,
        color: input.color
      });
      bringCreatedBoardItemToFront(note.id);
      setIsCreateNoteOpen(false);
      await refreshBoard();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "메모를 추가하지 못했습니다.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleNoteSave(noteId: string, input: Partial<BoardNoteSaveInput>) {
    const currentNote = notes.find((note) => note.id === noteId);
    if (!currentNote) return;

    const nextNote: BoardNote = {
      ...currentNote,
      title: input.title === undefined ? currentNote.title : input.title.trim() || "메모",
      body: input.body === undefined ? currentNote.body : input.body,
      color: input.color ?? currentNote.color,
      width: input.width ?? currentNote.width,
      height: input.height ?? currentNote.height,
      locked: input.locked ?? (currentNote.locked === 1 ? 1 : 0)
    };
    setNotes((current) => current.map((note) => (note.id === noteId ? nextNote : note)));
    if (nextNote.locked === 1) {
      setEditingNoteTitleId((current) => (current === noteId ? null : current));
      setEditingNoteBodyId((current) => (current === noteId ? null : current));
    }
    try {
      await apiPatch("/api/board/notes/" + encodeURIComponent(noteId), buildBoardNoteSavePatch(currentNote, input));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "메모를 저장하지 못했습니다.");
      await refreshBoard();
    }
  }

  async function handleNoteDelete(noteId: string) {
    await apiDelete("/api/board/notes/" + encodeURIComponent(noteId));
    setNotes((current) => current.filter((note) => note.id !== noteId));
    setEditingNote(null);
    setOpenNoteMenuId((current) => (current === noteId ? null : current));
  }

  async function handleTableSettingsSave(
    tableId: string,
    input: {
      name: string;
      defaultRowHeight: number;
      defaultColumnWidth: number;
      displaySettings: BoardDisplaySettings | null;
      eventOptions?: BoardEventOptions | null | undefined;
      applyRowSize: boolean;
      applyColumnSize: boolean;
      locked: 0 | 1;
      characterSeparator?: BoardAxisSeparator | null | undefined;
    }
  ) {
    const currentTable = tables.find((table) => table.id === tableId);
    const wasLocked = currentTable ? isBoardTableLocked(currentTable) : false;
    const rows = axisItems.filter((item) => item.table_id === tableId && item.axis === "row" && item.visible === 1);
    const columns = axisItems.filter((item) => item.table_id === tableId && item.axis === "column" && item.visible === 1);
    const characterItems = axisItems.filter((item) => item.table_id === tableId && item.kind === "character" && item.visible === 1);

    if (!wasLocked && input.applyRowSize) {
      await Promise.all(rows.map((item) => apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id) + "/size", { sizePx: input.defaultRowHeight })));
    }
    if (!wasLocked && input.applyColumnSize) {
      await Promise.all(
        columns.map((item) => apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id) + "/size", { sizePx: input.defaultColumnWidth }))
      );
    }
    if (!wasLocked && (input.characterSeparator !== undefined || input.displaySettings !== undefined)) {
      await Promise.all(
        characterItems.map((item) =>
          apiPatch("/api/board/axis-items/" + encodeURIComponent(item.id), {
            label: item.label,
            ...(input.characterSeparator !== undefined ? { separator: input.characterSeparator } : {}),
            ...(input.displaySettings !== undefined ? { displaySettings: input.displaySettings } : {})
          })
        )
      );
    }

    await apiPatch("/api/board/tables/" + encodeURIComponent(tableId), {
      name: input.name,
      defaultRowHeight: input.defaultRowHeight,
      defaultColumnWidth: input.defaultColumnWidth,
      locked: input.locked,
      displaySettings: input.displaySettings,
      eventOptions: input.eventOptions
    });

    setTables((current) =>
      current.map((table) =>
        table.id === tableId
          ? {
              ...table,
              name: input.name,
              default_row_height: input.defaultRowHeight,
              default_column_width: input.defaultColumnWidth,
              locked: input.locked,
              display_options_json: input.displaySettings ? JSON.stringify(input.displaySettings) : null,
              event_options_json:
                input.eventOptions === undefined
                  ? table.event_options_json
                  : input.eventOptions
                    ? JSON.stringify(input.eventOptions)
                    : null
            }
          : table
      )
    );
    if (!wasLocked) {
      setAxisItems((current) => applyBoardTableSettingsToAxisItems(current, tableId, input));
    }
    setEditingTable(null);
  }

  async function handleTableDelete(tableId: string) {
    await apiDelete("/api/board/tables/" + encodeURIComponent(tableId));
    setTables((current) => current.filter((table) => table.id !== tableId));
    setAxisItems((current) => current.filter((item) => item.table_id !== tableId));
    if (reorderTableId === tableId) {
      setReorderTableId(null);
      setActiveSortableId(null);
    }
    if (markEditTableId === tableId) {
      setMarkEditTableId(null);
      setMarkBrushNotice(null);
    }
    setEditingTable(null);
  }

  async function handleTableTranspose(tableId: string) {
    await apiPost<{ ok: true }>("/api/board/tables/" + encodeURIComponent(tableId) + "/transpose", {});
    setEditingTable(null);
    await refreshBoard();
  }

  async function handleTableLockToggle(table: BoardTable) {
    const nextLocked = isBoardTableLocked(table) ? 0 : 1;
    setFormError(null);
    try {
      await apiPatch("/api/board/tables/" + encodeURIComponent(table.id), {
        name: table.name,
        defaultRowHeight: table.default_row_height,
        defaultColumnWidth: table.default_column_width,
        locked: nextLocked
      });
      setTables((current) => current.map((item) => (item.id === table.id ? { ...item, locked: nextLocked } : item)));
      if (nextLocked === 1 && reorderTableId === table.id) {
        setReorderTableId(null);
        setActiveSortableId(null);
      }
      if (nextLocked === 1 && markEditTableId === table.id) {
        setMarkEditTableId(null);
        setMarkBrushNotice(null);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "표 잠금 상태를 저장하지 못했습니다.");
      await refreshBoard();
    }
  }

  function toggleTableReorderMode(table: BoardTable) {
    if (isBoardTableLocked(table)) return;
    setActiveSortableId(null);
    setMarkEditTableId(null);
    setMarkBrushNotice(null);
    setReorderTableId((current) => (current === table.id ? null : table.id));
  }

  function toggleTableMarkEditMode(table: BoardTable) {
    if (isBoardTableLocked(table)) return;
    setReorderTableId(null);
    setActiveSortableId(null);
    setMarkBrushNotice(null);
    setMarkEditTableId((current) => (current === table.id ? null : table.id));
  }

  function bringCreatedBoardItemToFront(itemId: string) {
    setBoardItemZDepths((current) => bringBoardTableToFront(current, itemId));
  }

  function handleBoardAxisDragStart(event: DragStartEvent) {
    setActiveSortableId(String(event.active.id));
  }

  function handleBoardAxisDragCancel() {
    setActiveSortableId(null);
  }

  function handleBoardAxisDragEnd(event: DragEndEvent) {
    setActiveSortableId(null);
    const active = parseBoardAxisSortableId(String(event.active.id));
    const over = event.over ? parseBoardAxisSortableId(String(event.over.id)) : null;
    if (!active || !over || active.tableId !== over.tableId || active.axis !== over.axis || active.axisItemId === over.axisItemId) return;

    const orderedIds = axisItems
      .filter((item) => item.table_id === active.tableId && item.axis === active.axis && item.visible === 1)
      .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label))
      .map((item) => item.id);
    const nextIds = moveBoardAxisItemIds(orderedIds, active.axisItemId, over.axisItemId);
    if (nextIds === orderedIds) return;

    setAxisItems((current) => applyBoardAxisOrder(current, active.tableId, active.axis, nextIds));
    void persistBoardAxisOrder(active.tableId, active.axis, nextIds);
  }

  async function persistBoardAxisOrder(tableId: string, axis: BoardAxis, axisItemIds: string[]) {
    try {
      await apiPatch("/api/board/axis-items/order", { tableId, axis, axisItemIds });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "순서를 저장하지 못했습니다.");
      await refreshBoard();
    }
  }

  function handleTableMoveStart(table: BoardTable, event: PointerEvent<HTMLButtonElement>) {
    if (isBoardTableLocked(table)) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    bringTableToFront(table.id);
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

  function bringTableToFront(tableId: string) {
    setBoardItemZDepths((current) => bringBoardTableToFront(current, tableId));
  }

  function handleBoardTablePointerDown(tableId: string, event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    bringTableToFront(tableId);
  }

  function bringNoteToFront(noteId: string) {
    setBoardItemZDepths((current) => bringBoardTableToFront(current, noteId));
  }

  function handleBoardNotePointerDown(noteId: string, event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    bringNoteToFront(noteId);
  }

  function handleTableMove(tableId: string, event: PointerEvent<HTMLButtonElement>) {
    const session = tableMoveSessionRef.current;
    if (!session || session.tableId !== tableId || session.pointerId !== event.pointerId) return;

    const patch = getBoardTableMovePatch(session.start, getZoomAdjustedPointer(session.start, event, boardZoom));
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

  function handleNoteMoveStart(note: BoardNote, event: PointerEvent<HTMLElement>) {
    if (note.locked === 1) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    bringNoteToFront(note.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setFormError(null);
    setMovingNoteId(note.id);
    noteMoveSessionRef.current = {
      noteId: note.id,
      pointerId: event.pointerId,
      start: {
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height,
        pointerX: event.clientX,
        pointerY: event.clientY
      },
      patch: null
    };
  }

  function handleNoteMove(noteId: string, event: PointerEvent<HTMLElement>) {
    const session = noteMoveSessionRef.current;
    if (!session || session.noteId !== noteId || session.pointerId !== event.pointerId) return;

    const patch = getBoardNoteMovePatch(session.start, getZoomAdjustedPointer(session.start, event, boardZoom));
    session.patch = patch;
    setNotes((current) => current.map((note) => (note.id === noteId ? { ...note, ...patch } : note)));
  }

  function finishNoteMove(noteId: string, event: PointerEvent<HTMLElement>) {
    const session = noteMoveSessionRef.current;
    if (!session || session.noteId !== noteId || session.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    noteMoveSessionRef.current = null;
    setMovingNoteId(null);

    if (session.patch) {
      void persistNoteLayout(noteId, session.patch);
    }
  }

  async function persistNoteLayout(noteId: string, patch: BoardNoteLayoutPatch) {
    try {
      await apiPatch("/api/board/notes/" + encodeURIComponent(noteId) + "/layout", patch);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "메모 위치를 저장하지 못했습니다.");
      await refreshBoard();
    }
  }

  function handleNoteResizeStart(note: BoardNote, event: PointerEvent<HTMLButtonElement>) {
    if (note.locked === 1) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    bringNoteToFront(note.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setFormError(null);
    setResizingNoteId(note.id);
    noteResizeSessionRef.current = {
      noteId: note.id,
      pointerId: event.pointerId,
      start: {
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height,
        pointerX: event.clientX,
        pointerY: event.clientY
      },
      patch: null
    };
  }

  function handleNoteResize(noteId: string, event: PointerEvent<HTMLButtonElement>) {
    const session = noteResizeSessionRef.current;
    if (!session || session.noteId !== noteId || session.pointerId !== event.pointerId) return;

    const patch = getBoardNoteResizePatch(session.start, getZoomAdjustedPointer(session.start, event, boardZoom));
    session.patch = patch;
    setNotes((current) => current.map((note) => (note.id === noteId ? { ...note, ...patch } : note)));
  }

  function finishNoteResize(noteId: string, event: PointerEvent<HTMLButtonElement>) {
    const session = noteResizeSessionRef.current;
    if (!session || session.noteId !== noteId || session.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    noteResizeSessionRef.current = null;
    setResizingNoteId(null);

    if (session.patch) {
      void persistNoteLayout(noteId, session.patch);
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
  const activeNotes = notes
    .filter((note) => note.sheet_id === activeSheet.id)
    .sort((left, right) => left.sort_order - right.sort_order || left.title.localeCompare(right.title));

  const boardCanvas = (
    <div className="board-canvas" style={getBoardCanvasStyle(activeTables, axisItems, activeNotes, boardZoom)}>
      {activeTables.length === 0 && activeNotes.length === 0 ? <p className="board-empty">아직 표가 없습니다.</p> : null}
      {activeTables.length > 0 || activeNotes.length > 0 ? (
        <div className="board-canvas-space">
          <div className="board-canvas-content">
            {activeTables.map((table) => {
              const tableLocked = isBoardTableLocked(table);
              const isLostArkEventTable = table.template_type === "lostark_event";
              const interactionsLocked = isReadOnly || tableLocked;
              const isReorderMode = !isReadOnly && reorderTableId === table.id && !tableLocked;
              const isMarkEditMode = !isReadOnly && markEditTableId === table.id && !tableLocked;
              const tableGrid = (
                <BoardTableGrid
                  axisItems={axisItems}
                  cellStates={cellStates}
                  completions={completions}
                  eventNotificationSettings={getEventNotificationSettings(table.id)}
                  isMarkEditMode={isMarkEditMode}
                  isReorderMode={isReorderMode}
                  readOnly={isReadOnly}
                  table={table}
                  onAxisItemEdit={interactionsLocked || isReorderMode || isMarkEditMode ? undefined : setEditingAxisItem}
                  onCellMarkPaint={
                    isMarkEditMode
                      ? (row, column, currentMark, periodKey) => handleCellMarkPaint(table, row, column, currentMark, periodKey)
                      : undefined
                  }
                  onEventNotificationDelivered={handleEventNotificationDelivered}
                  onToggle={handleCompletionToggle}
                  settings={board.settings}
                />
              );
              return (
                <article
                  key={table.id}
                  className={`board-table-summary${openTableMenuId === table.id ? " menu-open" : ""}${movingTableId === table.id ? " moving" : ""}${tableLocked ? " locked" : ""}${isReadOnly ? " readonly" : ""}${isReorderMode ? " reorder-mode" : ""}${isMarkEditMode ? " mark-edit-mode" : ""}`}
                  style={getBoardTableZStyle(table, boardItemZDepths[table.id])}
                  onPointerDown={(event) => handleBoardTablePointerDown(table.id, event)}
                >
                  <div className="board-table-heading">
                    <div className="board-table-mode-group">
                      {interactionsLocked ? (
                        <div className="board-table-title board-table-static-title">
                          <strong>{table.name}</strong>
                        </div>
                      ) : (
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
                      )}
                      {!isReadOnly ? <div className="board-table-mode-actions">
                        <button
                          className="board-table-lock-button"
                          type="button"
                          aria-label={`${table.name} 표 ${tableLocked ? "잠금 해제" : "잠금"}`}
                          title={tableLocked ? "표 잠금 해제" : "표 잠금"}
                          onClick={() => {
                            setOpenTableMenuId(null);
                            void handleTableLockToggle(table);
                          }}
                        >
                          {tableLocked ? <Lock aria-hidden="true" size={14} /> : <Unlock aria-hidden="true" size={14} />}
                        </button>
                      </div> : null}
                    </div>
                    {!isReadOnly ? <div className="board-table-heading-actions">
                      {isLostArkEventTable ? (
                        <div className="board-event-notification-wrap">
                          <button
                            className={`board-event-notification-button${getEventNotificationSettings(table.id).enabled ? " active" : ""}`}
                            type="button"
                            aria-label={`${table.name} 알림 설정`}
                            aria-expanded={openEventNotificationTableId === table.id}
                            title="스케줄 알림 설정"
                            onClick={() => {
                              setOpenNoteMenuId(null);
                              setOpenTableMenuId(null);
                              setOpenEventNotificationTableId((current) => (current === table.id ? null : table.id));
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              bringTableToFront(table.id);
                            }}
                          >
                            <Bell aria-hidden="true" size={15} />
                          </button>
                          <BoardEventNotificationPanel
                            customDraft={eventNotificationDraftsByTable[table.id] ?? ""}
                            hidden={openEventNotificationTableId !== table.id}
                            permission={eventNotificationPermission}
                            settings={getEventNotificationSettings(table.id)}
                            tableName={table.name}
                            onCustomDraftChange={(value) => setEventNotificationDraftsByTable((current) => ({ ...current, [table.id]: value }))}
                            onCustomMinuteSubmit={(event) => {
                              void handleEventNotificationCustomMinuteSubmit(table.id, event);
                            }}
                            onEnabledChange={(enabled) => {
                              void handleEventNotificationEnabledChange(table.id, enabled);
                            }}
                            onMinuteSelect={(minute) => {
                              void handleEventNotificationMinuteSelect(table.id, minute);
                            }}
                            onTest={() => {
                              void handleEventNotificationTest(table.id);
                            }}
                          />
                        </div>
                      ) : null}
                      {isReorderMode ? (
                        <button
                          className="board-table-reorder-done-button"
                          type="button"
                          aria-label={`${table.name} 순서 변경 완료`}
                          title="순서 변경 완료"
                          onClick={() => toggleTableReorderMode(table)}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            bringTableToFront(table.id);
                          }}
                        >
                          <Check aria-hidden="true" size={14} />
                          완료
                        </button>
                      ) : null}
                      {isMarkEditMode ? (
                        <button
                          className="board-table-reorder-done-button"
                          type="button"
                          aria-label={`${table.name} 체크칸 설정 완료`}
                          title="체크칸 설정 완료"
                          onClick={() => toggleTableMarkEditMode(table)}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            bringTableToFront(table.id);
                          }}
                        >
                          <Check aria-hidden="true" size={14} />
                          완료
                        </button>
                      ) : null}
                      <div className="board-table-menu-wrap">
                      <button
                        className="board-table-menu-button"
                        type="button"
                        aria-label={`${table.name} 표 메뉴`}
                        aria-expanded={openTableMenuId === table.id}
                        title="표 메뉴"
                        onClick={() => {
                          setOpenNoteMenuId(null);
                          setOpenEventNotificationTableId(null);
                          setOpenTableMenuId((current) => (current === table.id ? null : table.id));
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          bringTableToFront(table.id);
                        }}
                      >
                        <span className="board-table-menu-dots" aria-hidden="true" />
                      </button>
                      <div className="board-table-menu" hidden={openTableMenuId !== table.id} onPointerDown={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          aria-label={`${table.name} 표 ${tableLocked ? "잠금 해제" : "잠금"}`}
                          title={tableLocked ? "표 잠금 해제" : "표 잠금"}
                          onClick={() => {
                            setOpenTableMenuId(null);
                            void handleTableLockToggle(table);
                          }}
                        >
                          {tableLocked ? <Unlock aria-hidden="true" size={14} /> : <Lock aria-hidden="true" size={14} />}
                          {tableLocked ? "잠금 해제" : "잠금"}
                        </button>
                        {isLostArkEventTable ? (
                          <button
                            type="button"
                            aria-label={`${table.name} 완료 열 추가`}
                            title={tableLocked ? "잠금을 해제한 뒤 완료 열을 추가할 수 있습니다." : "완료 열 추가"}
                            disabled={tableLocked}
                            onClick={() => {
                              setOpenTableMenuId(null);
                              setActiveTableTool({ table, tool: "event-columns" });
                            }}
                          >
                            <UserPlus aria-hidden="true" size={14} />
                            완료 열
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-label={`${table.name} 캐릭터 추가 또는 가져오기`}
                              title={tableLocked ? "잠금을 해제한 뒤 캐릭터를 추가할 수 있습니다." : "캐릭터 추가/가져오기"}
                              disabled={tableLocked}
                              onClick={() => {
                                setOpenTableMenuId(null);
                                setActiveTableTool({ table, tool: "characters" });
                              }}
                            >
                              <UserPlus aria-hidden="true" size={14} />
                              캐릭터
                            </button>
                            <button
                              type="button"
                              aria-label={`${table.name} 숙제 추가`}
                              title={tableLocked ? "잠금을 해제한 뒤 숙제를 추가할 수 있습니다." : "숙제 추가"}
                              disabled={tableLocked}
                              onClick={() => {
                                setOpenTableMenuId(null);
                                setActiveTableTool({ table, tool: "tasks" });
                              }}
                            >
                              <Plus aria-hidden="true" size={14} />
                              숙제
                            </button>
                          </>
                        )}
                        <button
                          className={isReorderMode ? "active" : undefined}
                          type="button"
                          aria-label={`${table.name} 순서 변경 모드 ${isReorderMode ? "끄기" : "켜기"}`}
                          title={tableLocked ? "잠금을 해제한 뒤 순서를 변경할 수 있습니다." : isReorderMode ? "순서 변경 완료" : "순서 변경"}
                          disabled={tableLocked}
                          onClick={() => {
                            setOpenTableMenuId(null);
                            toggleTableReorderMode(table);
                          }}
                        >
                          <Shuffle aria-hidden="true" size={14} />
                          {isReorderMode ? "완료" : "순서"}
                        </button>
                        <button
                          className={isMarkEditMode ? "active" : undefined}
                          type="button"
                          aria-label={`${table.name} 체크칸 설정 모드 ${isMarkEditMode ? "끄기" : "켜기"}`}
                          title={
                            tableLocked
                              ? "잠금을 해제한 뒤 체크칸을 설정할 수 있습니다."
                              : isMarkEditMode
                                ? "체크칸 설정 완료"
                                : "체크칸 아이콘, 이번주만, 비활성화, 메모 설정"
                          }
                          disabled={tableLocked}
                          onClick={() => {
                            setOpenTableMenuId(null);
                            toggleTableMarkEditMode(table);
                          }}
                        >
                          <Pin aria-hidden="true" size={14} />
                          {isMarkEditMode ? "완료" : "체크칸 설정"}
                        </button>
                        <button
                          type="button"
                          aria-label={`${table.name} 표 설정`}
                          title={tableLocked ? "잠금을 해제한 뒤 표 설정을 수정할 수 있습니다." : "표 설정"}
                          disabled={tableLocked}
                          onClick={() => {
                            setOpenTableMenuId(null);
                            setEditingTable(table);
                          }}
                        >
                          <Settings aria-hidden="true" size={14} />
                          설정
                        </button>
                      </div>
                      </div>
                    </div> : null}
                  </div>
                  {isMarkEditMode ? (
                    <BoardCellMarkToolbar
                      brush={markBrush}
                      notice={markBrushNotice}
                      onBrushChange={(nextBrush) => {
                        setMarkBrush(nextBrush);
                        setMarkBrushNotice(null);
                      }}
                    />
                  ) : null}
                  {isReorderMode && !isReadOnly ? (
                    <DndContext
                      collisionDetection={closestCenter}
                      sensors={sensors}
                      onDragCancel={handleBoardAxisDragCancel}
                      onDragEnd={handleBoardAxisDragEnd}
                      onDragStart={handleBoardAxisDragStart}
                    >
                      {tableGrid}
                      {/* The board canvas is scaled with a CSS transform, which would become the
                          containing block for the overlay's fixed positioning and shift it below
                          the cursor — portal it to <body> so it tracks the pointer correctly. */}
                      {typeof document === "undefined"
                        ? null
                        : createPortal(
                            <DragOverlay>{renderBoardDragOverlay(activeSortableId, axisItems, table, board.settings)}</DragOverlay>,
                            document.body
                          )}
                    </DndContext>
                  ) : (
                    tableGrid
                  )}
                </article>
              );
            })}
            {activeNotes.map((note) => (
            <article
              key={note.id}
              className={`board-note-card${note.locked === 1 ? " locked" : ""}${openNoteMenuId === note.id ? " menu-open" : ""}${movingNoteId === note.id ? " moving" : ""}${resizingNoteId === note.id ? " resizing" : ""}`}
              style={getBoardNoteStyle(note, boardItemZDepths[note.id])}
              onPointerDown={(event) => handleBoardNotePointerDown(note.id, event)}
            >
              <header
                className="board-note-header"
                onPointerCancel={isReadOnly ? undefined : (event) => finishNoteMove(note.id, event)}
                onPointerDown={isReadOnly ? undefined : (event) => handleNoteMoveStart(note, event)}
                onPointerMove={isReadOnly ? undefined : (event) => handleNoteMove(note.id, event)}
                onPointerUp={isReadOnly ? undefined : (event) => finishNoteMove(note.id, event)}
              >
                {editingNoteTitleId === note.id && note.locked !== 1 ? (
                  <input
                    aria-label={`${note.title} 메모 제목`}
                    autoFocus
                    className="board-note-title-input"
                    maxLength={BOARD_NOTE_TITLE_MAX_LENGTH}
                    spellCheck={false}
                    value={note.title}
                    onBlur={(event) => {
                      setEditingNoteTitleId(null);
                      void handleNoteSave(note.id, { title: event.currentTarget.value });
                    }}
                    onChange={(event) => {
                      const nextTitle = event.currentTarget.value;
                      setNotes((current) => current.map((item) => (item.id === note.id ? { ...item, title: nextTitle } : item)));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                ) : (
                  <span
                    className="board-note-title-view"
                    title={note.title}
                  >
                    {note.title}
                  </span>
                )}
                {!isReadOnly ? <div className="board-note-menu-wrap">
                  <button
                    className="board-note-menu-button"
                    type="button"
                    aria-label={`${note.title} 메모 메뉴`}
                    aria-expanded={openNoteMenuId === note.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      bringNoteToFront(note.id);
                      setOpenNoteMenuId((current) => (current === note.id ? null : note.id));
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <span className="board-note-menu-dots" aria-hidden="true" />
                  </button>
                  <div className="board-note-menu" hidden={openNoteMenuId !== note.id} onPointerDown={(event) => event.stopPropagation()}>
                    <button
                      disabled={note.locked === 1}
                      type="button"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        setEditingNoteTitleId(note.id);
                      }}
                    >
                      <Pencil aria-hidden="true" size={14} />
                      제목 변경
                    </button>
                    <button
                      disabled={note.locked === 1}
                      type="button"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        setEditingNoteBodyId(note.id);
                      }}
                    >
                      <Pencil aria-hidden="true" size={14} />
                      내용 편집
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        void handleNoteSave(note.id, { locked: note.locked === 1 ? 0 : 1 });
                      }}
                    >
                      {note.locked === 1 ? <Unlock aria-hidden="true" size={14} /> : <Lock aria-hidden="true" size={14} />}
                      {note.locked === 1 ? "잠금 해제" : "잠금"}
                    </button>
                    <label>
                      색 변경
                      <input
                        aria-label={`${note.title} 메모 색 변경`}
                        type="color"
                        value={note.color}
                        onChange={(event) => void handleNoteSave(note.id, { color: event.currentTarget.value })}
                      />
                    </label>
                    <button
                      className="danger-menu-item"
                      type="button"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        void handleNoteDelete(note.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      메모 삭제
                    </button>
                  </div>
                </div> : null}
              </header>
              {editingNoteBodyId === note.id && !isReadOnly && note.locked !== 1 ? (
                <textarea
                  aria-label={`${note.title} 메모 내용`}
                  autoFocus
                  className="board-note-body board-note-body-input"
                  maxLength={BOARD_NOTE_BODY_MAX_LENGTH}
                  placeholder="메모"
                  spellCheck={false}
                  value={note.body}
                  onBlur={(event) => {
                    setEditingNoteBodyId(null);
                    void handleNoteSave(note.id, { body: event.currentTarget.value });
                  }}
                  onChange={(event) => {
                    const nextBody = event.currentTarget.value;
                    setNotes((current) => current.map((item) => (item.id === note.id ? { ...item, body: nextBody } : item)));
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              ) : (
                <div
                  aria-label={`${note.title} 메모 내용`}
                  className="board-note-body board-note-markdown"
                  onClick={(event) => {
                    if (isReadOnly || note.locked === 1) return;
                    const target = event.target;
                    if (target instanceof Element && target.closest("a")) return;
                    setEditingNoteBodyId(note.id);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <BoardNoteMarkdown value={note.body} />
                </div>
              )}
              {!isReadOnly ? <button
                className="board-note-resize-handle"
                disabled={note.locked === 1}
                type="button"
                aria-label={`${note.title} 메모 크기 조절`}
                onPointerCancel={(event) => finishNoteResize(note.id, event)}
                onPointerDown={(event) => handleNoteResizeStart(note, event)}
                onPointerMove={(event) => handleNoteResize(note.id, event)}
                onPointerUp={(event) => finishNoteResize(note.id, event)}
              >
                {note.locked === 1 ? <Lock aria-hidden="true" className="board-note-resize-lock-icon" size={12} /> : null}
              </button> : null}
            </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <section className="board-overview" aria-label="보드">
      <div className="sheet-tab-bar" aria-label="탭 선택">
        <div className="sheet-tab-list">
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
        </div>
        {!isReadOnly ? <button className="sheet-settings-button" type="button" aria-label="탭 설정" title="탭 설정" onClick={() => setIsSheetSettingsOpen(true)}>
          <Settings aria-hidden="true" size={16} />
          설정
        </button> : null}
        <div className="board-zoom-controls" aria-label="보드 확대 비율">
          <button
            disabled={boardZoom <= BOARD_ZOOM_MIN}
            type="button"
            aria-label="보드 축소"
            title="보드 축소"
            onClick={() => setBoardZoom((current) => normalizeBoardZoom(current - BOARD_ZOOM_STEP))}
          >
            <Minus aria-hidden="true" size={14} />
          </button>
          <span className="board-zoom-value" aria-label="현재 보드 확대 비율">
            {boardZoom}%
          </span>
          <button
            disabled={boardZoom >= BOARD_ZOOM_MAX}
            type="button"
            aria-label="보드 확대"
            title="보드 확대"
            onClick={() => setBoardZoom((current) => normalizeBoardZoom(current + BOARD_ZOOM_STEP))}
          >
            <Plus aria-hidden="true" size={14} />
          </button>
        </div>
      </div>
      {formError ? <p className="board-form-error">{formError}</p> : null}
      {boardCanvas}
      {!isReadOnly ? <div className="floating-board-actions">
        <button className="floating-note-add-button" disabled={!activeSheet} type="button" onClick={() => setIsCreateNoteOpen(true)}>
          <StickyNote aria-hidden="true" size={18} />
          메모 추가
        </button>
        <button className="floating-table-add-button" disabled={!activeSheet} type="button" onClick={() => setIsCreateTableOpen(true)}>
          <Plus aria-hidden="true" size={18} />
          표 추가
        </button>
      </div> : null}
      {!isReadOnly && isSheetSettingsOpen ? (
        <BoardSheetSettingsModal
          activeSheetId={activeSheet?.id ?? null}
          isPending={pendingAction === "sheet" || pendingAction === "sheet-update" || pendingAction === "sheet-delete"}
          sheets={sortedSheets}
          onClose={() => setIsSheetSettingsOpen(false)}
          onCreate={handleCreateSheet}
          onDelete={handleDeleteSheet}
          onUpdate={handleUpdateSheet}
        />
      ) : null}
      {!isReadOnly && isCreateTableOpen ? (
        <BoardTableCreateModal
          defaultColumnWidth={tableDefaultColumnWidth}
          defaultRowHeight={tableDefaultRowHeight}
          displaySettings={tableDisplaySettings}
          eventCompletionColumnName={tableEventCompletionColumnName}
          eventRewardFilters={tableEventRewardFilters}
          isPending={pendingAction === "table"}
          name={tableName}
          orientation={tableOrientation}
          template={tableTemplate}
          onClose={() => setIsCreateTableOpen(false)}
          onDefaultColumnWidthChange={setTableDefaultColumnWidth}
          onDefaultRowHeightChange={setTableDefaultRowHeight}
          onDisplaySettingsChange={setTableDisplaySettings}
          onEventCompletionColumnNameChange={setTableEventCompletionColumnName}
          onEventRewardFiltersChange={setTableEventRewardFilters}
          onNameChange={setTableName}
          onOrientationChange={setTableOrientation}
          onSubmit={() => void handleCreateTable()}
          onTemplateChange={(nextTemplate) => {
            setTableTemplate(nextTemplate);
            if (nextTemplate === "lostark_event") {
              setTableOrientation("custom");
              if (!tableName.trim()) setTableName("스케줄");
              setTableDefaultRowHeight("62");
              setTableDefaultColumnWidth(String(LOST_ARK_EVENT_TABLE_COMPLETION_COLUMN_WIDTH));
            }
          }}
        />
      ) : null}
      {!isReadOnly && isCreateNoteOpen ? (
        <BoardNoteEditModal
          isPending={pendingAction === "note"}
          mode="create"
          onClose={() => setIsCreateNoteOpen(false)}
          onSave={(input) => void handleCreateNote(input)}
        />
      ) : null}
      {!isReadOnly && activeTableTool ? (
        <BoardTableToolModal
          table={activeTableTool.table}
          tool={activeTableTool.tool}
          isRefreshingCharacters={refreshingCharacterTableId === activeTableTool.table.id}
          onClose={() => setActiveTableTool(null)}
          onRefreshCharacters={() => handleRefreshTableCharacters(activeTableTool.table)}
          onSaved={async () => {
            setActiveTableTool(null);
            await refreshBoard();
          }}
          refreshableCharacterCount={getRefreshableBoardCharacterIds(activeTableTool.table.id, axisItems).length}
        />
      ) : null}
      {!isReadOnly && editingAxisItem ? (
        <BoardAxisItemEditModal
          item={editingAxisItem}
          settings={board.settings}
          table={tables.find((table) => table.id === editingAxisItem.table_id) ?? null}
          onClose={() => setEditingAxisItem(null)}
          onCharacterRefresh={handleBoardCharacterRefresh}
          onCharacterSave={handleBoardCharacterSave}
          onDelete={handleAxisItemDelete}
          onSave={handleAxisItemSave}
        />
      ) : null}
      {!isReadOnly && editingTable ? (
        <BoardTableSettingsModal
          axisItems={axisItems.filter((item) => item.table_id === editingTable.id && item.visible === 1)}
          settings={board.settings}
          table={editingTable}
          onClose={() => setEditingTable(null)}
          onDelete={handleTableDelete}
          onSave={handleTableSettingsSave}
          onTranspose={handleTableTranspose}
        />
      ) : null}
      {!isReadOnly && editingNote ? (
        <BoardNoteEditModal
          note={editingNote}
          mode="edit"
          onClose={() => setEditingNote(null)}
          onDelete={handleNoteDelete}
          onSave={(input) => void handleNoteSave(editingNote.id, input)}
        />
      ) : null}
    </section>
  );
}

export function BoardDisplayOptions({
  disabled = false,
  mixedKeys,
  onChange,
  settings
}: {
  disabled?: boolean | undefined;
  mixedKeys?: ReadonlySet<BoardDisplaySettingKey> | undefined;
  onChange: (settings: BoardDisplaySettings, changedKey: BoardDisplaySettingKey) => void;
  settings: BoardDisplaySettings;
}) {
  return (
    <fieldset className="board-display-options">
      <legend>표시 옵션</legend>
      {BOARD_DISPLAY_OPTIONS.map((option) => (
        <label key={option.key}>
          <BoardDisplayOptionCheckbox
            checked={settings[option.key] !== 0}
            disabled={disabled}
            mixed={mixedKeys?.has(option.key) ?? false}
            onChange={(event) => onChange({ ...settings, [option.key]: event.currentTarget.checked ? 1 : 0 }, option.key)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

function BoardDisplayOptionCheckbox({
  checked,
  disabled,
  mixed,
  onChange
}: {
  checked: boolean;
  disabled: boolean;
  mixed: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);

  return <input ref={ref} aria-checked={mixed ? "mixed" : checked} checked={checked} disabled={disabled} type="checkbox" onChange={onChange} />;
}

export function BoardSheetSettingsModal({
  activeSheetId,
  isPending,
  onClose,
  onCreate,
  onDelete,
  onUpdate,
  sheets
}: {
  activeSheetId: string | null;
  isPending: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (sheetId: string) => Promise<void>;
  onUpdate: (sheetId: string, name: string) => Promise<void>;
  sheets: BoardSheet[];
}) {
  const [newSheetName, setNewSheetName] = useState("");
  const [selectedSheetId, setSelectedSheetId] = useState(activeSheetId ?? sheets[0]?.id ?? "");
  const selectedSheet = sheets.find((sheet) => sheet.id === selectedSheetId) ?? sheets[0] ?? null;
  const [selectedSheetName, setSelectedSheetName] = useState(selectedSheet?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const canDelete = sheets.length > 1 && Boolean(selectedSheet);
  const canSave = Boolean(selectedSheet) && Boolean(selectedSheetName.trim()) && selectedSheetName.trim() !== selectedSheet?.name;

  useEffect(() => {
    const nextSelected = sheets.find((sheet) => sheet.id === selectedSheetId) ?? sheets.find((sheet) => sheet.id === activeSheetId) ?? sheets[0] ?? null;
    if (!nextSelected) {
      setSelectedSheetId("");
      setSelectedSheetName("");
      return;
    }
    setSelectedSheetId(nextSelected.id);
    setSelectedSheetName(nextSelected.name);
  }, [activeSheetId, selectedSheetId, sheets]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newSheetName.trim();
    if (!name) return;

    setError(null);
    try {
      await onCreate(name);
      setNewSheetName("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "탭을 추가하지 못했습니다.");
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSheet || !canSave) return;

    setError(null);
    try {
      await onUpdate(selectedSheet.id, selectedSheetName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "탭을 저장하지 못했습니다.");
    }
  }

  async function remove() {
    if (!selectedSheet || !canDelete) return;

    setError(null);
    try {
      await onDelete(selectedSheet.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "탭을 삭제하지 못했습니다.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal sheet-settings-modal" aria-modal="true" role="dialog" aria-label="탭 설정">
        <header className="tool-modal-header">
          <h2>탭 설정</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body edit-form">
          <form className="sheet-settings-section" onSubmit={create}>
            <label>
              새 탭
              <input
                aria-label="새 탭 이름"
                maxLength={30}
                placeholder="새 탭"
                value={newSheetName}
                onChange={(event) => setNewSheetName(event.currentTarget.value)}
              />
            </label>
            <button className="primary-button" disabled={isPending || !newSheetName.trim()} type="submit">
              <Plus aria-hidden="true" size={16} />
              탭 추가
            </button>
          </form>
          <div className="sheet-settings-editor">
            <div className="sheet-settings-tab-panel">
              <span className="sheet-settings-label">편집할 탭</span>
              <div className="sheet-settings-tab-list" role="tablist" aria-label="편집할 탭">
                {sheets.map((sheet) => (
                  <button
                    key={sheet.id}
                    className={`sheet-settings-tab${sheet.id === selectedSheet?.id ? " active" : ""}`}
                    type="button"
                    role="tab"
                    aria-selected={sheet.id === selectedSheet?.id}
                    onClick={() => {
                      setSelectedSheetId(sheet.id);
                      setSelectedSheetName(sheet.name);
                    }}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="sheet-settings-workspace">
              <div className="sheet-settings-selected-card">
                <span className="sheet-settings-label">선택한 탭</span>
                <strong>{selectedSheet?.name ?? "-"}</strong>
              </div>
              <form className="sheet-settings-detail" onSubmit={save}>
                <section className="sheet-settings-edit-zone" aria-label="탭 수정">
                  <h3>탭 수정</h3>
                  <label>
                    탭 이름
                    <input
                      aria-label="선택한 탭 이름"
                      disabled={!selectedSheet}
                      maxLength={30}
                      value={selectedSheetName}
                      onChange={(event) => setSelectedSheetName(event.currentTarget.value)}
                    />
                  </label>
                  <div className="sheet-settings-detail-actions">
                    <button className="danger-button" disabled={isPending || !canDelete} type="button" onClick={() => void remove()}>
                      <Trash2 aria-hidden="true" size={16} />
                      탭 삭제
                    </button>
                    <button className="primary-button" disabled={isPending || !canSave} type="submit">
                      <Save aria-hidden="true" size={16} />
                      탭 저장
                    </button>
                  </div>
                </section>
              </form>
            </div>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}

export function BoardTableToolModal({
  isRefreshingCharacters,
  onClose,
  onRefreshCharacters,
  onSaved,
  refreshableCharacterCount,
  table,
  tool
}: {
  isRefreshingCharacters?: boolean | undefined;
  onClose: () => void;
  onRefreshCharacters?: (() => Promise<TableCharacterRefreshSummary>) | undefined;
  onSaved: () => void | Promise<void>;
  refreshableCharacterCount?: number | undefined;
  table: BoardTable;
  tool: ActiveTableTool["tool"];
}) {
  const title =
    tool === "characters" ? "캐릭터 추가/가져오기" : tool === "tasks" ? "숙제 추가" : "완료 열 추가";
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshMessageTone, setRefreshMessageTone] = useState<"notice" | "error">("notice");

  async function refreshCharacters() {
    if (!onRefreshCharacters || isRefreshingCharacters || !refreshableCharacterCount) return;

    setRefreshMessage(null);
    const result = await onRefreshCharacters();
    if (result.totalCount === 0) {
      setRefreshMessageTone("error");
      setRefreshMessage("갱신할 가져온 캐릭터가 없습니다.");
      return;
    }
    if (result.failedCount > 0) {
      setRefreshMessageTone("error");
      setRefreshMessage(`${result.refreshedCount}명 업데이트, ${result.failedCount}명 실패했습니다.`);
      return;
    }
    setRefreshMessageTone("notice");
    setRefreshMessage(`${result.refreshedCount}명 업데이트 완료`);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`tool-modal${tool === "tasks" ? " task-tool-modal" : ""}`} aria-modal="true" role="dialog">
        <header className="tool-modal-header">
          <h2>{title}</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body">
          {tool === "characters" ? (
            <div className="board-character-tool-body">
              <section className="board-character-refresh-panel" aria-label={`${table.name} 캐릭터 정보 일괄 업데이트`}>
                <div>
                  <strong>캐릭터 정보 일괄 업데이트</strong>
                  <span>
                    가져온 캐릭터 {refreshableCharacterCount ?? 0}명
                  </span>
                </div>
                <button
                  className="primary-button"
                  disabled={isRefreshingCharacters || !refreshableCharacterCount}
                  type="button"
                  onClick={() => void refreshCharacters()}
                >
                  <RefreshCw aria-hidden="true" size={16} />
                  {isRefreshingCharacters ? "업데이트 중" : "업데이트"}
                </button>
                {refreshMessage ? <p className={refreshMessageTone === "error" ? "error-text" : "notice-text"}>{refreshMessage}</p> : null}
              </section>
              <CharacterImport tableId={table.id} onSaved={onSaved} />
            </div>
          ) : tool === "tasks" ? (
            <TaskForm tableId={table.id} onSaved={onSaved} />
          ) : (
            <BoardEventCompletionColumnForm tableId={table.id} onClose={onClose} onSaved={onSaved} />
          )}
        </div>
      </section>
    </div>
  );
}

function BoardEventCompletionColumnForm({
  onClose,
  onSaved,
  tableId
}: {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  tableId: string;
}) {
  const [name, setName] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = name.trim();
    if (!label) return;

    setIsPending(true);
    setError(null);
    try {
      await apiPost("/api/board/axis-items", {
        tableId,
        axis: "column",
        label
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "완료 열을 추가하지 못했습니다.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form className="edit-form event-completion-column-form" onSubmit={handleSubmit}>
      <label>
        체크 항목 이름
        <input
          autoFocus
          maxLength={30}
          placeholder="부계정, 친구, 가족 등"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="edit-actions">
        <button disabled={isPending} type="button" onClick={onClose}>
          취소
        </button>
        <button className="primary-button" disabled={isPending || !name.trim()} type="submit">
          <Save aria-hidden="true" size={16} />완료 열 추가
        </button>
      </div>
    </form>
  );
}

export function BoardTableCreateModal({
  defaultColumnWidth,
  defaultRowHeight,
  displaySettings,
  eventCompletionColumnName,
  eventRewardFilters,
  isPending,
  name,
  onClose,
  onDefaultColumnWidthChange,
  onDefaultRowHeightChange,
  onDisplaySettingsChange,
  onEventCompletionColumnNameChange,
  onEventRewardFiltersChange,
  onNameChange,
  onOrientationChange,
  onTemplateChange,
  onSubmit,
  orientation,
  template
}: {
  defaultColumnWidth: string;
  defaultRowHeight: string;
  displaySettings: BoardDisplaySettings;
  eventCompletionColumnName: string;
  eventRewardFilters: LostArkEventRewardFilter[];
  isPending: boolean;
  name: string;
  onClose: () => void;
  onDefaultColumnWidthChange: (value: string) => void;
  onDefaultRowHeightChange: (value: string) => void;
  onDisplaySettingsChange: (settings: BoardDisplaySettings) => void;
  onEventCompletionColumnNameChange: (value: string) => void;
  onEventRewardFiltersChange: (filters: LostArkEventRewardFilter[]) => void;
  onNameChange: (name: string) => void;
  onOrientationChange: (orientation: BoardOrientation) => void;
  onTemplateChange: (template: BoardTableTemplate) => void;
  onSubmit: () => void;
  orientation: BoardOrientation;
  template: BoardTableTemplate;
}) {
  function toggleRewardFilter(value: LostArkEventRewardFilter, checked: boolean) {
    const next = checked ? [...new Set([...eventRewardFilters, value])] : eventRewardFilters.filter((filter) => filter !== value);
    onEventRewardFiltersChange(next.length > 0 ? next : [value]);
  }

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
            <legend>표 유형</legend>
            <div className="orientation-option-grid">
              <label className="orientation-option">
                <input checked={template === "custom"} type="radio" name="table-template" onChange={() => onTemplateChange("custom")} />
                <Columns3 aria-hidden="true" size={16} />
                일반 표
                <small>행/열을 자유롭게 구성합니다.</small>
              </label>
              <label className="orientation-option">
                <input checked={template === "lostark_event"} type="radio" name="table-template" onChange={() => onTemplateChange("lostark_event")} />
                <Rows3 aria-hidden="true" size={16} />
                카게/필보/모험섬 표
                <small>스케줄 행과 체크 열을 자동 생성합니다.</small>
              </label>
            </div>
          </fieldset>
          {template === "lostark_event" ? (
            <>
              <fieldset className="visibility-fieldset event-template-fieldset">
                <legend>모험섬 관심 보상</legend>
                <div className="event-reward-filter-grid">
                  {LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.map((option) => (
                    <label key={option.value} className="toggle-row">
                      <input
                        checked={eventRewardFilters.includes(option.value)}
                        type="checkbox"
                        onChange={(event) => toggleRewardFilter(option.value, event.currentTarget.checked)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                <button className="secondary-button" type="button" onClick={() => onEventRewardFiltersChange(["gold"])}>
                  쌀섬만 보기
                </button>
              </fieldset>
              <label>
                기본 체크 항목
                <input
                  maxLength={30}
                  value={eventCompletionColumnName}
                  onChange={(event) => onEventCompletionColumnNameChange(event.currentTarget.value)}
                />
              </label>
            </>
          ) : (
          <fieldset className="visibility-fieldset">
            <legend>행/열 표시 방향</legend>
            <div className="orientation-option-grid">
              <label className="orientation-option">
                <input
                  checked={orientation === "tasks_columns"}
                  type="radio"
                  name="table-orientation"
                  onChange={() => onOrientationChange("tasks_columns")}
                />
                <Columns3 aria-hidden="true" size={16} />
                숙제 열 / 캐릭터 행
                <small>숙제가 가로</small>
              </label>
              <label className="orientation-option">
                <input
                  checked={orientation === "tasks_rows"}
                  type="radio"
                  name="table-orientation"
                  onChange={() => onOrientationChange("tasks_rows")}
                />
                <Rows3 aria-hidden="true" size={16} />
                숙제 행 / 캐릭터 열
                <small>숙제가 세로</small>
              </label>
            </div>
          </fieldset>
          )}
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
          {template === "custom" ? <BoardDisplayOptions settings={displaySettings} onChange={onDisplaySettingsChange} /> : null}
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

function BoardNoteEditModal({
  isPending = false,
  mode,
  note,
  onClose,
  onDelete,
  onSave
}: {
  isPending?: boolean | undefined;
  mode: "create" | "edit";
  note?: BoardNote | undefined;
  onClose: () => void;
  onDelete?: ((noteId: string) => Promise<void>) | undefined;
  onSave: (input: BoardNoteSaveInput) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(note?.title ?? "메모");
  const [body, setBody] = useState(note?.body ?? "");
  const [color, setColor] = useState(note?.color ?? BOARD_NOTE_DEFAULT_COLOR);
  const [width, setWidth] = useState(String(note?.width ?? 220));
  const [height, setHeight] = useState(String(note?.height ?? 160));
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingState = isPending || pending !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;

    setPending("save");
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        body,
        color,
        width: normalizeBoundedIntegerDraft(width, { min: BOARD_NOTE_MIN_WIDTH, max: BOARD_NOTE_MAX_WIDTH, fallback: note?.width ?? 220 }),
        height: normalizeBoundedIntegerDraft(height, { min: BOARD_NOTE_MIN_HEIGHT, max: BOARD_NOTE_MAX_HEIGHT, fallback: note?.height ?? 160 })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모를 저장하지 못했습니다.");
      setPending(null);
    }
  }

  async function remove() {
    if (!note || !onDelete) return;

    setPending("delete");
    setError(null);
    try {
      await onDelete(note.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모를 삭제하지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal note-config-modal" aria-modal="true" role="dialog" aria-label={mode === "create" ? "메모 추가" : "메모 수정"}>
        <header className="tool-modal-header">
          <h2>{mode === "create" ? "메모 추가" : "메모 수정"}</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="tool-modal-body edit-form" onSubmit={submit}>
          <label>
            제목
            <input
              aria-label="메모 제목"
              maxLength={BOARD_NOTE_TITLE_MAX_LENGTH}
              spellCheck={false}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            내용
            <textarea
              aria-label="메모 내용"
              maxLength={BOARD_NOTE_BODY_MAX_LENGTH}
              spellCheck={false}
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
          </label>
          <div className="note-style-grid">
            <label>
              색상
              <input
                aria-label="메모 색상"
                className="color-edit-input"
                type="color"
                value={color}
                onChange={(event) => setColor(event.currentTarget.value)}
              />
            </label>
            {mode === "edit" ? (
              <>
                <label>
                  너비
                  <input max={BOARD_NOTE_MAX_WIDTH} min={BOARD_NOTE_MIN_WIDTH} type="number" value={width} onChange={(event) => setWidth(event.currentTarget.value)} />
                </label>
                <label>
                  높이
                  <input max={BOARD_NOTE_MAX_HEIGHT} min={BOARD_NOTE_MIN_HEIGHT} type="number" value={height} onChange={(event) => setHeight(event.currentTarget.value)} />
                </label>
              </>
            ) : null}
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            {mode === "edit" ? (
              <button className="danger-button" disabled={pendingState} type="button" onClick={() => void remove()}>
                <Trash2 aria-hidden="true" size={16} />
                메모 삭제
              </button>
            ) : (
              <button disabled={pendingState} type="button" onClick={onClose}>
                취소
              </button>
            )}
            <button className="primary-button" disabled={pendingState || !title.trim()} type="submit">
              <Save aria-hidden="true" size={16} />
              저장
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function BoardTableSettingsModal({
  axisItems,
  onClose,
  onDelete,
  onSave,
  onTranspose,
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
      eventOptions?: BoardEventOptions | null | undefined;
      applyRowSize: boolean;
      applyColumnSize: boolean;
      locked: 0 | 1;
      characterSeparator?: BoardAxisSeparator | null | undefined;
    }
  ) => Promise<void>;
  onTranspose: (tableId: string) => Promise<void>;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const [name, setName] = useState(table.name);
  const [rowHeight, setRowHeight] = useState(String(table.default_row_height));
  const [columnWidth, setColumnWidth] = useState(String(table.default_column_width));
  const [displaySettings, setDisplaySettings] = useState(parseBoardDisplaySettings(table.display_options_json) ?? settings);
  const [eventRewardFilters, setEventRewardFilters] = useState(() => parseBoardEventOptions(table.event_options_json).rewardFilters);
  const [touchedDisplayKeys, setTouchedDisplayKeys] = useState<Set<BoardDisplaySettingKey>>(() => new Set());
  const [applyRowSize, setApplyRowSize] = useState(true);
  const [applyColumnSize, setApplyColumnSize] = useState(true);
  const [applyCharacterSeparator, setApplyCharacterSeparator] = useState(false);
  const [separatorWidthPx, setSeparatorWidthPx] = useState("2");
  const [separatorStyle, setSeparatorStyle] = useState<BoardAxisSeparator["style"]>("solid");
  const [separatorColor, setSeparatorColor] = useState("#64748b");
  const [pending, setPending] = useState<"save" | "delete" | "transpose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mixedDisplayKeys = useMemo(() => getMixedBoardDisplaySettingKeys(axisItems, table, settings), [axisItems, table, settings]);
  const structureLocked = isBoardTableLocked(table);
  const isLostArkEventTable = table.template_type === "lostark_event";
  const visibleMixedDisplayKeys = useMemo(
    () => new Set([...mixedDisplayKeys].filter((key) => !touchedDisplayKeys.has(key))),
    [mixedDisplayKeys, touchedDisplayKeys]
  );

  function updateDisplaySettings(nextSettings: BoardDisplaySettings, changedKey: BoardDisplaySettingKey) {
    setDisplaySettings(nextSettings);
    setTouchedDisplayKeys((current) => {
      const next = new Set(current);
      next.add(changedKey);
      return next;
    });
  }

  function toggleEventRewardFilter(value: LostArkEventRewardFilter, checked: boolean) {
    setEventRewardFilters((current) => {
      const next = checked ? [...new Set([...current, value])] : current.filter((filter) => filter !== value);
      return LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.filter((option) => next.includes(option.value)).map((option) => option.value);
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    try {
      await onSave(table.id, {
        name: name.trim(),
        defaultRowHeight: normalizeBoundedIntegerDraft(rowHeight, { min: 16, max: 1024, fallback: table.default_row_height }),
        defaultColumnWidth: normalizeBoundedIntegerDraft(columnWidth, { min: 16, max: 1024, fallback: table.default_column_width }),
        displaySettings: structureLocked ? parseBoardDisplaySettings(table.display_options_json) : displaySettings,
        eventOptions: isLostArkEventTable ? { rewardFilters: eventRewardFilters } : undefined,
        applyRowSize,
        applyColumnSize,
        locked: isBoardTableLocked(table) ? 1 : 0,
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

  async function transpose() {
    setPending("transpose");
    setError(null);
    try {
      await onTranspose(table.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "행/열을 뒤바꾸지 못했습니다.");
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
          {structureLocked ? <p className="compact-notice">잠긴 표는 체크 완료/해제만 가능하며, 잠금을 해제한 뒤 다시 열면 구조를 수정할 수 있습니다.</p> : null}
          <label>
            표 이름
            <input disabled={structureLocked} maxLength={30} value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <div className="compact-edit-grid">
            <label>
              행 높이 일괄값
              <input
                disabled={structureLocked}
                max={1024}
                min={16}
                type="number"
                value={rowHeight}
                onChange={(event) => setRowHeight(event.currentTarget.value)}
              />
              <span className="inline-check">
                <input
                  checked={applyRowSize}
                  disabled={structureLocked}
                  type="checkbox"
                  onChange={(event) => setApplyRowSize(event.currentTarget.checked)}
                />
                기존 행 적용
              </span>
            </label>
            <label>
              열 너비 일괄값
              <input
                disabled={structureLocked}
                max={1024}
                min={16}
                type="number"
                value={columnWidth}
                onChange={(event) => setColumnWidth(event.currentTarget.value)}
              />
              <span className="inline-check">
                <input
                  checked={applyColumnSize}
                  disabled={structureLocked}
                  type="checkbox"
                  onChange={(event) => setApplyColumnSize(event.currentTarget.checked)}
                />
                기존 열 적용
              </span>
            </label>
          </div>
          <fieldset className="visibility-fieldset">
            <legend>캐릭터 구분선</legend>
            <label className="toggle-row">
              <input
                checked={applyCharacterSeparator}
                disabled={structureLocked}
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
                    disabled={structureLocked}
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
                    disabled={structureLocked}
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
                    aria-label={`${table.name} 캐릭터 구분선 색상`}
                    className="color-edit-input"
                    disabled={structureLocked}
                    type="color"
                    value={separatorColor}
                    onChange={(event) => setSeparatorColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </fieldset>
          {isLostArkEventTable ? (
            <fieldset className="visibility-fieldset event-reward-filter-fieldset">
              <legend>모험섬 관심 보상</legend>
              <p className="compact-notice">체크한 보상의 모험섬만 표기합니다. 모두 해제하면 모험섬 행을 숨깁니다.</p>
              <div className="event-reward-filter-grid">
                {LOST_ARK_EVENT_REWARD_FILTER_OPTIONS.map((option) => (
                  <label key={option.value} className="toggle-row">
                    <input
                      aria-label={`${option.label} 관심 보상`}
                      checked={eventRewardFilters.includes(option.value)}
                      disabled={structureLocked}
                      type="checkbox"
                      onChange={(event) => toggleEventRewardFilter(option.value, event.currentTarget.checked)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <BoardDisplayOptions disabled={structureLocked} mixedKeys={visibleMixedDisplayKeys} settings={displaySettings} onChange={updateDisplaySettings} />
          <fieldset className="visibility-fieldset table-structure-fieldset">
            <legend>표 구조</legend>
            <button
              className="table-transpose-button"
              disabled={pending !== null || structureLocked}
              type="button"
              aria-label={`${table.name} 행/열 뒤바꾸기`}
              onClick={() => void transpose()}
            >
              <Rows3 aria-hidden="true" size={16} />
              <Columns3 aria-hidden="true" size={16} />
              행/열 뒤바꾸기
            </button>
          </fieldset>
          {error ? <p className="error-text">{error}</p> : null}
          <div className="edit-actions">
            <button className="danger-button" disabled={pending !== null || structureLocked} type="button" onClick={() => void remove()}>
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

function renderBoardDragOverlay(
  activeSortableId: string | null,
  axisItems: BoardAxisItem[],
  table: BoardTable,
  settings: BoardDisplaySettings
): ReactNode {
  const active = activeSortableId ? parseBoardAxisSortableId(activeSortableId) : null;
  if (!active || active.tableId !== table.id) return null;

  const item = axisItems.find((axisItem) => axisItem.id === active.axisItemId && axisItem.table_id === table.id);
  return item ? (
    <div className="board-drag-overlay">
      <BoardAxisLabelText isReorderMode item={item} settings={getEffectiveBoardDisplaySettings(item, table, settings)} />
    </div>
  ) : null;
}

export function BoardTableGrid({
  axisItems,
  cellStates,
  completions,
  eventNotificationSettings,
  isMarkEditMode = false,
  isReorderMode = false,
  readOnly = false,
  table,
  onAxisItemEdit,
  onCellMarkPaint,
  onEventNotificationDelivered,
  onToggle,
  settings
}: {
  axisItems: BoardAxisItem[];
  cellStates: BoardPayload["cellStates"];
  completions: BoardPayload["completions"];
  eventNotificationSettings?: BoardEventNotificationSettings | undefined;
  isMarkEditMode?: boolean | undefined;
  isReorderMode?: boolean | undefined;
  readOnly?: boolean | undefined;
  table: BoardTable;
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined;
  onCellMarkPaint?: BoardCellMarkPaintHandler | undefined;
  onEventNotificationDelivered?: ((tableId: string) => void) | undefined;
  onToggle: (patch: BoardCompletionPatch) => void;
  settings: BoardDisplaySettings;
}) {
  const isLostArkEventTable = table.template_type === "lostark_event";
  const eventOptions = parseBoardEventOptions(table.event_options_json);
  const rewardQuery = eventOptions.rewardFilters.join(",");
  const [eventSummary, setEventSummary] = useState<LostArkEventTodaySummary | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventNow, setEventNow] = useState(() => new Date());
  const [eventRefreshToken, setEventRefreshToken] = useState(0);
  const eventNotificationSentKeysRef = useRef<Set<string>>(new Set());
  const rows = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "row" && item.visible === 1)
    .filter((row) => !(isLostArkEventTable && row.label === "모험섬" && eventOptions.rewardFilters.length === 0))
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const columns = axisItems
    .filter((item) => item.table_id === table.id && item.axis === "column" && item.visible === 1)
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
  const cellMarksByKey = new Map(
    cellStates
      .filter((cell) => cell.table_id === table.id)
      .map((cell) => [cellKey(cell.row_item_id, cell.column_item_id), cell])
  );
  const completedCells = new Set(
    completions
      .filter((completion) => completion.table_id === table.id && completion.completed === 1)
      .map((completion) => cellPeriodKey(completion.row_item_id, completion.column_item_id, completion.period_key))
  );

  useEffect(() => {
    if (!isLostArkEventTable) return;
    let cancelled = false;
    setEventError(null);
    void apiGet<LostArkEventTodaySummary>(`/api/lostark/events/today?rewards=${encodeURIComponent(rewardQuery)}`)
      .then((nextSummary) => {
        if (!cancelled) setEventSummary(nextSummary);
      })
      .catch((err) => {
        if (!cancelled) setEventError(err instanceof Error ? err.message : "오늘 스케줄 정보를 불러오지 못했습니다.");
      });
    return () => {
      cancelled = true;
    };
  }, [eventRefreshToken, isLostArkEventTable, rewardQuery]);

  useEffect(() => {
    if (!isLostArkEventTable) return;
    function updateEventNow() {
      const nextNow = new Date();
      setEventNow(nextNow);
      if (eventSummary && shouldRefreshEventSummary(eventSummary, nextNow)) {
        setEventRefreshToken((current) => current + 1);
      }
    }
    const timer = window.setInterval(() => {
      updateEventNow();
    }, BOARD_EVENT_COUNTDOWN_REFRESH_MS);
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") updateEventNow();
    }
    window.addEventListener("focus", updateEventNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateEventNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [eventSummary, isLostArkEventTable]);

  useEffect(() => {
    if (!isLostArkEventTable || !eventSummary || !eventNotificationSettings?.enabled) return;
    if (typeof window === "undefined" || !("Notification" in window) || window.Notification.permission !== "granted") return;

    const dueItems = getBoardEventNotificationDueItems({
      now: eventNow,
      sentKeys: eventNotificationSentKeysRef.current,
      settings: eventNotificationSettings,
      summary: eventSummary,
      tableId: table.id
    });
    for (const item of dueItems) {
      eventNotificationSentKeysRef.current.add(item.sentKey);
      const notification = new window.Notification(item.title, {
        body: item.body,
        icon: "/icons/icon-192.png",
        tag: item.sentKey
      });
      notification.onclick = () => {
        window.focus();
      };
    }
    if (dueItems.length > 0) {
      onEventNotificationDelivered?.(table.id);
    }
  }, [eventNotificationSettings, eventNow, eventSummary, isLostArkEventTable, onEventNotificationDelivered, table.id]);

  if (rows.length === 0 && columns.length === 0) {
    return <p className="board-empty">이 표에는 아직 행 또는 열이 없습니다.</p>;
  }

  if (rows.length === 0) {
    const columnHeaderHeight = getBoardColumnHeaderHeight(columns);
    return (
      <div className="board-check-grid" style={{ gridTemplateColumns: buildGridColumns(table, rows, columns) }}>
        <div className="board-axis-corner" style={{ minHeight: `${columnHeaderHeight}px` }} />
        {renderBoardColumnHeaders(columns, table, columnHeaderHeight, settings, isReorderMode, onAxisItemEdit)}
        <p className="board-empty board-grid-empty-state" style={{ gridColumn: `1 / span ${columns.length + 1}` }}>
          {getMissingBoardAxisPrompt(table, "row")}
        </p>
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="board-check-grid" style={{ gridTemplateColumns: buildGridColumns(table, rows, columns) }}>
        <div className="board-axis-corner" />
        <p className="board-empty board-grid-empty-state">{getMissingBoardAxisPrompt(table, "column")}</p>
        {renderBoardRowHeaders(rows, table, settings, isReorderMode, onAxisItemEdit, eventOptions.rewardFilters, eventSummary, eventNow, eventError)}
      </div>
    );
  }

  const columnHeaderHeight = getBoardColumnHeaderHeight(columns);
  return (
    <div className="board-check-grid" style={{ gridTemplateColumns: buildGridColumns(table, rows, columns) }}>
      <div className="board-axis-corner" style={{ minHeight: `${columnHeaderHeight}px` }} />
      {renderBoardColumnHeaders(columns, table, columnHeaderHeight, settings, isReorderMode, onAxisItemEdit)}
      {renderBoardRows(
        rows,
        columns,
        table,
        settings,
        isReorderMode,
        isMarkEditMode,
        completedCells,
        cellMarksByKey,
        onAxisItemEdit,
        onCellMarkPaint,
        onToggle,
        readOnly,
        eventOptions.rewardFilters,
        eventSummary,
        eventNow,
        eventError
      )}
    </div>
  );
}

function renderBoardColumnHeaders(
  columns: BoardAxisItem[],
  table: BoardTable,
  columnHeaderHeight: number,
  settings: BoardDisplaySettings,
  isReorderMode: boolean,
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined
): ReactNode {
  const headers = columns.map((column) => (
    <BoardColumnHeader
      key={column.id}
      column={column}
      columnHeaderHeight={columnHeaderHeight}
      isReorderMode={isReorderMode}
      onAxisItemEdit={isReorderMode ? undefined : onAxisItemEdit}
      settings={settings}
      table={table}
    />
  ));

  return isReorderMode ? (
    <SortableContext items={columns.map((column) => getBoardAxisSortableId(table.id, "column", column.id))} strategy={horizontalListSortingStrategy}>
      {headers}
    </SortableContext>
  ) : (
    headers
  );
}

function renderBoardRowHeaders(
  rows: BoardAxisItem[],
  table: BoardTable,
  settings: BoardDisplaySettings,
  isReorderMode: boolean,
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined,
  rewardFilters: LostArkEventRewardFilter[] = LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS,
  eventSummary?: LostArkEventTodaySummary | null | undefined,
  eventNow?: Date | undefined,
  eventError?: string | null | undefined
): ReactNode {
  const headers = rows.map((row, index) => (
    <BoardRowHeader
      eventError={eventError}
      eventNow={eventNow}
      rewardFilters={rewardFilters}
      eventSummary={eventSummary}
      isLastRow={index === rows.length - 1}
      key={row.id}
      isReorderMode={isReorderMode}
      onAxisItemEdit={isReorderMode ? undefined : onAxisItemEdit}
      row={row}
      rowHeight={row.size_px ?? table.default_row_height}
      settings={settings}
      table={table}
    />
  ));

  return isReorderMode ? (
    <SortableContext items={rows.map((row) => getBoardAxisSortableId(table.id, "row", row.id))} strategy={verticalListSortingStrategy}>
      {headers}
    </SortableContext>
  ) : (
    headers
  );
}

function renderBoardRows(
  rows: BoardAxisItem[],
  columns: BoardAxisItem[],
  table: BoardTable,
  settings: BoardDisplaySettings,
  isReorderMode: boolean,
  isMarkEditMode: boolean,
  completedCells: Set<string>,
  cellMarksByKey: Map<string, BoardCellState>,
  onAxisItemEdit: ((item: BoardAxisItem) => void) | undefined,
  onCellMarkPaint: BoardCellMarkPaintHandler | undefined,
  onToggle: (patch: BoardCompletionPatch) => void,
  readOnly: boolean,
  rewardFilters: LostArkEventRewardFilter[] = LOST_ARK_EVENT_TABLE_DEFAULT_REWARD_FILTERS,
  eventSummary?: LostArkEventTodaySummary | null | undefined,
  eventNow?: Date | undefined,
  eventError?: string | null | undefined
): ReactNode {
  const renderedRows = rows.map((row, index) => (
    <BoardGridRow
      key={row.id}
      cellMarksByKey={cellMarksByKey}
      columns={columns}
      completedCells={completedCells}
      eventError={eventError}
      eventNow={eventNow}
      rewardFilters={rewardFilters}
      eventSummary={eventSummary}
      isMarkEditMode={isMarkEditMode}
      isLastRow={index === rows.length - 1}
      isReorderMode={isReorderMode}
      onAxisItemEdit={isReorderMode ? undefined : onAxisItemEdit}
      onCellMarkPaint={onCellMarkPaint}
      onToggle={onToggle}
      readOnly={readOnly}
      row={row}
      rowHeight={row.size_px ?? table.default_row_height}
      settings={settings}
      table={table}
    />
  ));

  return isReorderMode ? (
    <SortableContext items={rows.map((row) => getBoardAxisSortableId(table.id, "row", row.id))} strategy={verticalListSortingStrategy}>
      {renderedRows}
    </SortableContext>
  ) : (
    renderedRows
  );
}

function BoardRowHeader({
  eventError,
  eventNow,
  eventSummary,
  isLastRow,
  isReorderMode,
  onAxisItemEdit,
  rewardFilters,
  row,
  rowHeight,
  settings,
  table
}: {
  eventError?: string | null | undefined;
  eventNow?: Date | undefined;
  eventSummary?: LostArkEventTodaySummary | null | undefined;
  isLastRow?: boolean | undefined;
  isReorderMode?: boolean | undefined;
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined;
  rewardFilters: LostArkEventRewardFilter[];
  row: BoardAxisItem;
  rowHeight: number;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const rowSeparator = getSeparatorBorder(row);

  return (
    <BoardAxisLabel
      className={`board-axis-label board-row-label${isLastRow ? " board-grid-last-row" : ""}`}
      isReorderMode={isReorderMode}
      item={row}
      onEdit={onAxisItemEdit ? () => onAxisItemEdit(row) : undefined}
      style={{ minHeight: `${rowHeight}px`, ...(rowSeparator ? { borderBottom: rowSeparator } : {}) }}
      tableId={table.id}
    >
      {table.template_type === "lostark_event" && !isReorderMode ? (
        <BoardScheduleRowLabel error={eventError} item={row} now={eventNow ?? new Date()} rewardFilters={rewardFilters} summary={eventSummary} />
      ) : (
        <BoardAxisLabelText isReorderMode={isReorderMode} item={row} settings={getEffectiveBoardDisplaySettings(row, table, settings)} />
      )}
    </BoardAxisLabel>
  );
}

function BoardColumnHeader({
  column,
  columnHeaderHeight,
  isReorderMode,
  onAxisItemEdit,
  settings,
  table
}: {
  column: BoardAxisItem;
  columnHeaderHeight: number;
  isReorderMode?: boolean | undefined;
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  const columnSeparator = getSeparatorBorder(column);

  return (
    <BoardAxisLabel
      className="board-axis-label board-column-label"
      isReorderMode={isReorderMode}
      item={column}
      onEdit={onAxisItemEdit ? () => onAxisItemEdit(column) : undefined}
      style={{ minHeight: `${columnHeaderHeight}px`, ...(columnSeparator ? { borderRight: columnSeparator } : {}) }}
      tableId={table.id}
    >
      <BoardAxisLabelText isReorderMode={isReorderMode} item={column} settings={getEffectiveBoardDisplaySettings(column, table, settings)} />
    </BoardAxisLabel>
  );
}

function BoardScheduleRowLabel({
  error,
  item,
  now,
  rewardFilters,
  summary
}: {
  error?: string | null | undefined;
  item: BoardAxisItem;
  now: Date;
  rewardFilters: LostArkEventRewardFilter[];
  summary?: LostArkEventTodaySummary | null | undefined;
}) {
  if (error) {
    return (
      <span className="board-schedule-row-label">
        <span className="board-schedule-title">
          {item.task_color ? <span className="board-task-color-swatch" style={{ background: item.task_color }} /> : null}
          <strong>{item.label}</strong>
        </span>
        <span className="board-schedule-subtle">스케줄 정보를 불러오지 못했습니다.</span>
      </span>
    );
  }

  if (!summary) {
    return (
      <span className="board-schedule-row-label">
        <span className="board-schedule-title">
          {item.task_color ? <span className="board-task-color-swatch" style={{ background: item.task_color }} /> : null}
          <strong>{item.label}</strong>
        </span>
        <span className="board-schedule-subtle">오늘 스케줄 확인 중</span>
      </span>
    );
  }

  if (item.label === "카게") {
    return <BoardScheduleSimpleRow color={item.task_color} label={item.label} now={now} summary={summary.chaosGate} />;
  }
  if (item.label === "필보") {
    return <BoardScheduleSimpleRow color={item.task_color} label={item.label} now={now} summary={summary.fieldBoss} />;
  }
  if (item.label === "모험섬") {
    return <BoardScheduleAdventureRow color={item.task_color} now={now} rewardFilters={rewardFilters} summary={summary.adventureIsland} />;
  }

  return <BoardAxisLabelText item={item} settings={{ show_display_name: 1, show_server_name: 0, show_class_name: 0, show_item_level: 0, show_combat_power: 0 }} />;
}

function BoardScheduleSimpleRow({
  color,
  label,
  now,
  summary
}: {
  color: string | null | undefined;
  label: string;
  now: Date;
  summary: LostArkSimpleEventSummary;
}) {
  const remaining = formatEventRemaining(getEventRemainingMinutes(summary.nextTime, now));
  return (
    <span className="board-schedule-row-label">
      <span className="board-schedule-title">
        {color ? <span className="board-task-color-swatch" style={{ background: color }} /> : null}
        <strong>{label}</strong>
      </span>
      <span className="board-schedule-meta">
        <span className={`board-schedule-badge ${summary.available ? "available" : "muted"}`}>{summary.available ? "오늘 가능" : "오늘 없음"}</span>
        {summary.nextTime ? <strong>다음 {summary.nextTime}</strong> : null}
        {remaining ? <span className="board-schedule-badge warning">{remaining}</span> : null}
      </span>
    </span>
  );
}

export function BoardScheduleAdventureRow({
  color,
  now,
  rewardFilters,
  summary
}: {
  color: string | null | undefined;
  now: Date;
  rewardFilters: LostArkEventRewardFilter[];
  summary: LostArkEventTodaySummary["adventureIsland"];
}) {
  const remaining = formatEventRemaining(getEventRemainingMinutes(summary.nextTime, now));
  const rewardText = getBoardEventRewardFilterSummary(rewardFilters);
  return (
    <span className={`board-schedule-row-label adventure${summary.entries.length > 0 ? "" : " muted"}`}>
      <span className="board-schedule-title">
        {color ? <span className="board-task-color-swatch" style={{ background: color }} /> : null}
        <strong>모험섬</strong>
        {rewardText ? <span className="board-schedule-interest">{rewardText}</span> : null}
      </span>
      <span className="board-schedule-meta">
        <span className={`board-schedule-badge ${summary.entries.length > 0 ? "available" : "muted"}`}>{getLostArkAdventureRuleLabel(summary.rule)}</span>
        {summary.nextTime ? <strong>다음 {summary.nextTime}</strong> : null}
        {remaining ? <span className="board-schedule-badge warning">{remaining}</span> : null}
        {summary.entries.length === 0 ? <span className="board-schedule-subtle">{summary.endedRewardLabels.length > 0 ? "오늘 남은 시간 없음" : "오늘 없음"}</span> : null}
      </span>
      {summary.entries.length > 0 ? (
        <span className="board-schedule-island-list">
          {summary.entries.slice(0, 3).map((entry) => (
            <span key={`${entry.claimLabel}:${entry.islandName}:${entry.futureTimes.join(",")}`} className="board-schedule-island">
              <strong>
                {entry.islandName} · {entry.rewards.join(", ")}
              </strong>
              <small className="board-schedule-island-continent">가까운 대륙: {entry.continent}</small>
              <small className="board-schedule-island-times">{entry.futureTimes.join(", ")}</small>
            </span>
          ))}
        </span>
      ) : null}
      {summary.endedRewardLabels.length > 0 ? <small className="board-schedule-subtle">{summary.endedRewardLabels.join(" / ")} 종료</small> : null}
    </span>
  );
}

function BoardEventNotificationPanel({
  customDraft,
  hidden,
  onCustomDraftChange,
  onCustomMinuteSubmit,
  onEnabledChange,
  onMinuteSelect,
  onTest,
  permission,
  settings,
  tableName
}: {
  customDraft: string;
  hidden: boolean;
  onCustomDraftChange: (value: string) => void;
  onCustomMinuteSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  onMinuteSelect: (minute: number) => void;
  onTest: () => void;
  permission: BoardEventNotificationPermission;
  settings: BoardEventNotificationSettings;
  tableName: string;
}) {
  const permissionText = permission === "unsupported" ? "알림 미지원" : permission === "denied" ? "권한 차단됨" : null;
  const [selectedMinute] = normalizeBoardEventNotificationMinutes(settings.leadMinutes);
  return (
    <div className="board-event-notification-panel" hidden={hidden} onPointerDown={(event) => event.stopPropagation()}>
      <div className="board-event-notification-panel-heading">
        <strong>다음 스케줄 1회 알림</strong>
        <button
          className={`board-event-notification-switch${settings.enabled ? " active" : ""}`}
          type="button"
          aria-checked={settings.enabled}
          aria-label={`${tableName} 알림 ${settings.enabled ? "끄기" : "켜기"}`}
          role="switch"
          onClick={() => onEnabledChange(!settings.enabled)}
        >
          <span>{settings.enabled ? "켜짐" : "꺼짐"}</span>
          <span className="board-event-notification-switch-track" aria-hidden="true">
            <span className="board-event-notification-switch-thumb" />
          </span>
        </button>
      </div>
      {permissionText ? <p className="board-event-notification-permission">{permissionText}</p> : null}
      <div className="board-event-notification-label">알림 시간</div>
      <div className="board-event-notification-current" aria-live="polite">
        {getBoardEventNotificationCurrentLabel(settings)}
      </div>
      <div className="board-event-notification-presets" aria-label="알림 시간">
        {BOARD_EVENT_NOTIFICATION_PRESET_MINUTES.map((minute) => (
          <button
            key={minute}
            className={selectedMinute === minute ? "active" : undefined}
            type="button"
            aria-pressed={selectedMinute === minute}
            onClick={() => onMinuteSelect(minute)}
          >
            {minute}분 전
          </button>
        ))}
      </div>
      <form className="board-event-notification-custom" onSubmit={onCustomMinuteSubmit}>
        <input
          aria-label={`${tableName} 사용자 지정 알림 시간`}
          inputMode="numeric"
          maxLength={3}
          placeholder="직접"
          spellCheck={false}
          type="text"
          value={customDraft}
          onChange={(event) => onCustomDraftChange(event.currentTarget.value)}
        />
        <span>분 전</span>
        <button type="submit">적용</button>
      </form>
      <div className="board-event-notification-footer">
        <button className="board-event-notification-test-button" type="button" title="운영체제 알림 표시만 확인합니다" onClick={onTest}>
          알림 테스트
        </button>
      </div>
    </div>
  );
}

function BoardAxisLabelText({
  isReorderMode,
  item,
  settings
}: {
  isReorderMode?: boolean | undefined;
  item: BoardAxisItem;
  settings: BoardDisplaySettings;
}) {
  if (item.kind === "character") {
    const identityMeta = getBoardCharacterIdentityMeta(item, settings);
    const progressMeta = getBoardCharacterProgressMeta(item, settings);
    const detail = getBoardCharacterDetail(item);
    return (
      <span className="board-axis-label-text board-character-axis-label">
        <span className="board-character-label" title={isReorderMode ? undefined : detail}>
          {getBoardCharacterLabel(item, settings)}
        </span>
        {identityMeta.length > 0 || progressMeta.length > 0 ? (
          <small className="board-character-meta">
            {identityMeta.length > 0 ? <span>{identityMeta.join(" · ")}</span> : null}
            {progressMeta.map((meta) => (
              <span key={meta}>{meta}</span>
            ))}
          </small>
        ) : null}
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
  isReorderMode,
  item,
  onEdit,
  style,
  tableId
}: {
  children: ReactNode;
  className: string;
  isReorderMode?: boolean | undefined;
  item: BoardAxisItem;
  onEdit?: (() => void) | undefined;
  style?: CSSProperties | undefined;
  tableId: string;
}) {
  if (isReorderMode) {
    return (
      <SortableBoardAxisLabel className={className} item={item} style={style} tableId={tableId}>
        {children}
      </SortableBoardAxisLabel>
    );
  }
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

function SortableBoardAxisLabel({
  children,
  className,
  item,
  style,
  tableId
}: {
  children: ReactNode;
  className: string;
  item: BoardAxisItem;
  style?: CSSProperties | undefined;
  tableId: string;
}) {
  const sortableId = getBoardAxisSortableId(tableId, item.axis, item.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sortableId });
  const sortableStyle: CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      className={`${className} board-sortable-axis-label${isDragging ? " dragging" : ""}`}
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      aria-label={`${item.label} 순서 이동`}
      data-reorder-axis={item.axis}
      data-reorder-id={item.id}
      data-reorder-target="true"
    >
      {children}
    </div>
  );
}

function BoardGridRow({
  cellMarksByKey,
  columns,
  completedCells,
  eventError,
  eventNow,
  eventSummary,
  isMarkEditMode,
  isLastRow,
  isReorderMode,
  onAxisItemEdit,
  onCellMarkPaint,
  onToggle,
  readOnly,
  rewardFilters,
  row,
  rowHeight,
  settings,
  table
}: {
  cellMarksByKey: Map<string, BoardCellState>;
  columns: BoardAxisItem[];
  completedCells: Set<string>;
  eventError?: string | null | undefined;
  eventNow?: Date | undefined;
  eventSummary?: LostArkEventTodaySummary | null | undefined;
  isMarkEditMode?: boolean | undefined;
  isLastRow?: boolean | undefined;
  isReorderMode?: boolean | undefined;
  onAxisItemEdit?: ((item: BoardAxisItem) => void) | undefined;
  onCellMarkPaint?: BoardCellMarkPaintHandler | undefined;
  onToggle: (patch: BoardCompletionPatch) => void;
  readOnly: boolean;
  rewardFilters: LostArkEventRewardFilter[];
  row: BoardAxisItem;
  rowHeight: number;
  settings: BoardDisplaySettings;
  table: BoardTable;
}) {
  return (
    <>
      <BoardRowHeader
        eventError={eventError}
        eventNow={eventNow}
        rewardFilters={rewardFilters}
        eventSummary={eventSummary}
        isLastRow={isLastRow}
        isReorderMode={isReorderMode}
        onAxisItemEdit={onAxisItemEdit}
        row={row}
        rowHeight={rowHeight}
        settings={settings}
        table={table}
      />
      {columns.map((column) => (
        <BoardCheckCell
          key={column.id}
          cellState={cellMarksByKey.get(cellKey(row.id, column.id))}
          column={column}
          completedCells={completedCells}
          eventSummary={eventSummary}
          isMarkEditMode={isMarkEditMode === true}
          isLastRow={isLastRow === true}
          isReorderMode={isReorderMode === true}
          onCellMarkPaint={onCellMarkPaint}
          onToggle={onToggle}
          readOnly={readOnly}
          row={row}
          rowHeight={rowHeight}
          table={table}
        />
      ))}
    </>
  );
}

function renderBoardCellMarkIcon(icon: BoardCellMarkIcon, size: number) {
  const iconProps = { "aria-hidden": true, size, strokeWidth: 3 };
  if (icon === "memo") return <StickyNote {...iconProps} />;
  if (icon === "pin") return <Pin {...iconProps} />;
  if (icon === "clock") return <Clock {...iconProps} />;
  if (icon === "star") return <Star {...iconProps} />;
  if (icon === "alert") return <AlertTriangle {...iconProps} />;
  if (icon === "flag") return <Flag {...iconProps} />;
  if (icon === "tag") return <Tag {...iconProps} />;
  const exhaustiveIcon: never = icon;
  return exhaustiveIcon;
}

function BoardCheckCell({
  cellState,
  column,
  completedCells,
  eventSummary,
  isMarkEditMode,
  isLastRow,
  isReorderMode,
  onCellMarkPaint,
  onToggle,
  readOnly,
  row,
  rowHeight,
  table
}: {
  cellState: BoardCellState | undefined;
  column: BoardAxisItem;
  completedCells: Set<string>;
  eventSummary?: LostArkEventTodaySummary | null | undefined;
  isMarkEditMode: boolean;
  isLastRow: boolean;
  isReorderMode: boolean;
  onCellMarkPaint?: BoardCellMarkPaintHandler | undefined;
  onToggle: (patch: BoardCompletionPatch) => void;
  readOnly: boolean;
  row: BoardAxisItem;
  rowHeight: number;
  table: BoardTable;
}) {
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);
  const rowSeparator = getSeparatorBorder(row);
  const taskColor = getTaskColor(row, column);
  const colorStyle = taskColor ? ({ "--task-color": taskColor } as CSSProperties) : undefined;
  const columnSeparator = getSeparatorBorder(column);
  const periodKey = getBoardCellPeriodKey(row, column);
  const completedKey = periodKey ? cellPeriodKey(row.id, column.id, periodKey) : null;
  const isCompleted = completedKey ? completedCells.has(completedKey) : false;
  const mark = resolveBoardCellMark(cellState, periodKey);
  const isDisabledCell = mark?.type === "disabled";
  const isScheduleUnavailable = table.template_type === "lostark_event" && !getBoardScheduleRowAvailable(row.label, eventSummary);
  const markLabel = mark?.icon ? BOARD_CELL_MARK_ICON_LABELS[mark.icon] : null;
  const hasTooltipContent = Boolean(markLabel || mark?.memo);
  const cellStyle: CSSProperties = {
    minHeight: `${rowHeight}px`,
    ...(rowSeparator ? { borderBottom: rowSeparator } : {}),
    ...(columnSeparator ? { borderRight: columnSeparator } : {})
  };

  function clearTooltipTimer() {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }

  useEffect(() => clearTooltipTimer, []);

  return (
    <div
      className={`board-check-cell${isLastRow ? " board-grid-last-row" : ""}${isMarkEditMode ? " mark-editable" : ""}`}
      style={cellStyle}
      onClick={isMarkEditMode && onCellMarkPaint ? () => onCellMarkPaint(row, column, mark, periodKey) : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || isMarkEditMode || isReorderMode || !hasTooltipContent) return;
        clearTooltipTimer();
        const cellElement = event.currentTarget;
        tooltipTimerRef.current = window.setTimeout(() => {
          // 그리드(overflow: auto)와 표 영역이 셀 내부 absolute 툴팁을 잘라내므로
          // 뷰포트 좌표를 잡아 body 포털 + fixed로 띄운다.
          const rect = cellElement.getBoundingClientRect();
          setTooltipPosition({ x: rect.left + rect.width / 2, y: rect.bottom - 2 });
        }, 1000);
      }}
      onPointerLeave={() => {
        clearTooltipTimer();
        setTooltipPosition(null);
      }}
    >
      {isDisabledCell ? (
        <span className="board-check-placeholder" aria-label={`${row.label} / ${column.label} 비활성화`} />
      ) : (
        <span className={`board-check-wrap${isCompleted ? " checked" : ""}${mark?.icon ? " has-icon" : ""}`}>
          <input
            aria-label={`${row.label} / ${column.label}`}
            checked={isCompleted}
            className="board-check"
            disabled={readOnly || !periodKey || isReorderMode || isMarkEditMode || isScheduleUnavailable}
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
          {mark?.icon ? (
            <span aria-label={`${row.label} / ${column.label} ${BOARD_CELL_MARK_ICON_LABELS[mark.icon]}`} className={`board-check-icon-overlay ${mark.icon}`} title={BOARD_CELL_MARK_ICON_LABELS[mark.icon]}>
              {renderBoardCellMarkIcon(mark.icon, 13)}
            </span>
          ) : null}
        </span>
      )}
      {tooltipPosition && hasTooltipContent && typeof document !== "undefined"
        ? createPortal(
            <div
              className="board-cell-mark-tooltip"
              role="tooltip"
              style={{ left: `${tooltipPosition.x}px`, top: `${tooltipPosition.y}px` }}
            >
              {markLabel ? <strong>{markLabel}</strong> : null}
              {mark?.memo ? <span>{mark.memo}</span> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function BoardCellMarkToolbar({
  brush,
  notice,
  onBrushChange
}: {
  brush: BoardCellMarkBrush;
  notice: string | null;
  onBrushChange: (brush: BoardCellMarkBrush) => void;
}) {
  const memoEnabled = !brush.disabled;
  const description = notice ?? (brush.disabled ? "비활성화된 체크칸은 체크박스를 숨깁니다." : null);

  return (
    <div className="board-cell-mark-toolbar" onPointerDown={(event) => event.stopPropagation()}>
      <div className="board-cell-mark-options" role="radiogroup" aria-label="체크칸 아이콘">
        <button
          className={`board-cell-mark-option${brush.icon === null ? " active" : ""}`}
          disabled={brush.disabled}
          type="button"
          role="radio"
          aria-checked={brush.icon === null}
          onClick={() => onBrushChange({ ...brush, icon: null })}
        >
          기본
        </button>
        {BOARD_CELL_MARK_ICON_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`board-cell-mark-option icon-only${brush.icon === option.value ? " active" : ""}`}
            disabled={brush.disabled}
            type="button"
            role="radio"
            aria-label={`아이콘: ${option.label}`}
            aria-checked={brush.icon === option.value}
            title={option.label}
            onClick={() => onBrushChange({ ...brush, icon: option.value })}
          >
            {renderBoardCellMarkIcon(option.value, 16)}
          </button>
        ))}
      </div>
      <div className="board-cell-mark-retention-options" aria-label="체크칸 기간 옵션">
        <button
          className={`board-cell-mark-option${brush.retention === "period" ? " active" : ""}`}
          disabled={brush.disabled}
          type="button"
          aria-label="이번주만"
          aria-pressed={brush.retention === "period"}
          onClick={() => onBrushChange({ ...brush, retention: brush.retention === "period" ? "permanent" : "period" })}
        >
          이번주만
        </button>
        <button
          className={`board-cell-mark-option${brush.disabled ? " active" : ""}`}
          type="button"
          aria-label="체크칸 비활성화"
          aria-pressed={brush.disabled}
          onClick={() => onBrushChange({ ...brush, disabled: !brush.disabled })}
        >
          비활성화
        </button>
      </div>
      {memoEnabled ? (
        <textarea
          aria-label="브러시 메모"
          className="board-cell-mark-memo-input"
          maxLength={120}
          placeholder="메모 (선택, 칠하는 셀에 함께 적용)"
          rows={3}
          value={brush.memo}
          onChange={(event) => onBrushChange({ ...brush, memo: event.currentTarget.value })}
        />
      ) : null}
      {description ? <p className="cell-mark-description">{description}</p> : null}
    </div>
  );
}

export function BoardAxisItemEditModal({
  item,
  onClose,
  onCharacterRefresh,
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
    input: BoardCharacterSaveInput
  ) => Promise<void>;
  onCharacterRefresh?: ((characterId: string) => Promise<BoardCharacterRefreshResult>) | undefined;
  onDelete: (axisItemId: string) => Promise<void>;
  onSave: (
    axisItemId: string,
    label: string,
    taskColor?: string | null,
    taskResetType?: BoardTaskResetType,
    taskResetRuleJson?: string,
    separator?: BoardAxisSeparator | null,
    sizePx?: number | null,
    crossSizePx?: number | null,
    displaySettings?: BoardDisplaySettings | null,
    shouldUpdateDetails?: boolean
  ) => Promise<void>;
}) {
  const initialSeparator = parseBoardAxisSeparator(item.separator_json);
  const [label, setLabel] = useState(item.label);
  const sizeFallback = item.axis === "row" ? table?.default_row_height ?? 40 : table?.default_column_width ?? 132;
  const crossSizeFallback = item.axis === "row" ? BOARD_ROW_HEADER_FALLBACK_WIDTH : BOARD_COLUMN_HEADER_FALLBACK_HEIGHT;
  const [sizePx, setSizePx] = useState(String(item.size_px ?? sizeFallback));
  const [crossSizePx, setCrossSizePx] = useState(String(item.cross_size_px ?? crossSizeFallback));
  const [characterName, setCharacterName] = useState(getBoardCharacterName(item));
  const [characterServerName, setCharacterServerName] = useState(item.character_server_name ?? "");
  const [characterClassName, setCharacterClassName] = useState(item.character_class_name ?? "");
  const [characterDisplayName, setCharacterDisplayName] = useState(item.character_display_name ?? "");
  const [characterItemLevel, setCharacterItemLevel] = useState(item.character_item_level ?? "");
  const [characterCombatPower, setCharacterCombatPower] = useState(item.character_combat_power ?? "");
  const initialTaskColor = item.task_color ?? "#2563eb";
  const [taskColor, setTaskColor] = useState(initialTaskColor);
  const initialTaskResetType: BoardTaskResetType =
    item.task_reset_type === "weekly" || item.task_reset_type === "biweekly" || item.task_reset_type === "none"
      ? item.task_reset_type
      : "daily";
  const [taskResetType, setTaskResetType] = useState<BoardTaskResetType>(initialTaskResetType);
  const initialDisplaySettings =
    parseBoardDisplaySettings(item.display_options_json) ?? (table ? parseBoardDisplaySettings(table.display_options_json) : null) ?? settings;
  const [displaySettings, setDisplaySettings] = useState(initialDisplaySettings);
  const [separatorEnabled, setSeparatorEnabled] = useState(initialSeparator !== null);
  const [separatorWidthPx, setSeparatorWidthPx] = useState(String(initialSeparator?.widthPx ?? 2));
  const [separatorStyle, setSeparatorStyle] = useState<BoardAxisSeparator["style"]>(initialSeparator?.style ?? "solid");
  const [separatorColor, setSeparatorColor] = useState(initialSeparator?.color ?? "#64748b");
  const [pending, setPending] = useState<"save" | "delete" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshBlockedUntil, setRefreshBlockedUntil] = useState(0);
  const normalizedLabel = label.trim();
  const isTaskItem = item.kind === "task";
  const isCharacterItem = item.kind === "character";
  const isManualCharacterItem = isCharacterItem && item.character_source === "manual";
  const isImportedCharacterItem = isCharacterItem && Boolean(item.character_id) && !isManualCharacterItem;
  const normalizedCharacterDisplayName = characterDisplayName.trim();
  const normalizedCharacterName = characterName.trim();
  const normalizedCharacterServerName = characterServerName.trim();
  const normalizedCharacterClassName = characterClassName.trim();
  const normalizedCharacterItemLevel = characterItemLevel.trim();
  const normalizedCharacterCombatPower = characterCombatPower.trim();
  const canSave = isManualCharacterItem ? Boolean(normalizedCharacterName) : isImportedCharacterItem ? true : Boolean(normalizedLabel);
  const separator = separatorEnabled
    ? {
        widthPx: normalizeBoundedIntegerDraft(separatorWidthPx, { min: 1, max: 8, fallback: initialSeparator?.widthPx ?? 2 }),
        style: separatorStyle,
        color: separatorColor
      }
    : null;
  const refreshCooldown = getCharacterRefreshCooldownState(refreshBlockedUntil);
  const shouldUpdateAxisDetails =
    (!isImportedCharacterItem && !isManualCharacterItem && normalizedLabel !== item.label) ||
    (isTaskItem && taskColor !== initialTaskColor) ||
    (isTaskItem && taskResetType !== initialTaskResetType) ||
    JSON.stringify(separator) !== JSON.stringify(initialSeparator) ||
    (isCharacterItem && JSON.stringify(displaySettings) !== JSON.stringify(initialDisplaySettings));

  useEffect(() => {
    if (!refreshCooldown.isBlocked) return;
    const timer = window.setTimeout(() => setRefreshBlockedUntil(0), refreshCooldown.remainingMs);
    return () => window.clearTimeout(timer);
  }, [refreshBlockedUntil, refreshCooldown.isBlocked, refreshCooldown.remainingMs]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;

    setPending("save");
    setError(null);
    try {
      if (
        isCharacterItem &&
        item.character_id &&
        shouldSaveBoardCharacterDetails(
          item,
          characterDisplayName,
          characterItemLevel,
          characterCombatPower,
          isManualCharacterItem ? characterName : undefined,
          isManualCharacterItem ? characterServerName : undefined,
          isManualCharacterItem ? characterClassName : undefined
        )
      ) {
        await onCharacterSave(item.character_id, {
          name: isManualCharacterItem ? normalizedCharacterName : undefined,
          serverName: isManualCharacterItem ? normalizedCharacterServerName : undefined,
          className: isManualCharacterItem ? normalizedCharacterClassName : undefined,
          displayName: normalizedCharacterDisplayName ? normalizedCharacterDisplayName : null,
          itemLevel: normalizedCharacterItemLevel || null,
          combatPower: normalizedCharacterCombatPower ? normalizedCharacterCombatPower : null
        });
      }
      const savedLabel = isManualCharacterItem ? normalizedCharacterName : isImportedCharacterItem ? item.label : normalizedLabel;
      await onSave(
        item.id,
        savedLabel,
        isTaskItem ? taskColor : undefined,
        isTaskItem ? taskResetType : undefined,
        isTaskItem ? getBoardTaskResetRuleJson(taskResetType) : undefined,
        separator,
        normalizeBoundedIntegerDraft(sizePx, { min: BOARD_AXIS_PRIMARY_SIZE_MIN, max: BOARD_AXIS_SIZE_MAX, fallback: sizeFallback }),
        normalizeBoundedIntegerDraft(crossSizePx, { min: BOARD_AXIS_LABEL_SIZE_MIN, max: BOARD_AXIS_SIZE_MAX, fallback: crossSizeFallback }),
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

  async function handleRefreshCharacter() {
    if (!item.character_id || !onCharacterRefresh) return;
    if (refreshCooldown.isBlocked) {
      setError(refreshCooldown.title);
      return;
    }
    setPending("refresh");
    setError(null);
    setRefreshBlockedUntil(Date.now() + CHARACTER_REFRESH_CLIENT_COOLDOWN_MS);
    try {
      const updated = await onCharacterRefresh(item.character_id);
      setCharacterName(updated.name);
      setCharacterServerName(updated.serverName);
      setCharacterClassName(updated.className);
      setCharacterItemLevel(updated.itemLevel);
      setCharacterCombatPower(updated.combatPower ?? "");
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "캐릭터 정보를 갱신하지 못했습니다.");
      setPending(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`tool-modal edit-modal${isCharacterItem ? " character-axis-edit-modal" : ""}`} aria-modal="true" role="dialog" aria-label="행 또는 열 수정">
        <header className="tool-modal-header">
          <h2>항목 수정</h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="tool-modal-body edit-form" onSubmit={handleSave}>
          {isImportedCharacterItem || isManualCharacterItem || isTaskItem ? null : (
            <label>
              이름
              <input maxLength={30} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
            </label>
          )}
          {isTaskItem ? (
            <div className="task-edit-basic-grid">
              <label>
                이름
                <input maxLength={30} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
              </label>
              <label>
                초기화 주기
                <select value={taskResetType} onChange={(event) => setTaskResetType(event.currentTarget.value as BoardTaskResetType)}>
                  {BOARD_TASK_RESET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {isImportedCharacterItem ? (
            <div className="character-summary-card">
              <span className="character-summary-avatar" aria-hidden="true">
                {Array.from(getBoardCharacterName(item))[0] ?? "?"}
              </span>
              <div className="character-summary-main">
                <strong className="character-summary-title">{getBoardCharacterName(item)}</strong>
                <span className="character-summary-meta" aria-label={`${item.character_server_name ?? "-"} / ${item.character_class_name ?? "-"}`}>
                  <span className="character-summary-chip">{item.character_server_name ?? "-"}</span>
                  <span className="character-summary-chip">{item.character_class_name ?? "-"}</span>
                </span>
              </div>
              <button
                className="secondary-button"
                disabled={pending !== null || refreshCooldown.isBlocked}
                type="button"
                onClick={() => void handleRefreshCharacter()}
                title={refreshCooldown.title}
              >
                <RefreshCw aria-hidden="true" size={16} />
                {pending === "refresh" ? "갱신 중" : refreshCooldown.label}
              </button>
            </div>
          ) : null}
          {isCharacterItem ? (
            <div className="compact-edit-grid">
              {isManualCharacterItem ? (
                <>
                  <label>
                    닉네임
                    <input
                      maxLength={20}
                      value={characterName}
                      onChange={(event) => setCharacterName(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    서버
                    <input
                      maxLength={20}
                      value={characterServerName}
                      onChange={(event) => setCharacterServerName(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    직업
                    <input
                      maxLength={20}
                      value={characterClassName}
                      onChange={(event) => setCharacterClassName(event.currentTarget.value)}
                    />
                  </label>
                </>
              ) : null}
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
          {isTaskItem ? (
            <div className="compact-edit-grid task-axis-style-grid">
              <label>
                {item.axis === "row" ? "행 높이" : "열 너비"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_PRIMARY_SIZE_MIN}
                  type="number"
                  value={sizePx}
                  onChange={(event) => setSizePx(event.currentTarget.value)}
                />
              </label>
              <label>
                {item.axis === "row" ? "행 너비" : "열 높이"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_LABEL_SIZE_MIN}
                  type="number"
                  value={crossSizePx}
                  onChange={(event) => setCrossSizePx(event.currentTarget.value)}
                />
              </label>
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
            </div>
          ) : isCharacterItem ? (
            <div className="character-axis-layout-grid">
              <label>
                {item.axis === "row" ? "행 높이" : "열 너비"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_PRIMARY_SIZE_MIN}
                  type="number"
                  value={sizePx}
                  onChange={(event) => setSizePx(event.currentTarget.value)}
                />
              </label>
              <label>
                {item.axis === "row" ? "행 너비" : "열 높이"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_LABEL_SIZE_MIN}
                  type="number"
                  value={crossSizePx}
                  onChange={(event) => setCrossSizePx(event.currentTarget.value)}
                />
              </label>
              <BoardDisplayOptions settings={displaySettings} onChange={setDisplaySettings} />
            </div>
          ) : (
            <div className="compact-edit-grid axis-size-edit-grid">
              <label>
                {item.axis === "row" ? "행 높이" : "열 너비"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_PRIMARY_SIZE_MIN}
                  type="number"
                  value={sizePx}
                  onChange={(event) => setSizePx(event.currentTarget.value)}
                />
              </label>
              <label>
                {item.axis === "row" ? "행 너비" : "열 높이"}
                <input
                  max={BOARD_AXIS_SIZE_MAX}
                  min={BOARD_AXIS_LABEL_SIZE_MIN}
                  type="number"
                  value={crossSizePx}
                  onChange={(event) => setCrossSizePx(event.currentTarget.value)}
                />
              </label>
            </div>
          )}
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
