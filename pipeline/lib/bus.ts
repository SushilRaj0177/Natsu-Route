/**
 * Route buses from ODPT: Toei Bus (standard API), Kokusai Kogyo Bus
 * (Challenge 2026), Tokyu Bus and Seibu Bus. Older riders lean on buses:
 * fewer stairs than the subway, stops close to home, and free with the Tokyo
 * Silver Pass.
 *
 * Bus timetables use date-specific calendars ("this trip runs on these
 * dates") rather than the weekday/Saturday/holiday types trains use, so each
 * trip keeps both: the day types it belongs to (for dates outside the
 * calendar's published range) and the exact date list.
 */
import { readArray } from './read.ts';
import { hhmm, local, type Multilingual } from './odpt.ts';
import { DAY_HOLIDAY, DAY_SATURDAY, DAY_WEEKDAY, type Names } from '../../src/shared/network.ts';

/** Operators whose buses run in the 23 wards, and whether the Silver Pass covers them. */
export const BUS_OPERATORS: Record<string, { silver: boolean; color: string; name: Names }> = {
  Toei: { silver: true, color: '#2E8B57', name: { ja: '都営バス', en: 'Toei Bus' } },
  KokusaiKogyoBus: { silver: true, color: '#C8102E', name: { ja: '国際興業バス', en: 'Kokusai Kogyo Bus' } },
  TokyuBus: { silver: true, color: '#E4007F', name: { ja: '東急バス', en: 'Tokyu Bus' } },
  SeibuBus: { silver: true, color: '#1D50A2', name: { ja: '西武バス', en: 'Seibu Bus' } },
};

/** The 23 wards plus a margin: routes must call at least once inside it. */
const BBOX = { minLon: 139.53, minLat: 35.5, maxLon: 139.95, maxLat: 35.85 };
/** Tokyo Metropolis, roughly: the Silver Pass is valid on buses within Tokyo. */
const inTokyo = (lat: number, lon: number) => lat > 35.52 && lat < 35.9 && lon > 139.0 && lon < 139.92;

export interface BusCalendar {
  id: string;
  /** Dates (YYYY-MM-DD) the calendar lists, sorted. */
  dates: string[];
  /** Range over which `dates` is authoritative. */
  from: string;
  to: string;
  /** Day types to fall back on outside that range (0: only the listed dates). */
  dayBits: number;
}

export interface BusPole {
  id: string;
  name: Names;
  kana?: string;
  number?: string;
  lat: number;
  lon: number;
  operator: string;
}

export interface BusRoute {
  id: string;
  operator: string;
  /** Route name as signed, e.g. "渋66". */
  name: string;
}

export interface BusPattern {
  id: string;
  route: number;
  poles: string[];
  /** Route line as [lat, lon] pairs, when ODPT has it. */
  line?: [number, number][];
}

export interface BusTrip {
  /** ODPT BusTimetable id, which live bus positions refer to. */
  id: string;
  pattern: number;
  operator: string;
  dayBits: number;
  calendar: number;
  stops: { pole: string; arr: number; dep: number }[];
  dest: string;
  nonStep: boolean;
}

export interface BusData {
  calendars: BusCalendar[];
  poles: Map<string, BusPole>;
  routes: BusRoute[];
  patterns: BusPattern[];
  trips: BusTrip[];
  /** Each operator's usual fare; `pairFares` holds the stop pairs that cost something else. */
  flatFare: Record<string, { ic: number; ticket: number } | null>;
  pairFares: Map<string, [number, number]>;
}

interface OdptCalendar {
  'owl:sameAs': string;
  'dc:title'?: string;
  'odpt:day'?: string[];
  'odpt:duration'?: string;
}

interface OdptPole {
  'owl:sameAs': string;
  'dc:title'?: string;
  title?: Multilingual;
  'odpt:kana'?: string;
  'geo:lat'?: number;
  'geo:long'?: number;
  'odpt:operator': string | string[];
  'odpt:busstopPoleNumber'?: string;
}

interface OdptPattern {
  'owl:sameAs': string;
  'dc:title'?: string;
  'odpt:busroute'?: string;
  'odpt:operator': string;
  'odpt:busstopPoleOrder': { 'odpt:index': number; 'odpt:busstopPole': string }[];
  'ug:region'?: { type: string; coordinates: [number, number][] } | null;
}

interface OdptBusTimetable {
  'owl:sameAs': string;
  'odpt:operator': string;
  'odpt:calendar': string;
  'odpt:busroutePattern': string;
  'odpt:busTimetableObject': {
    'odpt:index': number;
    'odpt:busstopPole': string;
    'odpt:arrivalTime'?: string | null;
    'odpt:departureTime'?: string | null;
    'odpt:destinationSign'?: string | null;
    'odpt:isNonStepBus'?: boolean | null;
    'odpt:isMidnight'?: boolean | null;
    'odpt:canGetOn'?: boolean | null;
  }[];
}

