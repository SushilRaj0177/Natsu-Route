/**
 * RAPTOR (Delling, Pajor, Werneck — "Round-Based Public Transit Routing",
 * 2012). Round k finds the earliest arrival at every stop using at most k
 * trains. The result is the Pareto set over (arrival time, number of
 * trains): each extra train is only reported if it gets you there sooner.
 *
 * Times are seconds since the start of the service day.
 */
import type { Timetable } from './timetable.ts';

export interface RaptorQuery {
  sources: { stop: number; time: number }[];
  /** Stops to reach, each with the extra seconds it takes from there to the destination. */
  targets: { stop: number; extra: number }[];
  maxRounds: number;
  allowSurcharge: boolean;
  /** Extra seconds needed to change trains at the same stop. */
  minChangeSec: number;
}

export type RaptorLeg =
  | { kind: 'ride'; route: number; tripPos: number; board: number; alight: number; from: number; to: number; dep: number; arr: number }
  | { kind: 'walk'; from: number; to: number; dep: number; arr: number };

export interface RaptorJourney {
  trains: number;
  /** Arrival at the destination: at the final stop plus its extra seconds. */
  arr: number;
  /** Final stop reached by vehicle or walk link. */
  target: number;
  legs: RaptorLeg[];
}

const INF = 0x7fffffff;
const SOURCE = 1;
const RIDE = 2;
const WALK = 3;

