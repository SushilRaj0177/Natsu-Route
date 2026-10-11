/**
 * Door-to-door trips that keep people out of the sun.
 *
 * 1. Walk outward from the start and backward from the destination on the
 *    street network, weighing seconds in direct sun against extra walking
 *    (how much depends on the heat index at that hour).
 * 2. Hand the stations and bus stops reached to RAPTOR as sources and
 *    targets. A stop reached through a lot of sun counts as reached later,
 *    so the search leans towards shadier stops.
 * 3. Repeat with no weight (fastest), the heat's weight, and a stronger
 *    one, then rebuild each candidate as a real trip: when to leave home,
 *    each walk on the street with its shade at the time it is walked, the
 *    wait at each stop (in the open at most bus stops), fares, and places to
 *    rest along the way.
 * 4. Keep the options no other option beats on arrival, sun, changes and
 *    walking, and label the coolest, the fastest and the easiest.
 */
import type {
  Fare,
  HeatInfo,
  HeatLevel,
  Leg,
  LineRef,
  Names,
  OptionLabel,
  PlanQuery,
  PlanResponse,
  Preference,
  RideLeg,
  StopRef,
  TripOption,
  Wait,
  WalkLeg,
} from '../shared/api.ts';
import { toXY } from '../shared/proj.ts';
import { decodePolyline, encodePolyline } from '../shared/polyline.ts';
import { dayTypeOf, instantOf, serviceTime } from './time.ts';
import { raptor, type RaptorJourney, type RaptorLeg } from './raptor.ts';
import type { Timetable } from './timetable.ts';
import type { Transit } from './transit.ts';
import type { AccessIndex, AccessPoint } from './access.ts';
import { F_STEPS, type Snap, type WalkGraph } from './walk/graph.ts';
import { sunBucket, type ExposureModel } from './walk/exposure.ts';
import { labelAtSnap, recost, walkSearch, walkTo, type Walk, type WalkPrefs, type WalkTree } from './walk/search.ts';
import { describeWalk } from './walk/describe.ts';
import { HeatService, nearestPoint, POINTS, SUN_WEIGHT, type AlertLevel, type PointCode, type Replay } from './heat.ts';
import type { RestIndex } from './rest.ts';
import type { LiveData } from './live.ts';
import { sunPosition } from './shade/sun.ts';

/** Arrive at a bus stop this early, and on a platform this early, before departure. */
const MARGIN_BUS = 90;
const MARGIN_RAIL = 120;
const MAX_ROUNDS = 4;
/** How far a person will walk to the first stop / from the last, by default. */
const DEFAULT_MAX_WALK_MIN = 15;
const PRIORITY: Record<NonNullable<PlanQuery['priority']>, number> = { cool: 1.8, balanced: 1, fast: 0.35 };

export interface PlannerDeps {
  transit: Transit;
  graph: WalkGraph;
  exposure: ExposureModel;
  access: AccessIndex;
  heat: HeatService;
  rest: RestIndex;
  streetNames: { ja: string; en?: string | null }[];
  live?: LiveData;
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Ctx {
  q: Required<Pick<PlanQuery, 'speed' | 'stairs' | 'maxWalkMinutes' | 'silverPass'>> & PlanQuery;
  /** Service date whose timetable is used, and its 00:00 in epoch ms. */
  date: string;
  day0: number;
  tt: Timetable;
  /** Added to timetable instants to get the instant whose sun and heat apply (replay). */
  sunOffset: number;
  replay?: Replay;
  origin: { snap: Snap; name: Names; lat: number; lon: number };
  dest: { snap: Snap; name: Names; lat: number; lon: number };
  point: PointCode;
  preference: Preference;
  speedFactor: number;
}

interface Candidate {
  weight: number;
  prefs: WalkPrefs;
  treeF: WalkTree;
  treeB: WalkTree;
  journey?: RaptorJourney;
  src?: AccessPoint;
  dst?: AccessPoint;
}

interface Built {
  option: TripOption;
  leaveMs: number;
  arriveMs: number;
  signature: string;
}

export class Planner {
  constructor(private d: PlannerDeps) {}

