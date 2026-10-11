/**
 * Real summer days for the "try a summer day" mode, so the app can be tried
 * (and judged) in winter. For each of a few days from the past summer this
 * keeps the Ministry of the Environment's hourly WBGT estimates at the
 * points covering the 23 wards, and whether a heatstroke alert was in force.
 *
 *   npm run data:replay
 *
 * Picks the hottest day of July-August, a typical hot August day, and a
 * milder early-summer day; writes data/build/heat-replay.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseActual, parseAlert, POINTS, type Replay } from '../src/server/heat.ts';

const OUT = new URL('../data/build/', import.meta.url).pathname;
const BASE = 'https://www.wbgt.env.go.jp';
const JST = 9 * 3600_000;
const YEAR = Number(process.env.REPLAY_YEAR ?? new Date().getUTCFullYear());

async function text(url: string): Promise<string | null> {
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // point -> date -> 24 hourly values (hour h = the hour ending at h+1)
  const days = new Map<string, Map<string, number[]>>();
  for (const p of POINTS) {
    const byDate = new Map<string, number[]>();
    for (const month of ['06', '07', '08', '09']) {
      const csv = await text(`${BASE}/est15WG/dl/wbgt_${p.code}_${YEAR}${month}.csv`);
      if (!csv) continue;
      for (const [ms, v] of parseActual(csv)) {
        // Stamped at the end of the hour: 13:00 describes 12:00-13:00.
        const d = new Date(ms - 3600_000 + JST);
        const date = d.toISOString().slice(0, 10);
        const arr = byDate.get(date) ?? new Array(24).fill(NaN);
        arr[d.getUTCHours()] = v;
        byDate.set(date, arr);
      }
    }
    days.set(p.code, byDate);
  }
  const tokyo = days.get('44132')!;
  const peak = (date: string) => Math.max(...(tokyo.get(date) ?? []).filter(Number.isFinite));
  const complete = [...tokyo.keys()].filter((d) => (tokyo.get(d) ?? []).every(Number.isFinite));
  const summer = complete.filter((d) => d.slice(5, 7) === '07' || d.slice(5, 7) === '08').sort((a, b) => peak(b) - peak(a));
  const august = complete.filter((d) => d.slice(5, 7) === '08').sort((a, b) => peak(a) - peak(b));
  const june = complete.filter((d) => d.slice(5, 7) === '06').sort((a, b) => peak(b) - peak(a));
  const picks: { date: string; label: Replay['label'] }[] = [];
  if (summer[0]) picks.push({ date: summer[0], label: { ja: '夏でいちばん暑かった日', en: 'The hottest day of the summer' } });
  const typical = august[Math.floor(august.length / 2)];
  if (typical && typical !== summer[0]) picks.push({ date: typical, label: { ja: '8月のふつうの暑い日', en: 'A typical hot August day' } });
  if (june[0]) picks.push({ date: june[0], label: { ja: '梅雨の晴れ間の暑い日', en: 'A hot day early in the summer' } });

  const out: Replay[] = [];
  for (const pick of picks) {
    const hourly: Record<string, number[]> = {};
    for (const p of POINTS) {
      const v = days.get(p.code)?.get(pick.date);
      if (v) hourly[p.code] = v.map((x) => (Number.isFinite(x) ? x : null)) as number[];
    }
    // The 05:00 issue covers the day itself.
    const ymd = pick.date.replaceAll('-', '');
    const alertCsv = await text(`${BASE}/alert/dl/${pick.date.slice(0, 4)}/alert_${ymd}_05.csv`);
    const alert = alertCsv ? parseAlert(alertCsv)?.today ?? 'none' : 'none';
    out.push({ date: pick.date, label: pick.label, hourly, alert });
    console.log(`${pick.date} peak ${peak(pick.date)} alert ${alert} — ${pick.label.en}`);
  }
  writeFileSync(`${OUT}heat-replay.json`, JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
