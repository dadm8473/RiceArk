import type { ResetRule } from "./types";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toKstShiftedDate(date: Date, resetHour: number): Date {
  return new Date(date.getTime() + KST_OFFSET_MS - resetHour * 60 * 60 * 1000);
}

function dateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfWeek(shiftedKst: Date, weekday: number): Date {
  const date = new Date(Date.UTC(shiftedKst.getUTCFullYear(), shiftedKst.getUTCMonth(), shiftedKst.getUTCDate()));
  const currentWeekday = date.getUTCDay();
  const diff = (currentWeekday - weekday + 7) % 7;
  return new Date(date.getTime() - diff * DAY_MS);
}

export function getPeriodKey(rule: ResetRule, now: Date = new Date()): string {
  if (rule.type === "none") {
    return "none:permanent";
  }

  const shifted = toKstShiftedDate(now, rule.hour);

  if (rule.type === "daily") {
    return `daily:${dateKey(shifted)}`;
  }

  if (rule.type === "weekly") {
    return `weekly:${dateKey(startOfWeek(shifted, rule.weekday))}`;
  }

  if (rule.type === "biweekly") {
    const weeklyStart = startOfWeek(shifted, rule.weekday);
    const anchor = parseDateKey(rule.anchorDate);
    const weeksSinceAnchor = Math.floor((weeklyStart.getTime() - anchor.getTime()) / (7 * DAY_MS));
    const evenWeekOffset = Math.floor(weeksSinceAnchor / 2) * 14 * DAY_MS;
    return `biweekly:${dateKey(new Date(anchor.getTime() + evenWeekOffset))}`;
  }

  const anchor = parseDateKey(rule.anchorDate);
  const daysSinceAnchor = Math.floor((shifted.getTime() - anchor.getTime()) / DAY_MS);
  const intervalStart = Math.floor(daysSinceAnchor / rule.intervalDays) * rule.intervalDays;
  return `custom:${dateKey(new Date(anchor.getTime() + intervalStart * DAY_MS))}`;
}
