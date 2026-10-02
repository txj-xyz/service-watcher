import type { MaintenanceWindow } from "./types.ts";

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localTime(now: Date, timezone?: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: WEEKDAYS[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function inWindow(w: MaintenanceWindow, now: Date): boolean {
  if (w.from !== undefined && w.until !== undefined) {
    const t = now.getTime();
    return t >= w.from && t < w.until;
  }
  if (w.start === undefined || w.end === undefined) return false;
  const { day, minutes } = localTime(now, w.timezone);
  const dayOk = (d: number) => w.days.length === 0 || w.days.includes(d);
  if (w.start <= w.end) return dayOk(day) && minutes >= w.start && minutes < w.end;
  // Window wraps past midnight, e.g. 23:00-02:00: the early part belongs to the previous day.
  return (dayOk(day) && minutes >= w.start) || (dayOk((day + 6) % 7) && minutes < w.end);
}

export function inMaintenance(windows: MaintenanceWindow[], now = new Date()): boolean {
  return windows.some((w) => inWindow(w, now));
}
