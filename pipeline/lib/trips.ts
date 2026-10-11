import { calendarOf, hhmm, local, type OdptTrainTimetable } from './odpt.ts';
import { distance, type LatLon } from './geo.ts';
import type { ChainedTrain } from './chain.ts';
import { DAY_HOLIDAY, DAY_SATURDAY, DAY_WEEKDAY } from '../../src/shared/network.ts';

export interface DraftStop {
  station: string;
  arr: number;
  dep: number;
  platform?: string;
  /** Arrival time is estimated, not published. */
  est?: boolean;
  /** Train type shown when leaving this stop (through trains change type at the boundary). */
  type?: string;
  /** Stop comes from a rebuilt (station-timetable) record. */
  rebuilt?: boolean;
}

export interface DraftTrip {
  key: string;
  calendar: number;
  type: string;
  numbers: string[];
  dest: string[];
  stops: DraftStop[];
  src: 0 | 1;
  next?: string[];
  prev?: string[];
}

/** One shared string per station id: a million stop records otherwise each hold a copy. */
const interned = new Map<string, string>();
export function intern(s: string): string {
  let v = interned.get(s);
  if (v === undefined) interned.set(s, (v = s));
  return v;
}

export const CALENDAR_MASK: Record<string, number> = {
  Weekday: DAY_WEEKDAY,
  Saturday: DAY_SATURDAY,
  Holiday: DAY_HOLIDAY,
  SaturdayHoliday: DAY_SATURDAY | DAY_HOLIDAY,
};

/**
 * Make times non-decreasing across midnight. Trips starting before 03:00
 * belong to the previous service day. Pass-through points (NaN) are skipped.
 */
export function normaliseTimes(stops: DraftStop[]): void {
  const firstTimed = stops.find((s) => Number.isFinite(s.dep));
  if (!firstTimed) return;
  let offset = firstTimed.dep < 180 ? 1440 : 0;
  let last = -Infinity;
  for (const s of stops) {
    for (const k of ['arr', 'dep'] as const) {
      if (!Number.isFinite(s[k])) continue;
      let v = s[k] + offset;
      while (v < last - 60) {
        offset += 1440;
        v += 1440;
      }
      s[k] = v;
      last = Math.max(last, v);
    }
  }
}

/**
 * ODPT lists stations an express passes without stopping, with no times
 * (the Narita Express's Chiba–Sakura–Narita segments are nothing else).
 * They are kept as NaN-timed points until records are linked, so a chain of
 * segments stays intact, then removed.
 */
export function fromTrainTimetable(r: OdptTrainTimetable): DraftTrip | null {
  const cal = calendarOf(r['odpt:calendar']);
  if (!cal) return null;
  const stops: DraftStop[] = [];
  for (const o of r['odpt:trainTimetableObject']) {
    const station = o['odpt:departureStation'] ?? o['odpt:arrivalStation'];
    if (!station) continue;
    const arr = hhmm(o['odpt:arrivalTime'] ?? o['odpt:departureTime']);
    const dep = hhmm(o['odpt:departureTime'] ?? o['odpt:arrivalTime']);
    stops.push({ station: intern(local(station)), arr, dep, platform: o['odpt:platformNumber'], type: intern(local(r['odpt:trainType'] ?? 'unknown')) });
  }
  if (!stops.length) return null;
  normaliseTimes(stops);
  return {
    key: local(r['owl:sameAs']),
    calendar: CALENDAR_MASK[cal],
    type: local(r['odpt:trainType'] ?? 'unknown'),
    numbers: [r['odpt:trainNumber']],
    dest: (r['odpt:destinationStation'] ?? []).map(local),
    stops,
    src: 0,
    next: r['odpt:nextTrainTimetable']?.map(local),
    prev: r['odpt:previousTrainTimetable']?.map(local),
  };
}

/** Drop pass-through points; null when fewer than two real stops remain. */
export function withoutPassPoints(t: DraftTrip): DraftTrip | null {
  const stops = t.stops.filter((s) => Number.isFinite(s.arr) && Number.isFinite(s.dep));
  return stops.length >= 2 ? { ...t, stops } : null;
}

export function fromChained(t: ChainedTrain, key: string, calendar: string): DraftTrip | null {
  if (t.stops.length < 2) return null;
  return {
    key,
    calendar: CALENDAR_MASK[calendar],
    type: t.type,
    numbers: [],
    dest: t.dest ? t.dest.split(',') : [],
    stops: t.stops.map((s) => ({ station: intern(s.station), arr: s.time, dep: s.time, platform: s.platform, est: s.estimated, type: intern(s.type ?? t.type), rebuilt: true })),
    src: 1,
  };
}

