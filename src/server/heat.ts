/**
 * Heat stress (WBGT, 暑さ指数) from the Ministry of the Environment's
 * Heat Illness Prevention Information service (環境省熱中症予防情報サイト):
 *
 * - forecasts every 3 hours for today and the next two days,
 * - hourly estimates of what it actually was (実況推定値),
 * - heatstroke alerts (熱中症警戒アラート / 特別警戒アラート) per prefecture.
 *
 * The service runs from late April to late October; outside that season
 * there are no values and the app says so instead of guessing.
 */
import { existsSync, readFileSync } from 'node:fs';

const BASE = 'https://www.wbgt.env.go.jp';

/** Observation points that cover the 23 wards. */
export const POINTS = [
  { code: '44132', name: { ja: '東京', en: 'Tokyo' }, lat: 35 + 41.5 / 60, lon: 139 + 45.0 / 60 },
  { code: '44071', name: { ja: '練馬', en: 'Nerima' }, lat: 35 + 44.3 / 60, lon: 139 + 35.5 / 60 },
  { code: '44136', name: { ja: '江戸川臨海', en: 'Edogawa-rinkai' }, lat: 35 + 38.3 / 60, lon: 139 + 51.8 / 60 },
  { code: '44116', name: { ja: '府中', en: 'Fuchu' }, lat: 35 + 41.0 / 60, lon: 139 + 29.0 / 60 },
] as const;
export type PointCode = (typeof POINTS)[number]['code'];

/**
 * Guideline levels for daily life (日常生活における熱中症予防指針,
 * Japanese Society of Biometeorology), as the Ministry presents them.
 */
export type HeatLevel = 'safe' | 'caution' | 'warning' | 'severe' | 'danger';
export function levelOf(wbgt: number): HeatLevel {
  if (wbgt >= 31) return 'danger';
  if (wbgt >= 28) return 'severe';
  if (wbgt >= 25) return 'warning';
  if (wbgt >= 21) return 'caution';
  return 'safe';
}

/** How strongly a walk avoids sun at each level: seconds of detour per second of sun avoided. */
export const SUN_WEIGHT: Record<HeatLevel, number> = { safe: 0.3, caution: 0.8, warning: 1.5, severe: 2.5, danger: 4 };

export type AlertLevel = 'none' | 'alert' | 'special';

export interface HeatAt {
  wbgt: number;
  level: HeatLevel;
  /** 'actual' = the Ministry's hourly estimate; 'forecast' = 3-hourly forecast, interpolated. */
  kind: 'actual' | 'forecast' | 'replay';
  point: PointCode;
}

interface Series {
  /** ms (UTC) -> WBGT */
  values: Map<number, number>;
  fetchedAt: number;
}

const JST = 9 * 3600_000;

/** "2026101215" (JST, hour 24 allowed) -> epoch ms */
function parseYmdh(s: string): number {
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8), h = +s.slice(8, 10);
  return Date.UTC(y, m - 1, d, h) - JST;
}

/** "2026/8/1", "13:00" (JST, hour 24 allowed) -> epoch ms */
function parseDateTime(date: string, time: string): number {
  const [y, m, d] = date.split('/').map(Number);
  const [h] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h) - JST;
}

export function parseForecast(csv: string): Map<number, number> {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',').slice(2);
  const row = lines[1]?.split(',').slice(2) ?? [];
  const out = new Map<number, number>();
  head.forEach((h, i) => {
    const v = Number(row[i]);
    if (h.trim() && Number.isFinite(v) && v > 0) out.set(parseYmdh(h.trim()), v / 10);
  });
  return out;
}

export function parseActual(csv: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, time, value] = line.split(',');
    const v = Number(value);
    if (date && time && value?.trim() && Number.isFinite(v)) out.set(parseDateTime(date, time), v);
  }
  return out;
}

/** Tokyo's flags from an alert file: [today, tomorrow]. */
export function parseAlert(csv: string): { date: string; today: AlertLevel; tomorrow: AlertLevel; maxima: Record<string, number> } | null {
  const lines = csv.split(/\r?\n/);
  const get = (k: string) => lines.find((l) => l.startsWith(`${k},`))?.split(',')[1] ?? '';
  const tokyo = lines.find((l) => l.startsWith('東京都,'));
  if (!tokyo) return null;
  const cols = tokyo.split(',');
  // 1 = alert issued, 2 = special alert criteria met (alert stands), 3 = special alert issued, 9 = out of hours.
  const flag = (v: string): AlertLevel => (v === '3' ? 'special' : v === '1' || v === '2' ? 'alert' : 'none');
  const maxima: Record<string, number> = {};
  for (const part of (cols[8] ?? '').split('/')) {
    const [name, v] = part.split(':');
    if (name && v) maxima[name] = Number(v);
  }
  return { date: get('TargetDate1').replaceAll('/', '-'), today: flag(cols[6]), tomorrow: flag(cols[7]), maxima };
}