  async plan(query: PlanQuery): Promise<PlanResponse> {
    const q = {
      speed: clamp(query.speed ?? 1.0, 0.5, 1.6),
      stairs: query.stairs ?? 'avoid',
      maxWalkMinutes: clamp(query.maxWalkMinutes ?? DEFAULT_MAX_WALK_MIN, 3, 30),
      silverPass: query.silverPass ?? false,
      ...query,
    } as Ctx['q'];
    const at = new Date(q.at);
    if (Number.isNaN(at.getTime())) throw new PlanError('bad time');
    const { graph } = this.d;
    const noSteps = (e: number) => (graph.d.flags[e] & F_STEPS) === 0;
    const snapOf = (p: { lat: number; lon: number }) => {
      const [x, y] = toXY(p.lon, p.lat);
      return graph.snap(x, y, 400, q.stairs === 'never' ? noSteps : undefined);
    };
    const oSnap = snapOf(q.from);
    const dSnap = snapOf(q.to);
    if (!oSnap) throw new PlanError('start is too far from any path we know');
    if (!dSnap) throw new PlanError('destination is too far from any path we know');

    // Replay: the trains and buses of a matching day now, the heat and sun of a past summer day.
    let replay: Replay | undefined;
    let sunOffset = 0;
    let clock = at;
    if (q.replay) {
      replay = this.d.heat.replays.find((r) => r.date === q.replay);
      if (!replay) throw new PlanError('unknown replay day');
      const st = serviceTime(at);
      const ttDate = this.d.transit.equivalentDate(replay.date, st.date);
      clock = instantOf(ttDate, st.minute);
      sunOffset = instantOf(replay.date, 0).getTime() - instantOf(ttDate, 0).getTime();
    }

    const point = nearestPoint(q.from.lat, q.from.lon);
    const heat0 = await this.heatAt(clock.getTime() + sunOffset, point, replay);
    const preference = resolvePreference(q.mode, heat0?.level ?? null, clock.getTime() + sunOffset);
    const base = {
      q,
      sunOffset,
      replay,
      origin: { snap: oSnap, name: q.from.name ?? { ja: '出発地', en: 'Start' }, lat: q.from.lat, lon: q.from.lon },
      dest: { snap: dSnap, name: q.to.name ?? { ja: '目的地', en: 'Destination' }, lat: q.to.lat, lon: q.to.lon },
      point,
      preference,
      speedFactor: 1.2 / q.speed,
    };
    const weight = baseWeight(preference, heat0?.level ?? null) * PRIORITY[q.priority ?? 'balanced'];

    let built: Built[];
    if (q.arriveBy) {
      // Probe a few departure times and keep what arrives in time, leaving as late as possible.
      const deadline = clock.getTime();
      const all: Built[] = [];
      for (const back of [100, 70, 45, 25]) all.push(...(await this.search(base, deadline - back * 60_000, weight)));
      built = all.filter((b) => b.arriveMs <= deadline + 30_000);
      // Per route, the latest departure.
      const bySig = new Map<string, Built>();
      for (const b of built) {
        const prev = bySig.get(b.signature);
        if (!prev || b.leaveMs > prev.leaveMs) bySig.set(b.signature, b);
      }
      built = [...bySig.values()];
    } else {
      built = await this.search(base, clock.getTime(), weight);
      built = built.filter((b) => b.leaveMs <= clock.getTime() + 90 * 60_000);
    }
    const options = choose(built, preference, q.arriveBy ?? false);

    const st = serviceTime(clock);
    const sp = sunPosition(clock.getTime() + sunOffset, q.from.lat, q.from.lon);
    const notes: Names[] = [];
    if (!this.d.exposure.shade.covers(oSnap.x, oSnap.y) || !this.d.exposure.shade.covers(dSnap.x, dSnap.y) || options.some((o) => o.partialShade)) {
      notes.push({
        ja: '建物の高さのデータは東京23区内だけです。区外を歩く部分の日陰は計算していません。',
        en: 'Building heights cover the 23 wards only; shade is not worked out for walking outside them.',
      });
    }
    if (!heat0 && !replay) {
      notes.push(
        HeatService.inSeason(clock.getTime())
          ? { ja: '暑さ指数を取得できませんでした。', en: 'The heat index could not be fetched.' }
          : { ja: '暑さ指数は4月下旬から10月下旬まで公表されます。「夏の日で試す」で実際の夏の日を体験できます。', en: 'The heat index is published from late April to late October. "Try a summer day" replays a real one.' },
      );
    }
    if (!options.length) notes.push({ ja: 'この条件で行ける経路が見つかりませんでした。歩く時間の上限を長くしてみてください。', en: 'No trip found with these settings. Try allowing a longer walk.' });

    return {
      query: { at: clock.toISOString(), arriveBy: q.arriveBy ?? false, serviceDate: st.date, dayType: dayTypeOf(st.date, this.d.transit.holidays) },
      preference,
      heat: heat0 ? await this.heatInfo(heat0, clock.getTime() + sunOffset, point, replay) : null,
      sun: { elevation: Math.round(sp.elevation * 10) / 10, azimuth: Math.round(sp.azimuth) },
      options,
      replay: replay ? { date: replay.date, label: replay.label, timetableDate: st.date } : undefined,
      notes,
      data: { builtAt: this.d.transit.data.builtAt, timetableIssued: this.d.transit.data.timetableIssued },
    };
  }