const norm = (s: string) => s.replace(/[（(〈][^）)〉]*[）)〉]/g, '').replace(/ヶ/g, 'ケ').trim();
function sameName(a: string, b: string) {
  return norm(a) === norm(b);
}

const lastTime = (t: DraftTrip) => {
  for (let i = t.stops.length - 1; i >= 0; i--) if (Number.isFinite(t.stops[i].arr)) return t.stops[i].arr;
  return NaN;
};
const firstTime = (t: DraftTrip) => t.stops.find((s) => Number.isFinite(s.dep))?.dep ?? NaN;
const either = (a: number, b: number) => (Number.isFinite(a) ? a : b);

/** Join B onto the end of A. Returns null if the times do not line up. */
export function mergeTrips(a: DraftTrip, b: DraftTrip, nameOf: (id: string) => string): DraftTrip | null {
  const last = a.stops[a.stops.length - 1];
  const first = b.stops[0];
  if (firstTime(b) < lastTime(a)) return null;
  let stops: DraftStop[];
  if (sameName(nameOf(last.station), nameOf(first.station))) {
    // One physical stop: arrive on A's line, leave on B's.
    const junction: DraftStop = {
      station: first.station,
      arr: either(last.arr, first.arr),
      dep: either(first.dep, last.dep),
      platform: first.platform ?? last.platform,
      est: last.est,
      type: first.type,
      rebuilt: first.rebuilt,
    };
    stops = [...a.stops.slice(0, -1), junction, ...b.stops.slice(1)];
  } else {
    stops = [...a.stops, ...b.stops];
  }
  return {
    key: `${a.key}+${b.key}`,
    calendar: a.calendar & b.calendar,
    type: a.type,
    numbers: [...new Set([...a.numbers, ...b.numbers])],
    dest: b.dest,
    stops,
    src: (a.src || b.src) as 0 | 1,
    next: b.next,
    prev: a.prev,
  };
}

/** Follow chains of A -> B links (each trip at most one successor and one predecessor) and merge them. */
function applyLinks(trips: DraftTrip[], links: Map<DraftTrip, DraftTrip>, nameOf: (id: string) => string) {
  const succ = new Map<DraftTrip, DraftTrip[]>();
  for (const [a, b] of links) succ.set(a, [b]);
  return applyGraph(trips, succ, nameOf);
}

/**
 * Merge along every path of a link graph. A trip with two successors (the
 * train divides) or two predecessors (two trains couple, like the Narita
 * Express halves from Shinjuku and Ofuna at Tokyo) yields one merged trip per
 * path, so a rider in either half has a single-seat journey.
 */
function applyGraph(trips: DraftTrip[], succ: Map<DraftTrip, DraftTrip[]>, nameOf: (id: string) => string) {
  const hasPred = new Set([...succ.values()].flat());
  const out: DraftTrip[] = [];
  let merged = 0;
  const walk = (cur: DraftTrip, node: DraftTrip, seen: Set<DraftTrip>) => {
    const next = (succ.get(node) ?? []).filter((n) => !seen.has(n));
    if (!next.length) {
      out.push(cur);
      return;
    }
    for (const n of next) {
      const m = mergeTrips(cur, n, nameOf);
      if (m) {
        merged++;
        walk(m, n, new Set([...seen, n]));
      } else {
        // Times disagree: keep both halves as separate trains.
        out.push(cur);
        walk(n, n, new Set([...seen, n]));
      }
    }
  };
  for (const t of trips) if (!hasPred.has(t)) walk(t, t, new Set([t]));
  return { trips: out, merged };
}

/** Merge trains the operator itself links with next/previousTrainTimetable. */
export function linkPublished(trips: DraftTrip[], nameOf: (id: string) => string) {
  const byKey = new Map(trips.map((t) => [t.key, t]));
  const succ = new Map<DraftTrip, DraftTrip[]>();
  for (const t of trips) {
    for (const nk of t.next ?? []) {
      const n = byKey.get(nk);
      if (!n || !n.prev?.includes(t.key) || (n.calendar & t.calendar) === 0) continue;
      (succ.get(t) ?? succ.set(t, []).get(t)!).push(n);
    }
  }
  return applyGraph(trips, succ, nameOf);
}

/**
 * Through services between operators are not linked in ODPT: a Fukutoshin
 * Line train's record stops at Shibuya, and the Tokyu part of the same train
 * is a separate record. Join A -> B when:
 *   - A ends short of its announced destination,
 *   - both announce the same destination,
 *   - B leaves 0–12 min after A's last time, from a station a train could
 *     reach in that time (at most 1 km per minute, 8 km),
 *   - and the two physically meet: the same station, or A's line runs on
 *     to B's first station, or B's line runs back to A's last.
 * B's own record is not required to say it came from elsewhere: Tokyo Metro
 * lists trains arriving from Odakyu as starting at Yoyogi-Uehara.
 */