interface OdptBusFare {
  'odpt:operator': string;
  'odpt:fromBusstopPole': string;
  'odpt:toBusstopPole': string;
  'odpt:icCardFare': number;
  'odpt:ticketFare': number;
}

const opOf = (x: string | string[]) => local([x].flat()[0] ?? '');

/** Route names come with full-width digits ("渋６６"); signs use half-width. */
export const routeName = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

function dayBitsOfTitle(title: string | undefined, id: string): number {
  const t = title ?? '';
  const l = local(id);
  if (t === '平日' || l === 'Weekday') return DAY_WEEKDAY;
  if (t === '土曜' || l === 'Saturday') return DAY_SATURDAY;
  if (t === '休日' || t === '日曜' || l === 'Holiday' || l === 'Sunday') return DAY_HOLIDAY;
  if (t === '土休日' || l === 'SaturdayHoliday') return DAY_SATURDAY | DAY_HOLIDAY;
  if (l === 'Everyday') return DAY_WEEKDAY | DAY_SATURDAY | DAY_HOLIDAY;
  if (/\.Weekday$/.test(l)) return DAY_WEEKDAY;
  if (/\.Saturday$/.test(l)) return DAY_SATURDAY;
  if (/\.Holiday$/.test(l)) return DAY_HOLIDAY;
  return 0;
}