export function raptor(tt: Timetable, q: RaptorQuery): RaptorJourney[] {
  const n = tt.nStops;
  const K = q.maxRounds;
  const label = new Int32Array((K + 1) * n).fill(INF);
  const kind = new Uint8Array((K + 1) * n);
  const pRoute = new Int32Array((K + 1) * n);
  const pTrip = new Int32Array((K + 1) * n);
  const pBoard = new Int32Array((K + 1) * n);
  const pAlight = new Int32Array((K + 1) * n);
  const pFrom = new Int32Array((K + 1) * n);
  const pRound = new Int8Array((K + 1) * n);

  const best = new Int32Array(n).fill(INF);
  const bestRound = new Int8Array(n).fill(-1);
  const prevBest = new Int32Array(n);
  const prevRound = new Int8Array(n);
  const extra = new Int32Array(n).fill(INF);
  for (const t of q.targets) extra[t.stop] = Math.min(extra[t.stop], t.extra);
  let targetBest = INF;

  let marked: number[] = [];
  const markedFlag = new Uint8Array(n);
  const mark = (s: number) => {
    if (!markedFlag[s]) {
      markedFlag[s] = 1;
      marked.push(s);
    }
  };
  const improve = (k: number, s: number, t: number) => {
    label[k * n + s] = t;
    best[s] = t;
    bestRound[s] = k;
    if (extra[s] !== INF && t + extra[s] < targetBest) targetBest = t + extra[s];
  };

  for (const { stop, time } of q.sources) {
    if (time < best[stop]) {
      improve(0, stop, time);
      kind[stop] = SOURCE;
      mark(stop);
    }
  }
  const walkFrom = (k: number, stops: number[]) => {
    for (const s of stops) {
      const base = label[k * n + s];
      for (let f = tt.footStart[s]; f < tt.footStart[s + 1]; f++) {
        const to = tt.footTo[f];
        const t = base + tt.footSec[f];
        if (t < best[to] && t < targetBest) {
          improve(k, to, t);
          kind[k * n + to] = WALK;
          pFrom[k * n + to] = s;
          mark(to);
        }
      }
    }
  };
  walkFrom(0, [...marked]);

  const routeFrom = new Int32Array(tt.nRoutes).fill(-1);
  for (let k = 1; k <= K && marked.length; k++) {
    // Boarding uses arrivals with at most k-1 trains, as they stood after round k-1.
    prevBest.set(best);
    prevRound.set(bestRound);
    const queue: number[] = [];
    for (const s of marked) {
      markedFlag[s] = 0;
      for (let x = tt.stopRouteStart[s]; x < tt.stopRouteStart[s + 1]; x++) {
        const r = tt.stopRoutes[x];
        if (!q.allowSurcharge && tt.routeSurcharge[r]) continue;
        const pos = tt.stopRoutePos[x];
        if (routeFrom[r] < 0) queue.push(r);
        if (routeFrom[r] < 0 || pos < routeFrom[r]) routeFrom[r] = pos;
      }
    }
    marked = [];

    for (const r of queue) {
      const first = routeFrom[r];
      routeFrom[r] = -1;
      const sStart = tt.routeStopStart[r];
      const len = tt.routeStopStart[r + 1] - sStart;
      const tBase = tt.timeStart[r];
      const nTrips = tt.routeTripStart[r + 1] - tt.routeTripStart[r];
      let trip = -1;
      let board = -1;
      let boardRound = 0;
      for (let i = first; i < len; i++) {
        const s = tt.routeStops[sStart + i];
        if (trip >= 0) {
          const a = tt.arr[tBase + trip * len + i];
          if (a < best[s] && a < targetBest) {
            improve(k, s, a);
            const idx = k * n + s;
            kind[idx] = RIDE;
            pRoute[idx] = r;
            pTrip[idx] = trip;
            pBoard[idx] = board;
            pAlight[idx] = i;
            pRound[idx] = boardRound;
            mark(s);
          }
        }
        if (i === len - 1) break;
        const reached = prevBest[s];
        if (reached === INF) continue;
        const rr = prevRound[s];
        const need = reached + (kind[rr * n + s] === RIDE ? q.minChangeSec : 0);
        // Earliest trip leaving stop i at or after `need`, earlier than the current one.
        let lo = 0;
        let hi = trip >= 0 ? trip : nTrips;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (tt.dep[tBase + mid * len + i] >= need) hi = mid;
          else lo = mid + 1;
        }
        if (lo < (trip >= 0 ? trip : nTrips)) {
          trip = lo;
          board = i;
          boardRound = rr;
        }
      }
    }
    const rode = [...marked];
    walkFrom(k, rode);
  }

  // Pareto set: one journey per number of trains that improves on fewer trains.
  const out: RaptorJourney[] = [];
  let bestSoFar = INF;
  for (let k = 0; k <= K; k++) {
    let arr = INF;
    let at = -1;
    for (const t of q.targets) {
      const v = label[k * n + t.stop];
      if (v !== INF && v + t.extra < arr) {
        arr = v + t.extra;
        at = t.stop;
      }
    }
    if (at < 0 || arr >= bestSoFar) continue;
    bestSoFar = arr;
    const legs: RaptorLeg[] = [];
    let rk = k;
    let s = at;
    for (let guard = 0; guard < 64; guard++) {
      const idx = rk * n + s;
      if (kind[idx] === SOURCE) break;
      if (kind[idx] === WALK) {
        const from = pFrom[idx];
        legs.push({ kind: 'walk', from, to: s, dep: label[rk * n + from], arr: label[idx] });
        s = from;
      } else if (kind[idx] === RIDE) {
        const r = pRoute[idx];
        const len = tt.routeStopStart[r + 1] - tt.routeStopStart[r];
        const base = tt.timeStart[r] + pTrip[idx] * len;
        const from = tt.routeStops[tt.routeStopStart[r] + pBoard[idx]];
        legs.push({
          kind: 'ride', route: r, tripPos: pTrip[idx], board: pBoard[idx], alight: pAlight[idx],
          from, to: s, dep: tt.dep[base + pBoard[idx]], arr: tt.arr[base + pAlight[idx]],
        });
        s = from;
        rk = pRound[idx];
      } else {
        throw new Error(`broken journey at stop ${s} round ${rk}`);
      }
    }
    legs.reverse();
    out.push({ trains: legs.filter((l) => l.kind === 'ride').length, arr, target: at, legs });
  }
  return out;
}
