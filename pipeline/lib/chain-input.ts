import { calendarOf, hhmm, local, type Calendar, type OdptRailway, type OdptStationTimetable } from './odpt.ts';
import type { ChainInput, Departure } from './chain.ts';
import { distance, type LatLon } from './geo.ts';

export interface ChainGroup {
  railway: string;
  calendar: Calendar;
  direction: string;
  input: ChainInput;
}

/** Departures before 03:00 belong to the previous service day. */
export const serviceMinutes = (t: number) => (t < 180 ? t + 1440 : t);

/**
 * Group station timetables by (railway, calendar, direction) and lay them out
 * along the railway's station order in travel direction.
 */
export function buildChainGroups(
  records: OdptStationTimetable[],
  railways: Map<string, OdptRailway>,
  coords: Map<string, LatLon>,
  opts: {
    withTruth?: boolean;
    /** Whether a station connects to a railway (ODPT odpt:connectingRailway). */
    connects?: (station: string, railway: string) => boolean;
  } = {},
): { groups: ChainGroup[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const buckets = new Map<string, OdptStationTimetable[]>();
  for (const r of records) {
    const cal = calendarOf(r['odpt:calendar']);
    if (!cal) {
      skip('special calendar');
      continue;
    }
    const key = `${local(r['odpt:railway'])}|${cal}|${local(r['odpt:railDirection'] ?? '')}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
  }

  const groups: ChainGroup[] = [];
  for (const [key, recs] of buckets) {
    const [railwayId, calendar, direction] = key.split('|');
    const rw = railways.get(railwayId);
    const so = rw?.['odpt:stationOrder'] ?? [];
    if (!rw || so.length < 2) {
      skip('no station order');
      continue;
    }
    let ordered = [...so].sort((a, b) => a['odpt:index'] - b['odpt:index']).map((s) => local(s['odpt:station']));
    const asc = local(rw['odpt:ascendingRailDirection'] ?? '');
    const desc = local(rw['odpt:descendingRailDirection'] ?? '');
    if (direction === desc) ordered = ordered.reverse();
    else if (direction !== asc) {
      skip('unknown direction');
      continue;
    }
    if (ordered[0] === ordered[ordered.length - 1]) {
      skip('loop line');
      continue;
    }
    const at = new Map(ordered.map((s, i) => [s, i]));
    const departures: Departure[][] = ordered.map(() => []);
    for (const r of recs) {
      const idx = at.get(local(r['odpt:station']));
      if (idx === undefined) {
        skip('station not in order');
        continue;
      }
      for (const e of r['odpt:stationTimetableObject']) {
        const t = hhmm(e['odpt:departureTime']);
        if (!Number.isFinite(t)) continue;
        departures[idx].push({
          time: serviceMinutes(t),
          type: local(e['odpt:trainType'] ?? 'unknown'),
          dest: (e['odpt:destinationStation'] ?? []).map(local).join(','),
          isOrigin: e['odpt:isOrigin'] === true,
          platform: e['odpt:platformNumber'],
          truth: opts.withTruth ? (e['odpt:trainNumber'] ?? e['odpt:train']) : undefined,
        });
      }
    }
    const hopMetres = ordered.slice(1).map((s, i) => {
      const a = coords.get(ordered[i]);
      const b = coords.get(s);
      return a && b ? distance(a, b) : 1500;
    });
    const connects = opts.connects;
    const exitsAt = connects
      ? (station: string, dest: string) => dest.split(',').some((d) => connects(station, d.split('.').slice(0, 2).join('.')))
      : undefined;
    groups.push({ railway: railwayId, calendar: calendar as Calendar, direction, input: { order: ordered, departures, hopMetres, exitsAt } });
  }
  return { groups, skipped };
}