  /** Every candidate trip leaving from `departMs` on. */
  private async search(base: Omit<Ctx, 'date' | 'day0' | 'tt'>, departMs: number, weight: number): Promise<Built[]> {
    const { transit, graph, exposure, access } = this.d;
    const st = serviceTime(new Date(departMs));
    const ctx: Ctx = { ...base, date: st.date, day0: instantOf(st.date, 0).getTime(), tt: transit.timetable(st.date) };
    const depSec = Math.round((departMs - ctx.day0) / 1000);
    const maxWalk = ctx.q.maxWalkMinutes * 60;
    const weights = base.preference === 'neutral' || weight <= 0 ? [0] : [...new Set([0, round1(weight), round1(Math.min(10, weight * 2.5))])];

    // Rough arrival time for the backward search's sun: straight line at 6 m/s plus 15 minutes.
    const [ox, oy] = [ctx.origin.snap.x, ctx.origin.snap.y];
    const [dx, dy] = [ctx.dest.snap.x, ctx.dest.snap.y];
    const etaMs = departMs + (Math.hypot(dx - ox, dy - oy) / 6 + 900) * 1000;

    const cands: Candidate[] = [];
    for (const w of weights) {
      const prefs: WalkPrefs = { speed: ctx.q.speed, stairs: ctx.q.stairs, preference: base.preference, weight: w };
      const treeF = walkSearch(graph, exposure, ctx.origin.snap, departMs + ctx.sunOffset, prefs, maxWalk);
      const treeB = walkSearch(graph, exposure, ctx.dest.snap, etaMs + ctx.sunOffset, prefs, maxWalk, -1);
      const unwanted = (lab: { time: number; sun: number }) =>
        base.preference === 'cool' ? lab.sun : base.preference === 'warm' ? lab.time - lab.sun : base.preference === 'rain' ? lab.time : 0;

      const srcBest = new Map<number, { time: number; ap: AccessPoint }>();
      const dstBest = new Map<number, { extra: number; ap: AccessPoint }>();
      for (const ap of access.points) {
        if (ctx.q.stairs === 'never' && ap.entrance?.stepFree === false) continue;
        const inner = ap.inner * ctx.speedFactor;
        const isPole = transit.data.stations[ap.stop].pole === true;
        const a = labelAtSnap(graph, exposure, treeF, ap.snap);
        if (a && a.time <= maxWalk) {
          const t = depSec + a.time + inner + (isPole ? MARGIN_BUS : MARGIN_RAIL) + w * unwanted(a);
          const prev = srcBest.get(ap.stop);
          if (!prev || t < prev.time) srcBest.set(ap.stop, { time: t, ap });
        }
        const b = labelAtSnap(graph, exposure, treeB, ap.snap);
        if (b && b.time <= maxWalk) {
          const extra = b.time + inner + w * unwanted(b);
          const prev = dstBest.get(ap.stop);
          if (!prev || extra < prev.extra) dstBest.set(ap.stop, { extra, ap });
        }
      }
      const journeys = raptor(ctx.tt, {
        sources: [...srcBest].map(([stop, v]) => ({ stop, time: Math.ceil(v.time) })),
        targets: [...dstBest].map(([stop, v]) => ({ stop, extra: Math.ceil(v.extra) })),
        maxRounds: MAX_ROUNDS,
        allowSurcharge: false,
        minChangeSec: Math.round(90 * ctx.speedFactor),
        ridesAtEnds: true,
      });
      for (const j of journeys) {
        if (!j.legs.some((l) => l.kind === 'ride')) continue;
        const first = j.legs[0];
        cands.push({ weight: w, prefs, treeF, treeB, journey: j, src: srcBest.get(first.from)?.ap, dst: dstBest.get(j.target)?.ap });
      }
      // Walking all the way.
      cands.push({ weight: w, prefs, treeF, treeB });
    }

    const out: Built[] = [];
    for (const c of cands) {
      const b = c.journey ? await this.buildTransit(ctx, c) : await this.buildWalk(ctx, c);
      if (b) out.push(b);
    }
    return out;
  }

  private ms(ctx: Ctx, sec: number): number {
    return ctx.day0 + sec * 1000;
  }

  private iso(ms: number): string {
    return new Date(ms + 9 * 3600_000).toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '');
  }

