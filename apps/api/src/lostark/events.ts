import type { Env } from "../env";
import { ApiError } from "../http/errors";

const BASE_URL = "https://developer-lostark.game.onstove.com";
const CALENDAR_CACHE_KEY = "lostark:gamecontents:calendar:v1";
const CALENDAR_STATUS_KEY = "lostark:gamecontents:calendar:status:v1";
export const CALENDAR_CACHE_TTL_SECONDS = 60 * 15;

export type LostArkCalendarStatus = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
};

export async function getLostArkCalendarStatus(env: Env): Promise<LostArkCalendarStatus | null> {
  const status = await env.CACHE.get(CALENDAR_STATUS_KEY, "json");
  if (!status || typeof status !== "object") return null;
  const record = status as Record<string, unknown>;
  return {
    lastSuccessAt: typeof record.lastSuccessAt === "string" ? record.lastSuccessAt : null,
    lastFailureAt: typeof record.lastFailureAt === "string" ? record.lastFailureAt : null,
    lastFailureCode: typeof record.lastFailureCode === "string" ? record.lastFailureCode : null
  };
}

async function writeCalendarStatus(env: Env, update: Partial<LostArkCalendarStatus>): Promise<void> {
  try {
    const previous = await getLostArkCalendarStatus(env);
    const next: LostArkCalendarStatus = {
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: previous?.lastFailureAt ?? null,
      lastFailureCode: previous?.lastFailureCode ?? null,
      ...update
    };
    await env.CACHE.put(CALENDAR_STATUS_KEY, JSON.stringify(next));
  } catch {
    // Status tracking is best-effort; a KV failure must not break the events endpoint.
  }
}

export type LostArkEventRewardFilter = "gold" | "card" | "coin" | "silver" | "cardXp";

export interface LostArkCalendarRewardItem {
  Name?: string | null;
  StartTimes?: string[] | null;
}

export interface LostArkCalendarRewardGroup {
  Items?: LostArkCalendarRewardItem[] | null;
}

export interface LostArkCalendarContent {
  CategoryName?: string | null;
  ContentsName?: string | null;
  StartTimes?: string[] | null;
  Location?: string | null;
  RewardItems?: LostArkCalendarRewardGroup[] | null;
}

export interface LostArkSimpleEventSummary {
  available: boolean;
  detail: string | null;
  futureTimes: string[];
  nextTime: string | null;
  remainingMinutes: number | null;
}

export interface LostArkAdventureIslandEntry {
  claimLabel: "1회차" | "2회차" | "일일 1회";
  continent: string;
  futureTimes: string[];
  islandName: string;
  rewards: string[];
  slotLabel: "9시 보상" | "저녁 보상" | "일일 보상";
}

export interface LostArkAdventureIslandSummary {
  entries: LostArkAdventureIslandEntry[];
  endedRewardLabels: string[];
  hasNineRewardWindow: boolean;
  nextTime: string | null;
  remainingMinutes: number | null;
  rewardLabels: string[];
  rule: string;
}

export interface LostArkEventCalendarSummary {
  adventureIsland: LostArkAdventureIslandSummary;
  chaosGate: LostArkSimpleEventSummary;
  fieldBoss: LostArkSimpleEventSummary;
  generatedAt: string;
  today: string;
}

export interface LostArkEventNormalizeOptions {
  now?: Date | undefined;
  rewardFilters?: LostArkEventRewardFilter[] | undefined;
}

const DEFAULT_REWARD_FILTERS: LostArkEventRewardFilter[] = ["gold", "card", "coin", "silver", "cardXp"];
const KST_TIMEZONE = "Asia/Seoul";
const DAILY_RESET_MINUTES = 6 * 60;
const DAY_MINUTES = 24 * 60;