export function nearestPoint(lat: number, lon: number): PointCode {
  let best: PointCode = '44132';
  let bd = Infinity;
  for (const p of POINTS) {
    const d = (p.lat - lat) ** 2 + ((p.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bd) {
      bd = d;
      best = p.code;
    }
  }
  return best;
}

export interface Replay {
  /** The summer day whose real heat and sun the replay uses (YYYY-MM-DD). */
  date: string;
  label: { ja: string; en: string };
  /** point -> hour (0-23) -> WBGT */
  hourly: Record<string, number[]>;
  alert: AlertLevel;
}

/**
 * Keeps forecasts, today's actual values and alerts fresh. Values are
 * fetched lazily and cached: forecasts for an hour, actuals for 20 minutes.
 */
export class HeatService {
  private forecast = new Map<string, Series>();
  private actual = new Map<string, Series>();
  private alert: { fetchedAt: number; value: ReturnType<typeof parseAlert> } | null = null;
  readonly replays: Replay[] = [];

  constructor(replayPath?: string, private fetcher: typeof fetch = fetch) {
    if (replayPath && existsSync(replayPath)) this.replays = JSON.parse(readFileSync(replayPath, 'utf8')) as Replay[];
  }

  /** WBGT season: the Ministry publishes from late April to late October. */
  static inSeason(ms: number): boolean {
    const d = new Date(ms + JST);
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    return md >= 420 && md <= 1025;
  }

  async at(ms: number, point: PointCode): Promise<HeatAt | null> {
    if (!HeatService.inSeason(ms)) return null;
    const hour = Math.floor(ms / 3600_000) * 3600_000;
    // The past and the current hour: the hourly estimate, if published yet.
    if (ms <= Date.now()) {
      const a = await this.series(this.actual, point, 'actual', ms);
      // Values are stamped at the end of the hour they describe.
      const v = a?.get(hour + 3600_000) ?? a?.get(hour);
      if (v !== undefined) return { wbgt: v, level: levelOf(v), kind: 'actual', point };
    }
    const f = await this.series(this.forecast, point, 'forecast', ms);
    if (!f || f.size === 0) return null;
    const keys = [...f.keys()].sort((a, b) => a - b);
    if (ms <= keys[0]) return mk(f.get(keys[0])!, point);
    for (let i = 1; i < keys.length; i++) {
      if (ms <= keys[i]) {
        const t = (ms - keys[i - 1]) / (keys[i] - keys[i - 1]);
        return mk(f.get(keys[i - 1])! * (1 - t) + f.get(keys[i])! * t, point);
      }
    }
    return null;
  }

  replayAt(replay: Replay, ms: number, point: PointCode): HeatAt | null {
    const h = new Date(ms + JST).getUTCHours();
    const v = replay.hourly[point]?.[h] ?? replay.hourly['44132']?.[h];
    return v === undefined ? null : { wbgt: v, level: levelOf(v), kind: 'replay', point };
  }

  /** Today's and tomorrow's heatstroke alerts for Tokyo. */
  async alerts(now = Date.now()): Promise<{ today: AlertLevel; tomorrow: AlertLevel; issuedFor: string } | null> {
    if (!HeatService.inSeason(now)) return null;
    if (this.alert && now - this.alert.fetchedAt < 30 * 60_000) return this.alert.value && { today: this.alert.value.today, tomorrow: this.alert.value.tomorrow, issuedFor: this.alert.value.date };
    // Alerts are issued at 17:00 (for tomorrow) and 05:00 (for today), JST.
    const d = new Date(now + JST);
    const tries: string[] = [];
    for (let back = 0; back < 3; back++) {
      const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
      const ymd = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
      tries.push(`${BASE}/alert/dl/${day.getUTCFullYear()}/alert_${ymd}_17.csv`, `${BASE}/alert/dl/${day.getUTCFullYear()}/alert_${ymd}_05.csv`);
    }
    const hourNow = d.getUTCHours();
    const ordered = hourNow < 5 ? tries.slice(2) : hourNow < 17 ? [tries[1], ...tries.slice(2)] : tries;
    for (const url of ordered) {
      try {
        const res = await this.fetcher(url);
        if (!res.ok) continue;
        const value = parseAlert(await res.text());
        if (!value) continue;
        this.alert = { fetchedAt: now, value };
        return { today: value.today, tomorrow: value.tomorrow, issuedFor: value.date };
      } catch {
        /* try the next one */
      }
    }
    this.alert = { fetchedAt: now, value: null };
    return null;
  }

  private async series(cache: Map<string, Series>, point: string, kind: 'actual' | 'forecast', ms: number): Promise<Map<number, number> | null> {
    const d = new Date(ms + JST);
    const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = kind === 'actual' ? `${point}|${ym}` : point;
    const ttl = kind === 'actual' ? 20 * 60_000 : 60 * 60_000;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttl) return hit.values;
    const url = kind === 'actual' ? `${BASE}/est15WG/dl/wbgt_${point}_${ym}.csv` : `${BASE}/prev15WG/dl/yohou_${point}.csv`;
    try {
      const res = await this.fetcher(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const values = kind === 'actual' ? parseActual(text) : parseForecast(text);
      cache.set(key, { values, fetchedAt: Date.now() });
      return values;
    } catch {
      return hit?.values ?? null;
    }
  }
}

function mk(v: number, point: PointCode): HeatAt {
  const r = Math.round(v * 10) / 10;
  return { wbgt: r, level: levelOf(r), kind: 'forecast', point };
}