  private async buildWalk(ctx: Ctx, c: Candidate): Promise<Built | null> {
    const w0 = walkTo(this.d.graph, this.d.exposure, c.treeF, ctx.dest.snap);
    if (!w0 || w0.time > ctx.q.maxWalkMinutes * 60 * 2) return null;
    const leaveMs = c.treeF.startMs - ctx.sunOffset;
    const leg = this.walkLeg(ctx, w0, 'direct', ctx.origin.name, ctx.dest.name, leaveMs);
    const option = await this.finish(ctx, [leg], leaveMs, leaveMs + w0.time * 1000);
    return { option, leaveMs, arriveMs: leaveMs + w0.time * 1000, signature: 'walk' };
  }

  private async buildTransit(ctx: Ctx, c: Candidate): Promise<Built | null> {
    const { graph, exposure, transit } = this.d;
    let j = c.journey!;
    if (!c.src || !c.dst) return null;
    const accessPath = walkTo(graph, exposure, c.treeF, c.src.snap);
    if (!accessPath) return null;
    const srcPole = transit.data.stations[c.src.stop].pole === true;
    const margin = srcPole ? MARGIN_BUS : MARGIN_RAIL;
    const srcInner = c.src.inner * ctx.speedFactor;
    // The weighted search may have reached the stop "late" (sun counted as
    // time). Now that the walk is fixed, catch the earliest service that
    // works from this stop to this final stop.
    const egressLabel = labelAtSnap(graph, exposure, c.treeB, c.dst.snap);
    if (egressLabel) {
      const departSec = Math.round((c.treeF.startMs - ctx.sunOffset - ctx.day0) / 1000);
      const again = raptor(ctx.tt, {
        sources: [{ stop: c.src.stop, time: Math.ceil(departSec + accessPath.time + srcInner + margin) }],
        targets: [{ stop: j.target, extra: Math.ceil(egressLabel.time + c.dst.inner * ctx.speedFactor) }],
        maxRounds: MAX_ROUNDS,
        allowSurcharge: false,
        minChangeSec: Math.round(90 * ctx.speedFactor),
        ridesAtEnds: true,
      }).filter((x) => x.trains <= j.trains);
      const earliest = again.sort((a, b) => a.arr - b.arr)[0];
      if (earliest && earliest.arr < j.arr) j = earliest;
    }
    const rides = j.legs.filter((l): l is Extract<RaptorLeg, { kind: 'ride' }> => l.kind === 'ride');
    const firstRide = rides[0];
    if (!firstRide || firstRide.from !== c.src.stop) return null;
    const leaveSec = firstRide.dep - margin - srcInner - accessPath.time;
    const leaveMs = this.ms(ctx, leaveSec);
    const access = recost(graph, exposure, accessPath, leaveMs + ctx.sunOffset, c.prefs);

    const legs: Leg[] = [];
    const stopName = (s: number) => this.stopNames(s);
    const accessLeg = this.walkLeg(ctx, access, 'access', ctx.origin.name, stopName(firstRide.from), leaveMs);
    if (c.src.entrance) accessLeg.entrance = { exit: c.src.entrance.exit, stepFree: c.src.entrance.stepFree, lat: c.src.entrance.lat, lon: c.src.entrance.lon };
    legs.push(accessLeg);

    let readyAt = firstRide.dep - margin; // at the stop or on the platform
    for (let i = 0; i < j.legs.length; i++) {
      const l = j.legs[i];
      if (l.kind === 'walk') {
        const leg = await this.transferLeg(ctx, l.from, l.to, l.dep, l.arr, c.prefs);
        legs.push(leg);
        readyAt = l.dep + Math.round((Date.parse(leg.arr) - Date.parse(leg.dep)) / 1000);
        continue;
      }
      const isFirst = l === firstRide;
      const waitSec = isFirst ? margin : Math.max(0, l.dep - readyAt);
      legs.push(this.rideLeg(ctx, l, waitSec));
      readyAt = l.arr;
    }

    const last = rides[rides.length - 1];
    const dstInner = c.dst.inner * ctx.speedFactor;
    const egressPath = walkTo(graph, exposure, c.treeB, c.dst.snap);
    if (!egressPath) return null;
    const egressStartMs = this.ms(ctx, last.arr + dstInner);
    const egress = recost(graph, exposure, egressPath, egressStartMs + ctx.sunOffset, c.prefs);
    const egressLeg = this.walkLeg(ctx, egress, 'egress', stopName(j.target), ctx.dest.name, egressStartMs);
    if (c.dst.entrance) egressLeg.entrance = { exit: c.dst.entrance.exit, stepFree: c.dst.entrance.stepFree, lat: c.dst.entrance.lat, lon: c.dst.entrance.lon };
    legs.push(egressLeg);
    const arriveMs = egressStartMs + egress.time * 1000;

    const trips = legs.filter((x): x is RideLeg => x.kind === 'ride').map((x) => x.trip);
    const signature = `${firstRide.from}|${trips.join(',')}|${j.target}`;
    const option = await this.finish(ctx, legs, leaveMs, arriveMs);
    return { option, leaveMs, arriveMs, signature };
  }