export function linkInferred(
  trips: DraftTrip[],
  nameOf: (id: string) => string,
  coordOf: (id: string) => LatLon | undefined,
  railwayOf: (id: string) => string,
  /** Station names of a railway in published order. */
  railwayNames: (railway: string) => string[],
  /** Trains that may plausibly be one train (an express never turns into a local). */
  compatible: (a: DraftTrip, b: DraftTrip) => boolean,
) {
  // The same terminus has a different ODPT id on each operator's records
  // (JR Abiko is "JR-East.Joban.Abiko" in one, "JR-East.JobanLocal.Abiko" in
  // another), and many termini (Keisei's) have no station record to take a
  // name from. The id's last segment is the stable part.
  const tail = (id: string) => id.slice(id.lastIndexOf('.') + 1).toLowerCase();
  const openEnd = (t: DraftTrip) => {
    const last = t.stops[t.stops.length - 1].station;
    return t.dest.length > 0 && !t.dest.some((d) => tail(d) === tail(last) || sameName(nameOf(d), nameOf(last)));
  };
  const destKey = (t: DraftTrip) => t.dest.map(tail).sort().join(',');
  /**
   * Station names beyond the end of a trip on its own railway: ahead of its
   * last stop (towards = true) or behind its first stop (towards = false).
   */
  const beyond = (t: DraftTrip, towards: boolean): Set<string> => {
    const n = t.stops.length;
    if (n < 2) return new Set();
    const [edge, inner] = towards ? [t.stops[n - 1], t.stops[n - 2]] : [t.stops[0], t.stops[1]];
    const order = railwayNames(railwayOf(edge.station)).map(norm);
    const i = order.indexOf(norm(nameOf(edge.station)));
    const j = order.indexOf(norm(nameOf(inner.station)));
    if (i < 0 || j < 0 || i === j) return new Set();
    return new Set(i > j ? order.slice(i + 1) : order.slice(0, i));
  };
  /** A and B physically meet: same station, or one's line runs on to the other's station. */
  const contiguous = (a: DraftTrip, b: DraftTrip): boolean => {
    const last = norm(nameOf(a.stops[a.stops.length - 1].station));
    const first = norm(nameOf(b.stops[0].station));
    return last === first || beyond(a, true).has(first) || beyond(b, false).has(last);
  };
  const starts = new Map<string, DraftTrip[]>();
  for (const t of trips) {
    if (!t.dest.length) continue;
    const k = destKey(t);
    (starts.get(k) ?? starts.set(k, []).get(k)!).push(t);
  }
  const pairs: { a: DraftTrip; b: DraftTrip; score: number }[] = [];
  for (const a of trips) {
    if (!openEnd(a)) continue;
    const last = a.stops[a.stops.length - 1];
    const la = coordOf(last.station);
    for (const b of starts.get(destKey(a)) ?? []) {
      if (b === a || (a.calendar & b.calendar) === 0) continue;
      const first = b.stops[0];
      if (railwayOf(first.station) === railwayOf(last.station)) continue;
      const gap = first.dep - last.arr;
      if (gap < 0 || gap > 12) continue;
      const lb = coordOf(first.station);
      const d = la && lb ? distance(la, lb) : Infinity;
      // The gap must be coverable by train: at most 1 km a minute, 8 km.
      if (d > 8000 || (d > 400 && gap < Math.ceil(d / 1000))) continue;
      if (!contiguous(a, b) || !compatible(a, b)) continue;
      pairs.push({ a, b, score: gap * 1000 + d });
    }
  }
  pairs.sort((x, y) => x.score - y.score);
  const links = new Map<DraftTrip, DraftTrip>();
  const taken = new Set<DraftTrip>();
  const byRailway = new Map<string, number>();
  for (const p of pairs) {
    if (links.has(p.a) || taken.has(p.b)) continue;
    links.set(p.a, p.b);
    taken.add(p.b);
    const k = `${railwayOf(p.a.stops[p.a.stops.length - 1].station)} > ${railwayOf(p.b.stops[0].station)}`;
    byRailway.set(k, (byRailway.get(k) ?? 0) + 1);
  }
  return { ...applyLinks(trips, links, nameOf), byRailway };
}

export function validTimes(t: DraftTrip): boolean {
  let last = -Infinity;
  for (const s of t.stops) {
    if (s.arr < last || s.dep < s.arr) return false;
    last = s.dep;
  }
  return t.stops[t.stops.length - 1].arr > t.stops[0].dep;
}