const ADVENTURE_ISLAND_CONTINENTS: Record<string, string> = {
  "고요한 안식의 섬": "로웬",
  "기회의 섬": "아르데타인",
  "라일라이 아일랜드": "파푸니카",
  "메데이아": "슈샤이어",
  "몬테섬": "베른 남부",
  "볼라르 섬": "베른 북부",
  "블루홀 섬": "베른 남부",
  "수라도": "로웬",
  "스노우팡 아일랜드": "슈샤이어",
  "우거진 갈대의 섬": "아르데타인",
  "잔혹한 장난감 성": "슈샤이어",
  "죽음의 협곡": "아르데타인",
  "쿵덕쿵 아일랜드": "베른 북부",
  "포르페": "애니츠",
  "하모니 섬": "로헨델",
  "환영 나비 섬": "로헨델"
};

const REWARD_LABELS: Record<LostArkEventRewardFilter, string> = {
  card: "카드 팩",
  cardXp: "카드 경험치",
  coin: "해적 주화",
  gold: "쌀(골드)",
  silver: "실링"
};

function readJsonOrNull(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
}

function getKstParts(now: Date): { dateKey: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: KST_TIMEZONE,
    year: "numeric"
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const calendarDateKey = `${value("year")}-${value("month")}-${value("day")}`;
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  return minutes < DAILY_RESET_MINUTES
    ? { dateKey: addDaysToDateKey(calendarDateKey, -1), minutes: minutes + DAY_MINUTES }
    : { dateKey: calendarDateKey, minutes };
}

function getCalendarDateKey(startTime: string): string {
  return startTime.slice(0, 10);
}

function getCalendarClock(startTime: string): string {
  return startTime.slice(11, 16);
}

function toMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function toOperationalMinutes(clock: string): number {
  const minutes = toMinutes(clock);
  return minutes < DAILY_RESET_MINUTES ? minutes + DAY_MINUTES : minutes;
}

