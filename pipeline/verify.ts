/**
 * Cross-check the built network against a second, independent ODPT dataset.
 *
 * Operators publish per-train timetables (what the planner is built from)
 * and, separately, per-station departure boards (odpt:StationTimetable).
 * For every departure on every published board, this looks for a train in
 * the built network leaving that station at that minute on that calendar.
 * A low match rate means trains were lost or mangled while building.
 *
 *   npm run data:verify     (after data:build)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readArray } from './lib/read.ts';
import { calendarOf, hhmm, local, type OdptRailway, type OdptStation, type OdptStationTimetable } from './lib/odpt.ts';
import { CALENDAR_MASK } from './lib/trips.ts';
import { mergeRailways } from './lib/stations.ts';
import { measureRebuild } from './lib/measure.ts';
import type { LatLon } from './lib/geo.ts';
import type { NetworkData } from '../src/shared/network.ts';

/**
 * Operators whose station timetables carry train numbers, so the rebuild
 * method (used for Tokyu, Odakyu, Seibu, Keikyu, Yurikamome) can be scored
 * against the real trains. Linear private and suburban lines, like the ones
 * it is used on.
 */
const MEASURE_ON = ['Keio', 'Tobu', 'Sotetsu', 'MIR', 'TWR', 'YokohamaMunicipal'];

async function collect<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const r of readArray<T>(path)) out.push(r);
  return out;
}

const RAW = new URL('../data/raw/', import.meta.url).pathname;
const OUT = new URL('../data/build/', import.meta.url).pathname;

export interface VerifyResult {
  operator: string;
  source: 'published' | 'rebuilt';
  departures: number;
  matched: number;
}

async function main() {
  const net: NetworkData = JSON.parse(readFileSync(`${OUT}network.json`, 'utf8'));
  const stationIndex = new Map(net.stations.map((s, i) => [s.id, i]));
  const opOf = (i: number) => net.operators[net.railways[net.stations[i].railway].operator].id;
  const rebuiltOps = new Set(net.railways.filter((r) => r.timetable === 'rebuilt').map((r) => net.operators[r.operator].id));

  // (place, operator, minute) -> calendar bits of trains departing there then.
  const index = new Map<string, number>();
  for (const t of net.trips) {
    for (let i = 0; i < t.s.length; i++) {
      const s = t.s[i];
      const k = `${net.stations[s].place}|${opOf(s)}|${t.t[2 * i + 1]}`;
      index.set(k, (index.get(k) ?? 0) | t.cal);
    }
  }

  const results = new Map<string, VerifyResult>();
  const misses: string[] = [];
  const measureRecords: OdptStationTimetable[] = [];
  for (const ep of ['std', 'chal']) {
    for await (const r of readArray<OdptStationTimetable>(`${RAW}${ep}/StationTimetable.json`)) {
      const op = local(r['odpt:operator']);
      if (MEASURE_ON.includes(op)) measureRecords.push(r);
      const cal = calendarOf(r['odpt:calendar']);
      const st = stationIndex.get(local(r['odpt:station']));
      if (!cal || st === undefined) continue;
      const mask = CALENDAR_MASK[cal];
      const res = results.get(op) ?? { operator: op, source: rebuiltOps.has(op) ? 'rebuilt' : 'published', departures: 0, matched: 0 };
      results.set(op, res);
      for (const e of r['odpt:stationTimetableObject']) {
        let m = hhmm(e['odpt:departureTime']);
        if (!Number.isFinite(m)) continue;
        if (m < 180) m += 1440;
        res.departures++;
        const bits = index.get(`${net.stations[st].place}|${op}|${m}`) ?? 0;
        if (bits & mask) res.matched++;
        else if (misses.length < 40) misses.push(`${op} ${r['odpt:station']} ${cal} ${e['odpt:departureTime']} -> ${(e['odpt:destinationStation'] ?? []).join(',')}`);
      }
    }
  }
  const list = [...results.values()].sort((a, b) => b.departures - a.departures);
  let all = 0;
  let ok = 0;
  for (const r of list) {
    all += r.departures;
    ok += r.matched;
    console.log(`${r.operator.padEnd(18)} ${r.source.padEnd(9)} ${((100 * r.matched) / r.departures).toFixed(2).padStart(6)}% of ${r.departures}`);
  }
  console.log(`\nALL ${((100 * ok) / all).toFixed(2)}% of ${all} published station departures found in the network`);
  console.log('\nsample misses:\n  ' + misses.slice(0, 15).join('\n  '));

  // Score the train-rebuilding method where the real trains are known.
  const railways = mergeRailways([await collect<OdptRailway>(`${RAW}std/Railway.json`), await collect<OdptRailway>(`${RAW}chal/Railway.json`)]);
  const coords = new Map<string, LatLon>();
  for (const ep of ['std', 'chal']) {
    for (const st of await collect<OdptStation>(`${RAW}${ep}/Station.json`)) {
      if (st['geo:lat'] && st['geo:long']) coords.set(local(st['owl:sameAs']), { lat: st['geo:lat'], lon: st['geo:long'] });
    }
  }
  const scores = measureRebuild(measureRecords, railways, coords, MEASURE_ON);
  const rebuild = scores.reduce((a, x) => ({ links: a.links + x.links, correct: a.correct + x.correct }), { links: 0, correct: 0 });
  console.log(`\nrebuild method on known trains: ${((100 * rebuild.correct) / rebuild.links).toFixed(2)}% of ${rebuild.links} links correct`);

  writeFileSync(`${OUT}verify.json`, JSON.stringify({ checkedAt: new Date().toISOString(), operators: list, rebuild, rebuildScores: scores }, null, 2));
}

main();