export async function loadBus(raw: string, endpoints: ('std' | 'chal')[]): Promise<BusData> {
  const read = async function* <T>(name: string) {
    for (const ep of endpoints) yield* readArray<T>(`${raw}${ep}/${name}.json`);
  };

  // Calendars.
  const calendars: BusCalendar[] = [];
  const calIndex = new Map<string, number>();
  for await (const c of read<OdptCalendar>('Calendar')) {
    const id = local(c['owl:sameAs']);
    if (calIndex.has(id)) continue;
    const [from, to] = (c['odpt:duration'] ?? '/').split('/');
    const dates = [...(c['odpt:day'] ?? [])].sort();
    calIndex.set(id, calendars.length);
    calendars.push({ id, dates, from: from || dates[0] || '', to: to || dates.at(-1) || '', dayBits: dayBitsOfTitle(c['dc:title'], c['owl:sameAs']) });
  }
  const calendarFor = (id: string): number => {
    const l = local(id);
    let i = calIndex.get(l);
    if (i === undefined) {
      i = calendars.length;
      calIndex.set(l, i);
      calendars.push({ id: l, dates: [], from: '', to: '', dayBits: dayBitsOfTitle(undefined, id) });
    }
    return i;
  };

  // Poles.
  const poles = new Map<string, BusPole>();
  for await (const p of read<OdptPole>('BusstopPole')) {
    const op = opOf(p['odpt:operator']);
    if (!BUS_OPERATORS[op] || p['geo:lat'] === undefined || p['geo:long'] === undefined) continue;
    const ja = p.title?.ja ?? p['dc:title'] ?? '';
    poles.set(local(p['owl:sameAs']), {
      id: local(p['owl:sameAs']),
      name: { ja, en: p.title?.en ?? '' },
      kana: p.title?.['ja-Hrkt'] ?? p['odpt:kana'],
      number: p['odpt:busstopPoleNumber'],
      lat: p['geo:lat'],
      lon: p['geo:long'],
      operator: op,
    });
  }

  // Patterns that call inside the area.
  const routes: BusRoute[] = [];
  const routeIndex = new Map<string, number>();
  const patterns: BusPattern[] = [];
  const patternIndex = new Map<string, number>();
  for await (const p of read<OdptPattern>('BusroutePattern')) {
    const op = local(p['odpt:operator']);
    if (!BUS_OPERATORS[op]) continue;
    const order = [...p['odpt:busstopPoleOrder']].sort((a, b) => a['odpt:index'] - b['odpt:index']).map((o) => local(o['odpt:busstopPole']));
    const known = order.filter((id) => poles.has(id));
    if (known.length < 2) continue;
    const inside = known.some((id) => {
      const q = poles.get(id)!;
      return q.lat > BBOX.minLat && q.lat < BBOX.maxLat && q.lon > BBOX.minLon && q.lon < BBOX.maxLon;
    });
    if (!inside) continue;
    const routeId = local(p['odpt:busroute'] ?? p['owl:sameAs'].split('.').slice(0, 2).join('.'));
    let r = routeIndex.get(routeId);
    if (r === undefined) {
      r = routes.length;
      routeIndex.set(routeId, r);
      // "渋６６ 杉並車庫前行" → "渋66"
      const title = routeName((p['dc:title'] ?? routeId.split('.').pop()!).split(/[ 　]/)[0]);
      routes.push({ id: routeId, operator: op, name: title });
    }
    patternIndex.set(local(p['owl:sameAs']), patterns.length);
    const line = p['ug:region']?.type === 'LineString' ? p['ug:region'].coordinates.map(([lon, lat]) => [lat, lon] as [number, number]) : undefined;
    patterns.push({ id: local(p['owl:sameAs']), route: r, poles: order, line });
  }

  // Trips.
  const trips: BusTrip[] = [];
  for await (const t of read<OdptBusTimetable>('BusTimetable')) {
    const op = local(t['odpt:operator']);
    if (!BUS_OPERATORS[op]) continue;
    const pi = patternIndex.get(local(t['odpt:busroutePattern']));
    if (pi === undefined) continue;
    const objs = [...t['odpt:busTimetableObject']].sort((a, b) => a['odpt:index'] - b['odpt:index']);
    const stops: BusTrip['stops'] = [];
    let offset = 0;
    let last = -Infinity;
    for (const o of objs) {
      const pole = local(o['odpt:busstopPole']);
      if (!poles.has(pole)) continue;
      let dep = hhmm(o['odpt:departureTime'] ?? undefined);
      let arr = hhmm(o['odpt:arrivalTime'] ?? undefined);
      if (!Number.isFinite(dep)) dep = arr;
      if (!Number.isFinite(arr)) arr = dep;
      if (!Number.isFinite(dep)) continue;
      // Service day runs 03:00-27:00; after-midnight times continue the day.
      if (stops.length === 0 && dep < 180) offset = 1440;
      arr += offset;
      dep += offset;
      while (arr < last - 60) {
        offset += 1440;
        arr += 1440;
        dep += 1440;
      }
      last = Math.max(last, dep);
      stops.push({ pole, arr, dep });
    }
    if (stops.length < 2) continue;
    const cal = calendarFor(t['odpt:calendar']);
    const sign = objs.find((o) => o['odpt:destinationSign'])?.['odpt:destinationSign'] ?? '';
    trips.push({
      id: local(t['owl:sameAs']),
      pattern: pi,
      operator: op,
      dayBits: calendars[cal].dayBits,
      calendar: cal,
      stops,
      dest: routeName(sign.replace(/\s*行$/, '')),
      nonStep: objs.some((o) => o['odpt:isNonStepBus'] === true),
    });
  }

  // Fares: almost every operator charges a flat fare inside the 23 wards.
  const fareSeen = new Map<string, Map<string, number>>();
  const pairFares = new Map<string, [number, number]>();
  const usedPoles = new Set(trips.flatMap((t) => t.stops.map((s) => s.pole)));
  for await (const f of read<OdptBusFare>('BusroutePatternFare')) {
    const op = local(f['odpt:operator']);
    if (!BUS_OPERATORS[op]) continue;
    const a = local(f['odpt:fromBusstopPole']);
    const b = local(f['odpt:toBusstopPole']);
    if (!usedPoles.has(a) || !usedPoles.has(b)) continue;
    const k = `${f['odpt:icCardFare']}|${f['odpt:ticketFare']}`;
    const m = fareSeen.get(op) ?? new Map<string, number>();
    m.set(k, (m.get(k) ?? 0) + 1);
    fareSeen.set(op, m);
    pairFares.set(`${a}|${b}`, [f['odpt:icCardFare'], f['odpt:ticketFare']]);
  }
  // Each operator's usual fare stands for every trip; only the exceptions
  // (longer routes leaving the wards, special routes) are kept per stop pair.
  const flatFare: BusData['flatFare'] = {};
  for (const op of Object.keys(BUS_OPERATORS)) {
    const m = fareSeen.get(op);
    if (!m || m.size === 0) {
      flatFare[op] = null;
      continue;
    }
    const [usual] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const [ic, ticket] = usual.split('|').map(Number);
    flatFare[op] = { ic, ticket };
    for (const [k, [pic, pticket]] of [...pairFares]) {
      if (k.startsWith(`${op}.`) && pic === ic && pticket === ticket) pairFares.delete(k);
    }
  }
  return { calendars, poles, routes, patterns, trips, flatFare, pairFares };
}

/** Whether a Silver Pass holder rides free between these two poles. */
export function silverPassCovers(op: string, a: BusPole, b: BusPole): boolean {
  return (BUS_OPERATORS[op]?.silver ?? false) && inTokyo(a.lat, a.lon) && inTokyo(b.lat, b.lon);
}