  private stopNames(station: number): Names {
    const s = this.d.transit.data.stations[station];
    return s.pole ? { ja: `${s.name.ja}（バス停）`, en: `${s.name.en} (bus stop)` } : { ja: `${s.name.ja}駅`, en: `${s.name.en} Sta.` };
  }

  private walkLeg(_ctx: Ctx, w: Walk, role: WalkLeg['role'], from: Names, to: Names, startMs: number): WalkLeg {
    const segments = describeWalk(this.d.graph, w, this.d.streetNames);
    return {
      kind: 'walk',
      role,
      from,
      to,
      dep: this.iso(startMs),
      arr: this.iso(startMs + w.time * 1000),
      metres: Math.round(w.metres),
      seconds: Math.round(w.time),
      sunSeconds: Math.round(w.sun),
      unknownSeconds: Math.round(w.unknown),
      segments,
      rest: this.d.rest.along(segments),
    };
  }

  private async transferLeg(ctx: Ctx, a: number, b: number, depSec: number, arrSec: number, prefs: WalkPrefs): Promise<WalkLeg> {
    const { transit, graph, exposure, access } = this.d;
    const sa = transit.data.stations[a];
    const sb = transit.data.stations[b];
    const startMs = this.ms(ctx, depSec);
    const base = {
      kind: 'walk' as const,
      role: 'transfer' as const,
      from: this.stopNames(a),
      to: this.stopNames(b),
      dep: this.iso(startMs),
    };
    if (!sa.pole && !sb.pole && sa.place === sb.place) {
      const sec = arrSec - depSec;
      return { ...base, arr: this.iso(this.ms(ctx, arrSec)), metres: Math.round(sec * 0.9), seconds: sec, sunSeconds: 0, unknownSeconds: 0, segments: [], rest: [], inStation: true };
    }
    const apA = access.byStop[a].map((i) => access.points[i])[0];
    const apB = access.byStop[b].map((i) => access.points[i])[0];
    if (apA && apB) {
      const tree = walkSearch(graph, exposure, apA.snap, startMs + ctx.sunOffset, prefs, 1500);
      const w = walkTo(graph, exposure, tree, apB.snap);
      if (w) {
        const inner = (apA.inner + apB.inner) * ctx.speedFactor;
        const leg = this.walkLeg(ctx, w, 'transfer', base.from, base.to, startMs);
        leg.seconds = Math.round(w.time + inner);
        leg.arr = this.iso(startMs + leg.seconds * 1000);
        return leg;
      }
    }
    const sec = arrSec - depSec;
    return { ...base, arr: this.iso(this.ms(ctx, arrSec)), metres: Math.round((sec - 60) / 1.35), seconds: sec, sunSeconds: 0, unknownSeconds: sec, segments: [], rest: [] };
  }

