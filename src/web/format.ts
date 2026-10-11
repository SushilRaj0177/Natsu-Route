import type { HeatLevel } from '../shared/api.ts';
import type { Lang } from './i18n.ts';

/** "13:05" from an ISO time with the Tokyo offset (or any instant, shown in Tokyo time). */
export function clock(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Minutes, rounded the way people say them: "30秒", "2分", "1時間5分". */
export function minutes(seconds: number, lang: Lang): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 50) return lang === 'ja' ? `${Math.max(10, Math.round(s / 10) * 10)}秒` : `${Math.max(10, Math.round(s / 10) * 10)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return lang === 'ja' ? `${m}分` : `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return lang === 'ja' ? `${h}時間${r ? `${r}分` : ''}` : `${h} h${r ? ` ${r} min` : ''}`;
}

export function metres(m: number, lang: Lang): string {
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)}m`;
  const km = (m / 1000).toFixed(1);
  return lang === 'ja' ? `${km}km` : `${km} km`;
}

export function yen(n: number, lang: Lang): string {
  return lang === 'ja' ? `${n.toLocaleString('ja-JP')}円` : `¥${n.toLocaleString('en-US')}`;
}

/**
 * Heat level colours, close to the ones the Ministry of the Environment and
 * Japanese weather services use, with text colours that keep contrast.
 */
export const LEVEL_COLOR: Record<HeatLevel, { bg: string; fg: string }> = {
  safe: { bg: '#2f7fd6', fg: '#ffffff' },
  caution: { bg: '#8ec8f0', fg: '#0d2235' },
  warning: { bg: '#f6d84c', fg: '#2c2400' },
  severe: { bg: '#f39a2c', fg: '#2b1600' },
  danger: { bg: '#d7262e', fg: '#ffffff' },
};

/** Tokyo date (YYYY-MM-DD) and minutes since midnight for an instant. */
export function tokyoParts(ms: number): { date: string; minute: number } {
  const d = new Date(ms + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** ISO instant for a Tokyo date and minute of day. */
export function tokyoInstant(date: string, minute: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 9 * 3600_000 + minute * 60_000).toISOString();
}

export function dateLabel(date: string, lang: Lang): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const ja = '日月火水木金土'[dow];
  const en = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
  return lang === 'ja' ? `${m}月${d}日（${ja}）` : `${en} ${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}
