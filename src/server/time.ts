import type { DayType } from '../shared/api.ts';
import { DAY_HOLIDAY, DAY_SATURDAY, DAY_WEEKDAY } from '../shared/network.ts';

const JST_MS = 9 * 3600 * 1000;
/** Service days start at 03:00; a 00:30 departure belongs to the previous day's timetable. */
export const SERVICE_DAY_START_MIN = 180;

export interface ServiceTime {
  /** YYYY-MM-DD of the service day. */
  date: string;
  /** Minutes since 00:00 of the service date (>= 1440 after midnight). */
  minute: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Tokyo wall-clock parts for an instant. Japan has no daylight saving. */
export function tokyoParts(at: Date) {
  const d = new Date(at.getTime() + JST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export function serviceTime(at: Date): ServiceTime {
  const p = tokyoParts(at);
  if (p.min >= SERVICE_DAY_START_MIN) return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, minute: p.min };
  const prev = tokyoParts(new Date(at.getTime() - 86400000));
  return { date: `${prev.y}-${pad(prev.m)}-${pad(prev.d)}`, minute: p.min + 1440 };
}

/** Instant for a service date and minute. */
export function instantOf(date: string, minute: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - JST_MS + minute * 60000);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Which timetable runs on a date. Sundays and public holidays use the
 * holiday timetable; so do 30 Dec – 3 Jan, when Tokyo's railways run
 * holiday service.
 */
export function dayTypeOf(date: string, holidays: Set<string>): DayType {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const yearEnd = (m === 12 && d >= 30) || (m === 1 && d <= 3);
  if (dow === 0 || holidays.has(date) || yearEnd) return 'holiday';
  if (dow === 6) return 'saturday';
  return 'weekday';
}

export const DAY_BIT: Record<DayType, number> = { weekday: DAY_WEEKDAY, saturday: DAY_SATURDAY, holiday: DAY_HOLIDAY };