  private rideLeg(ctx: Ctx, l: Extract<RaptorLeg, { kind: 'ride' }>, waitSec: number): RideLeg {
    const { transit, exposure, access } = this.d;
    const data = transit.data;
    const trip = ctx.tt.routeTrips[ctx.tt.routeTripStart[l.route] + l.tripPos];
    const t = data.trips[trip];
    const bus = t.r !== undefined;
    const lineIdx = t.r ?? data.stations[l.from].railway;
    let typeIdx = t.ty;
    for (const [pos, ty] of t.tc ?? []) if (pos <= l.board) typeIdx = ty;
    const from = this.stopRef(l.from);
    const to = this.stopRef(l.to);

    // Waiting: on a platform (roofed) for trains, at the kerb for buses.
    let wait: Wait = { seconds: waitSec, outdoor: false, sun: 0, sheltered: true, bench: null };
    if (bus) {
      const info = access.poles.get(l.from);
      const [x, y] = toXY(from.lon, from.lat);
      const waitMid = this.ms(ctx, l.dep - waitSec / 2) + ctx.sunOffset;
      const light = info?.sheltered ? 0 : exposure.lightAt(x, y, sunBucket(waitMid));
      wait = { seconds: waitSec, outdoor: true, sun: Math.round(light * 100) / 100, sheltered: info?.sheltered ?? null, bench: info?.bench ?? null };
    }

    let line5: string | undefined;
    if (bus) {
      const pat = t.pt !== undefined ? transit.geometry.patterns[t.pt] : '';
      line5 = pat ? sliceLine(pat, from, to) : encodePolyline(t.s.slice(l.board, l.alight + 1).map((s) => [data.stations[s].lat, data.stations[s].lon]));
    } else {
      const pts: [number, number][] = [];
      for (let i = l.board; i < l.alight; i++) {
        const hop = transit.hop(t.s[i], t.s[i + 1]);
        const seg = hop ? decodePolyline(hop) : [[data.stations[t.s[i]].lat, data.stations[t.s[i]].lon], [data.stations[t.s[i + 1]].lat, data.stations[t.s[i + 1]].lon]] as [number, number][];
        pts.push(...(pts.length ? seg.slice(1) : seg));
      }
      line5 = encodePolyline(pts);
    }

    const op = data.operators[data.railways[lineIdx].operator];
    const silverPass =
      !!op.silver &&
      (bus ? !!data.stations[l.from].wards && !!data.stations[l.to].wards : t.s.slice(l.board, l.alight + 1).every((s) => data.operators[transit.operatorOfStation(s)].silver));

    const live = !bus ? this.d.live?.forTrip(trip, ctx.date, Math.round(l.dep / 60)) : undefined;
    return {
      kind: 'ride',
      mode: bus ? 'bus' : 'rail',
      line: this.lineRef(lineIdx),
      service: data.trainTypes[typeIdx].name,
      destination: data.destinations[t.dest],
      from,
      to,
      dep: this.iso(this.ms(ctx, l.dep)),
      arr: this.iso(this.ms(ctx, l.arr)),
      stops: l.alight - l.board,
      platform: t.pl?.[l.board] ?? undefined,
      nonStep: t.ns === 1 ? true : undefined,
      silverPass,
      wait,
      line5,
      live: live?.delay !== undefined ? { delayMinutes: Math.round(live.delay / 60), asOf: live.asOf } : undefined,
      trip,
    };
  }

  lineRef(i: number): LineRef {
    const data = this.d.transit.data;
    const r = data.railways[i];
    return { railway: r.id, name: r.name, color: r.color, code: r.code, operator: data.operators[r.operator].name, mode: r.mode === 'bus' ? 'bus' : 'rail' };
  }

  stopRef(i: number): StopRef {
    const s = this.d.transit.data.stations[i];
    return { station: i, place: s.place, name: s.name, code: s.code, lat: s.lat, lon: s.lon, line: this.lineRef(s.railway), pole: s.number };
  }

  /** Totals, fare and heat for a finished list of legs. */
  private async finish(ctx: Ctx, legs: Leg[], leaveMs: number, arriveMs: number): Promise<TripOption> {
    let sun = 0;
    let outdoor = 0;
    let walkM = 0;
    let walkS = 0;
    let stairs = 0;
    let partial = false;
    let peak: { wbgt: number; level: HeatLevel } | undefined;
    for (const l of legs) {
      if (l.kind === 'walk') {
        sun += l.sunSeconds;
        walkM += l.metres;
        walkS += l.seconds;
        if (!l.inStation) outdoor += l.segments.filter((s) => !s.shelter).reduce((a, s) => a + s.seconds, 0);
        stairs += l.segments.filter((s) => s.stairs).length;
        if (l.unknownSeconds > 0) partial = true;
        if (!l.inStation && l.seconds > 60) {
          const h = await this.heatAt(Date.parse(l.dep) + ctx.sunOffset, ctx.point, ctx.replay);
          if (h && (!peak || h.wbgt > peak.wbgt)) peak = { wbgt: h.wbgt, level: h.level };
        }
      } else if (l.wait.outdoor) {
        sun += l.wait.seconds * l.wait.sun;
        outdoor += l.wait.seconds;
      }
    }
    const rides = legs.filter((l): l is RideLeg => l.kind === 'ride');
    return {
      id: '',
      labels: [],
      leave: this.iso(leaveMs),
      arrive: this.iso(arriveMs),
      seconds: Math.round((arriveMs - leaveMs) / 1000),
      sunSeconds: Math.round(sun),
      outdoorSeconds: Math.round(outdoor),
      walkMetres: Math.round(walkM),
      walkSeconds: Math.round(walkS),
      transfers: Math.max(0, rides.length - 1),
      stairs,
      heatPeak: peak,
      fare: this.fare(rides, ctx.q.silverPass),
      legs,
      partialShade: partial,
    };
  }