function formatClockFromMinutes(minutes: number): string {
  const normalized = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function getWeekdayFromDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

function uniqueSortedTimes(times: string[]): string[] {
  return [...new Set(times)].sort((left, right) => toOperationalMinutes(left) - toOperationalMinutes(right));
}

function getTodayTimes(startTimes: string[] | null | undefined, today: string): string[] {
  if (!Array.isArray(startTimes)) return [];
  const nextDateKey = addDaysToDateKey(today, 1);
  return uniqueSortedTimes(
    startTimes
      .filter((time) => {
        const dateKey = getCalendarDateKey(time);
        const minutes = toMinutes(getCalendarClock(time));
        return (dateKey === today && minutes >= DAILY_RESET_MINUTES) || (dateKey === nextDateKey && minutes < DAILY_RESET_MINUTES);
      })
      .map(getCalendarClock)
  );
}

function getFutureTimes(times: string[], nowMinutes: number): string[] {
  return times.filter((time) => toOperationalMinutes(time) > nowMinutes);
}

function minutesUntil(clock: string | null, nowMinutes: number): number | null {
  if (!clock) return null;
  return Math.max(0, toOperationalMinutes(clock) - nowMinutes);
}

function getScheduledHourlyFutureTimes(nowMinutes: number, minuteOffset: number): string[] {
  const times: string[] = [];
  for (let hour = 0; hour <= 29; hour += 1) {
    const scheduledMinutes = hour * 60 + minuteOffset;
    if (scheduledMinutes > nowMinutes) times.push(formatClockFromMinutes(scheduledMinutes));
  }
  return times.slice(0, 5);
}

function classifyReward(name: string | null | undefined): LostArkEventRewardFilter | null {
  const text = name ?? "";
  if (text.includes("골드")) return "gold";
  if (text.includes("카드 팩")) return "card";
  if (text.includes("메넬리크") || text.includes("영혼의 잎사귀") || text.includes("카드 경험치")) return "cardXp";
  if (text.includes("주화") || text.includes("해적")) return "coin";
  if (text.includes("실링")) return "silver";
  return null;
}

function getSimpleEventSummary(contents: LostArkCalendarContent[], categoryName: string, today: string, nowMinutes: number): LostArkSimpleEventSummary {
  const todayEntries = contents.filter((item) => item.CategoryName === categoryName && getTodayTimes(item.StartTimes, today).length > 0);
  const firstEntry = todayEntries[0] ?? null;
  const schedule =
    categoryName === "카오스게이트"
      ? { activeDays: new Set([0, 1, 4, 6]), minuteOffset: 0 }
      : categoryName === "필드보스"
        ? { activeDays: new Set([0, 2, 5]), minuteOffset: 3 }
        : null;
  const isScheduledToday = schedule ? schedule.activeDays.has(getWeekdayFromDateKey(today)) : todayEntries.length > 0;
  const futureTimes = schedule && isScheduledToday ? getScheduledHourlyFutureTimes(nowMinutes, schedule.minuteOffset) : [];
  const nextTime = futureTimes[0] ?? null;
  const detail = firstEntry ? [firstEntry.ContentsName, firstEntry.Location].filter(Boolean).join(" · ") : null;
  return {
    available: isScheduledToday,
    detail,
    futureTimes,
    nextTime,
    remainingMinutes: minutesUntil(nextTime, nowMinutes)
  };
}

function getAdventureClaim(todayTimes: string[], hasNineRewardWindow: boolean): Pick<LostArkAdventureIslandEntry, "claimLabel" | "slotLabel"> {
  if (!hasNineRewardWindow) return { claimLabel: "일일 1회", slotLabel: "일일 보상" };
  const hasNineSlot = todayTimes.some((time) => toMinutes(time) < 19 * 60);
  return hasNineSlot ? { claimLabel: "1회차", slotLabel: "9시 보상" } : { claimLabel: "2회차", slotLabel: "저녁 보상" };
}

function getAdventureIslandSummary(
  contents: LostArkCalendarContent[],
  today: string,
  nowMinutes: number,
  rewardFilters: LostArkEventRewardFilter[]
): LostArkAdventureIslandSummary {
  const selectedRewards = new Set(rewardFilters.length > 0 ? rewardFilters : DEFAULT_REWARD_FILTERS);
  const islandContents = contents.filter((item) => item.CategoryName === "모험 섬");
  const hasNineRewardWindow = islandContents.some((item) => getTodayTimes(item.StartTimes, today).some((time) => time === "09:00"));
  const entries: LostArkAdventureIslandEntry[] = [];
  const endedRewardLabels = new Set<string>();

  for (const item of islandContents) {
    const islandName = item.ContentsName ?? "";
    if (!islandName) continue;
    const contentTimes = getTodayTimes(item.StartTimes, today);
    if (contentTimes.length === 0) continue;

    const rewardTimes = new Map<LostArkEventRewardFilter, Set<string>>();
    for (const group of item.RewardItems ?? []) {
      for (const reward of group.Items ?? []) {
        const rewardKey = classifyReward(reward.Name);
        if (!rewardKey || !selectedRewards.has(rewardKey)) continue;
        const times = getTodayTimes(reward.StartTimes ?? item.StartTimes, today);
        if (times.length === 0) continue;
        const current = rewardTimes.get(rewardKey) ?? new Set<string>();
        times.forEach((time) => current.add(time));
        rewardTimes.set(rewardKey, current);
      }
    }
    if (rewardTimes.size === 0) continue;

    const times = uniqueSortedTimes([...new Set([...rewardTimes.values()].flatMap((set) => [...set]))]);
    const futureTimes = getFutureTimes(times, nowMinutes);
    const claim = getAdventureClaim(times, hasNineRewardWindow);
    const rewardLabels = [...rewardTimes.keys()].map((key) => REWARD_LABELS[key]).sort((left, right) => left.localeCompare(right, "ko"));

    if (futureTimes.length === 0) {
      rewardLabels.forEach((label) => endedRewardLabels.add(`${claim.claimLabel} ${label}`));
      continue;
    }

    entries.push({
      ...claim,
      continent: ADVENTURE_ISLAND_CONTINENTS[islandName] ?? "가까운 대륙 확인 필요",
      futureTimes,
      islandName,
      rewards: rewardLabels
    });
  }

  entries.sort((left, right) => {
    const leftTime = left.futureTimes[0] ?? "99:99";
    const rightTime = right.futureTimes[0] ?? "99:99";
    return toOperationalMinutes(leftTime) - toOperationalMinutes(rightTime) || left.islandName.localeCompare(right.islandName, "ko");
  });

  const nextTime = entries.flatMap((entry) => entry.futureTimes).sort((left, right) => toOperationalMinutes(left) - toOperationalMinutes(right))[0] ?? null;
  return {
    entries,
    endedRewardLabels: [...endedRewardLabels],
    hasNineRewardWindow,
    nextTime,
    remainingMinutes: minutesUntil(nextTime, nowMinutes),
    rewardLabels: [...new Set(entries.flatMap((entry) => entry.rewards))],
    rule: hasNineRewardWindow ? "9/11/13 중 1회, 19/21/23 중 1회 획득 가능" : "11/13/19/21/23 전체에서 하루 1회 획득 가능"
  };
}

export function normalizeLostArkEventCalendar(
  contents: LostArkCalendarContent[],
  options: LostArkEventNormalizeOptions = {}
): LostArkEventCalendarSummary {
  const now = options.now ?? new Date();
  const { dateKey, minutes } = getKstParts(now);
  const rewardFilters = options.rewardFilters ?? DEFAULT_REWARD_FILTERS;
  return {
    adventureIsland: getAdventureIslandSummary(contents, dateKey, minutes, rewardFilters),
    chaosGate: getSimpleEventSummary(contents, "카오스게이트", dateKey, minutes),
    fieldBoss: getSimpleEventSummary(contents, "필드보스", dateKey, minutes),
    generatedAt: now.toISOString(),
    today: dateKey
  };
}

export async function fetchLostArkEventCalendarSummary(
  env: Env,
  options: LostArkEventNormalizeOptions = {}
): Promise<LostArkEventCalendarSummary> {
  if (!env.LOSTARK_API_KEY) {
    throw new ApiError(500, "lostark_key_missing", "Lost Ark API key is not configured");
  }

  const cached = await env.CACHE.get(CALENDAR_CACHE_KEY, "json");
  let raw: unknown = Array.isArray(cached) ? cached : null;
  if (!raw) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/gamecontents/calendar`, {
        headers: {
          accept: "application/json",
          authorization: `bearer ${env.LOSTARK_API_KEY}`
        }
      });
    } catch (error) {
      await writeCalendarStatus(env, {
        lastFailureAt: new Date().toISOString(),
        lastFailureCode: "lostark_fetch_failed"
      });
      throw error;
    }
    if (!response.ok) {
      await writeCalendarStatus(env, {
        lastFailureAt: new Date().toISOString(),
        lastFailureCode: "lostark_api_error"
      });
      throw new ApiError(response.status, "lostark_api_error", "Lost Ark API request failed");
    }
    raw = await readJsonOrNull(response);
    if (!Array.isArray(raw)) raw = [];
    await env.CACHE.put(CALENDAR_CACHE_KEY, JSON.stringify(raw), { expirationTtl: CALENDAR_CACHE_TTL_SECONDS });
    await writeCalendarStatus(env, { lastSuccessAt: new Date().toISOString() });
  }

  return normalizeLostArkEventCalendar(raw as LostArkCalendarContent[], options);
}

export function parseLostArkRewardFilters(value: string | null | undefined): LostArkEventRewardFilter[] {
  if (!value) return DEFAULT_REWARD_FILTERS;
  const allowed = new Set<LostArkEventRewardFilter>(["gold", "card", "coin", "silver", "cardXp"]);
  const filters = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is LostArkEventRewardFilter => allowed.has(item as LostArkEventRewardFilter));
  return filters.length > 0 ? [...new Set(filters)] : DEFAULT_REWARD_FILTERS;
}
