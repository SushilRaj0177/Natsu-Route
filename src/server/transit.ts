import { readFileSync } from 'node:fs';
import type { GeometryData, NetworkData } from '../shared/network.ts';
import { buildTimetable, type Timetable } from './timetable.ts';
import { DAY_BIT, dayTypeOf, addDays } from './time.ts';

/**
 * Trains and buses: the timetable network, which trips run on a given
 * service date, and fares.
 *
 * Trains run by day type (weekday / Saturday / holiday). Bus trips carry the
 * exact dates they run, which hold inside the period their operator
 * published; outside it they fall back to the day type the calendar stands
 * for. A RAPTOR timetable is built per service date and the last few are
 * kept.
 */
export class Transit {
  readonly data: NetworkData;
  readonly geometry: GeometryData;
  readonly holidays: Set<string>;
  private calendarDates: Set<string>[];
  private timetables = new Map<string, Timetable>();
  private order: string[] = [];
  /** fares[operator] -> Map "from|to" -> [ic, ticket] */
  private fares = new Map<number, Map<string, [number, number]>>();
  private busPairFares = new Map<string, [number, number]>();

  constructor(data: NetworkData, geometry: GeometryData) {
    this.data = data;
    this.geometry = geometry;
    this.holidays = new Set(data.holidays);
    this.calendarDates = data.calendars.map((c) => new Set(c.dates));
    for (const [op, a, b, ic, ticket] of data.fares) {
      let m = this.fares.get(op);
      if (!m) this.fares.set(op, (m = new Map()));
      m.set(`${a}|${b}`, [ic, ticket]);
    }
    for (const [a, b, ic, ticket] of data.busFares.pairs) this.busPairFares.set(`${a}|${b}`, [ic, ticket]);
  }

  static load(dir: string): Transit {
    const data = JSON.parse(readFileSync(`${dir}/network.json`, 'utf8')) as NetworkData;
    const geometry = JSON.parse(readFileSync(`${dir}/geometry.json`, 'utf8')) as GeometryData;
    return new Transit(data, geometry);
  }

  /** Does trip i run on this service date? */
  runs(i: number, date: string, dayBit: number): boolean {
    const t = this.data.trips[i];
    if (t.dc === undefined) return (t.cal & dayBit) !== 0;
    const c = this.data.calendars[t.dc];
    if (c.from && c.to && date >= c.from && date <= c.to) return this.calendarDates[t.dc].has(date);
    return (c.dayBits & dayBit) !== 0;
  }

  timetable(date: string): Timetable {
    let tt = this.timetables.get(date);
    if (!tt) {
      const bit = DAY_BIT[dayTypeOf(date, this.holidays)];
      tt = buildTimetable(this.data, (i) => this.runs(i, date, bit));
      this.timetables.set(date, tt);
      this.order.push(date);
      while (this.order.length > 4) this.timetables.delete(this.order.shift()!);
    }
    return tt;
  }

  /**
   * A date whose timetable stands in for `date` (used by the summer replay:
   * the heat and sun are from a past day, the trains and buses are today's).
   * The first date from `from` on with the same day type.
   */
  equivalentDate(date: string, from: string): string {
    const want = dayTypeOf(date, this.holidays);
    for (let k = 0; k < 14; k++) {
      const d = addDays(from, k);
      if (dayTypeOf(d, this.holidays) === want) return d;
    }
    return from;
  }

  operatorOfStation(station: number): number {
    return this.data.railways[this.data.stations[station].railway].operator;
  }

  /** The line a trip runs as at a given stop (bus trips name their route). */
  lineOfTrip(trip: number, station: number): number {
    const t = this.data.trips[trip];
    return t.r ?? this.data.stations[station].railway;
  }

  isBusTrip(trip: number): boolean {
    return this.data.trips[trip].r !== undefined;
  }

  /** Published rail fare for one operator between two stations, trying sibling stations at the same places. */
  railFare(op: number, from: number, to: number): [number, number] | undefined {
    const m = this.fares.get(op);
    if (!m) return undefined;
    const direct = m.get(`${from}|${to}`);
    if (direct) return direct;
    const sameOp = (place: number) => this.data.places[place].stations.filter((s) => this.operatorOfStation(s) === op);
    for (const a of sameOp(this.data.stations[from].place)) {
      for (const b of sameOp(this.data.stations[to].place)) {
        const f = m.get(`${a}|${b}`);
        if (f) return f;
      }
    }
    return undefined;
  }

  /** Bus fare between two stops of one operator. */
  busFare(op: number, from: number, to: number): [number, number] | undefined {
    return this.busPairFares.get(`${from}|${to}`) ?? (this.data.busFares.flat[op] as [number, number] | undefined);
  }

  hop(a: number, b: number): string | undefined {
    return this.geometry.hops[`${a}>${b}`];
  }
}