  /**
   * Fare per operator: consecutive rides on one railway operator are one
   * journey (one fare); through trains are split where the operator
   * changes; Tokyo Metro and Toei subway give ¥70 off when changing between
   * them; each bus boarding pays that bus's fare. With the Silver Pass,
   * Toei rail and buses inside the 23 wards are free.
   */
  private fare(rides: RideLeg[], silver: boolean): Fare {
    const { transit } = this.d;
    const data = transit.data;
    type Seg = { op: number; from: number; to: number; bus: boolean; silver: boolean };
    const segs: Seg[] = [];
    for (const r of rides) {
      if (r.mode === 'bus') {
        segs.push({ op: transit.operatorOfStation(r.from.station), from: r.from.station, to: r.to.station, bus: true, silver: r.silverPass });
        continue;
      }
      const t = data.trips[r.trip];
      const a = t.s.indexOf(r.from.station);
      const b = t.s.indexOf(r.to.station, a);
      // Where a through train changes operator, the fare boundary is the
      // station both operators share (it appears once, under either).
      const hasOp = (station: number, op: number) => data.places[data.stations[station].place].stations.some((x) => transit.operatorOfStation(x) === op);
      let start = a;
      let op = transit.operatorOfStation(t.s[a]);
      for (let i = a + 1; i <= b; i++) {
        const here = transit.operatorOfStation(t.s[i]);
        if (here === op) continue;
        const junction = hasOp(t.s[i - 1], here) ? i - 1 : hasOp(t.s[i], op) ? i : i - 1;
        if (junction > start) push(op, t.s[start], t.s[junction]);
        start = junction;
        op = here;
      }
      if (b > start) push(op, t.s[start], t.s[b]);
    }
    function push(op: number, from: number, to: number) {
      const last = segs[segs.length - 1];
      if (last && !last.bus && last.op === op) last.to = to;
      else segs.push({ op, from, to, bus: false, silver: !!data.operators[op].silver });
    }
    let ic = 0;
    let ticket = 0;
    let withSilver = 0;
    const missing = new Map<number, Names>();
    segs.forEach((s, i) => {
      const f = s.bus ? transit.busFare(s.op, s.from, s.to) : transit.railFare(s.op, s.from, s.to);
      if (!f) {
        missing.set(s.op, data.operators[s.op].name);
        return;
      }
      let [fi, ft] = f;
      const prev = segs[i - 1];
      const pair = prev && !prev.bus && !s.bus ? `${data.operators[prev.op].id}>${data.operators[s.op].id}` : '';
      if (pair === 'TokyoMetro>Toei' || pair === 'Toei>TokyoMetro') {
        fi -= 70;
        ft -= 70;
      }
      ic += fi;
      ticket += ft;
      if (!(silver && s.silver)) withSilver += fi;
    });
    return { ic, ticket, withSilverPass: withSilver, missing: [...missing.values()] };
  }

  private async heatAt(ms: number, point: PointCode, replay?: Replay) {
    if (replay) return this.d.heat.replayAt(replay, ms, point);
    return this.d.heat.at(ms, point);
  }

  private async heatInfo(h: { wbgt: number; level: HeatLevel; kind: 'actual' | 'forecast' | 'replay' }, ms: number, point: PointCode, replay?: Replay): Promise<HeatInfo> {
    // Highest value from now until 18:00 that day.
    let peak: HeatInfo['peak'];
    const d = new Date(ms + 9 * 3600_000);
    const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18) - 9 * 3600_000;
    for (let t = ms; t <= endMs; t += 3600_000) {
      const v = await this.heatAt(t, point, replay);
      if (v && (!peak || v.wbgt > peak.wbgt)) peak = { wbgt: v.wbgt, level: v.level, at: this.iso(t) };
    }
    let alert: AlertLevel = 'none';
    if (replay) alert = replay.alert;
    else alert = (await this.d.heat.alerts())?.today ?? 'none';
    const p = POINTS.find((x) => x.code === point)!;
    return { wbgt: h.wbgt, level: h.level, kind: h.kind, point: p.name, peak, alert };
  }
}

function resolvePreference(mode: PlanQuery['mode'], level: HeatLevel | null, ms: number): Preference {
  if (mode && mode !== 'auto') return mode;
  if (level) return level === 'safe' ? 'neutral' : 'cool';
  const month = new Date(ms + 9 * 3600_000).getUTCMonth() + 1;
  if (month === 12 || month <= 2) return 'warm';
  if (month >= 6 && month <= 9) return 'cool';
  return 'neutral';
}

function baseWeight(p: Preference, level: HeatLevel | null): number {
  if (p === 'cool') return SUN_WEIGHT[level ?? 'warning'];
  if (p === 'warm') return 1;
  if (p === 'rain') return 3;
  return 0;
}

/**
 * Keep options nothing else beats, label the best for each concern and
 * order them: the one that best avoids the unwanted condition first, then
 * the fastest, then the easiest.
 */
function choose(all: Built[], pref: Preference, arriveBy: boolean): TripOption[] {
  // Same route found by several searches: keep the best-timed copy.
  const bySig = new Map<string, Built>();
  for (const b of all) {
    const prev = bySig.get(b.signature);
    const better = !prev || (arriveBy ? b.leaveMs > prev.leaveMs : b.arriveMs < prev.arriveMs) || (b.arriveMs === prev.arriveMs && b.option.sunSeconds < prev.option.sunSeconds);
    if (better) bySig.set(b.signature, b);
  }
  let list = [...bySig.values()];
  const exposure = (b: Built) => (pref === 'warm' ? -b.option.sunSeconds : pref === 'rain' ? b.option.outdoorSeconds : b.option.sunSeconds);
  const timeKey = (b: Built) => (arriveBy ? -b.leaveMs : b.arriveMs);
  // Drop dominated options.
  list = list.filter(
    (x) =>
      !list.some(
        (y) =>
          y !== x &&
          timeKey(y) <= timeKey(x) &&
          exposure(y) <= exposure(x) &&
          y.option.transfers <= x.option.transfers &&
          y.option.walkSeconds <= x.option.walkSeconds &&
          (timeKey(y) < timeKey(x) || exposure(y) < exposure(x) || y.option.transfers < x.option.transfers || y.option.walkSeconds < x.option.walkSeconds),
      ),
  );
  if (!list.length) return [];
  const byTime = [...list].sort((a, b) => timeKey(a) - timeKey(b) || exposure(a) - exposure(b));
  const fastest = byTime[0];
  const best = [...list].sort((a, b) => exposure(a) - exposure(b) || timeKey(a) - timeKey(b))[0];
  const easiest = [...list].sort(
    (a, b) =>
      a.option.transfers * 600 + a.option.walkSeconds + a.option.stairs * 120 - (b.option.transfers * 600 + b.option.walkSeconds + b.option.stairs * 120) ||
      timeKey(a) - timeKey(b),
  )[0];
  const label = (b: Built, l: OptionLabel) => {
    if (!b.option.labels.includes(l)) b.option.labels.push(l);
  };
  const avoidLabel: OptionLabel | null = pref === 'cool' ? 'coolest' : pref === 'warm' ? 'sunniest' : pref === 'rain' ? 'driest' : null;
  // Only call something the coolest if it really is noticeably cooler.
  if (avoidLabel && (best === fastest || Math.abs(exposure(fastest) - exposure(best)) >= 45)) label(best, avoidLabel);
  label(fastest, 'fastest');
  label(easiest, 'easiest');
  for (const b of list) if (b.signature === 'walk') label(b, 'walk');

  const ordered: Built[] = [];
  const push = (b: Built | undefined) => b && !ordered.includes(b) && ordered.push(b);
  if (avoidLabel) push(list.find((b) => b.option.labels.includes(avoidLabel)));
  push(fastest);
  push(easiest);
  push(list.find((b) => b.signature === 'walk' && b.option.seconds < fastest.option.seconds * 1.6));
  for (const b of byTime) if (ordered.length < 4) push(b);
  return ordered.slice(0, 4).map((b, i) => {
    b.option.id = `${i}-${hash(b.signature)}`;
    b.option.vsFastest =
      b === fastest
        ? undefined
        : {
            extraSeconds: b.option.seconds - fastest.option.seconds,
            laterSeconds: Math.round((b.arriveMs - fastest.arriveMs) / 1000),
            lessSunSeconds: fastest.option.sunSeconds - b.option.sunSeconds,
          };
    return b.option;
  });
}

/** The part of a bus pattern's line between two stops. */
function sliceLine(encoded: string, from: { lat: number; lon: number }, to: { lat: number; lon: number }): string {
  const pts = decodePolyline(encoded);
  const nearest = (p: { lat: number; lon: number }, startAt: number) => {
    let best = startAt;
    let bd = Infinity;
    for (let i = startAt; i < pts.length; i++) {
      const d = (pts[i][0] - p.lat) ** 2 + (pts[i][1] - p.lon) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const a = nearest(from, 0);
  const b = nearest(to, a);
  const part = pts.slice(a, b + 1);
  return encodePolyline([[from.lat, from.lon], ...part, [to.lat, to.lon]]);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

