import { F_ELEVATOR, F_ESCALATOR, F_SHELTERED, F_STEPS, type Snap, type WalkGraph } from './graph.ts';
import { sunBucket, type EdgeShade, type ExposureModel, type SunBucket } from './exposure.ts';

/**
 * What the walker wants from the walk.
 *  cool    avoid direct sun (summer)
 *  warm    seek it (winter)
 *  rain    stay under roofs
 *  neutral just be quick
 */
export type Preference = 'cool' | 'warm' | 'rain' | 'neutral';
export type StairsChoice = 'ok' | 'avoid' | 'never';

export interface WalkPrefs {
  /** Walking speed on the flat, m/s. */
  speed: number;
  stairs: StairsChoice;
  preference: Preference;
  /**
   * How many seconds of extra walking one second less of the unwanted
   * condition (sun, shade or rain) is worth. 0 = fastest path.
   */
  weight: number;
}

/** Average wait at a signalised crossing, in the open. */
export const SIGNAL_WAIT = 25;
/** Waiting for a lift and riding it. */
const LIFT_TIME = 45;

export interface StepCost {
  /** Seconds, including waits at crossings and lifts. */
  time: number;
  /** Seconds in direct sun. */
  sun: number;
  /** Seconds where the shade is unknown (outside the building data). */
  unknown: number;
  /** Seconds without a roof overhead. */
  open: number;
  /** Search cost: time plus the weighted unwanted exposure plus stair penalties. */
  cost: number;
  /** Pavement chosen for roads: the side the walker should use. */
  side: 'left' | 'right' | 'either';
}

/** Cost of walking `share` (0..1) of edge e, at the sun position b. */
export function stepCost(g: WalkGraph, x: ExposureModel, e: number, share: number, b: SunBucket, p: WalkPrefs, forward: boolean): StepCost | null {
  const d = g.d;
  const flags = d.flags[e];
  const len = d.length[e] * share;
  // Standing at an edge's end costs nothing, whatever kind of edge it is.
  if (len < 0.01) return { time: 0, sun: 0, unknown: 0, open: 0, cost: 0, side: 'either' };
  let walk: number;
  let penalty = 0;
  if (flags & F_STEPS) {
    if (p.stairs === 'never') return null;
    walk = len / (p.speed * 0.45);
    if (p.stairs === 'avoid') penalty = 120 + 4 * walk;
  } else if (flags & F_ESCALATOR) {
    walk = len / 0.5;
  } else {
    walk = len / p.speed;
  }
  let wait = 0;
  if (flags & F_ELEVATOR) wait += LIFT_TIME * share;
  const signals = d.signals[e] * share;
  wait += SIGNAL_WAIT * signals;
  const s: EdgeShade = x.edge(e, b);
  let shaded: number;
  let side: StepCost['side'] = 'either';
  // Shade along the direction of travel: the stored left/right are for u → v.
  const l = forward ? s.left : s.right;
  const r = forward ? s.right : s.left;
  if (s.sheltered) shaded = 1;
  else if (s.outside) shaded = 0;
  else if (!s.twoSides) shaded = (l + r) / 2;
  else if (p.preference === 'warm') {
    shaded = Math.min(l, r);
    side = Math.abs(l - r) < 0.15 ? 'either' : l < r ? 'left' : 'right';
  } else {
    shaded = Math.max(l, r);
    side = Math.abs(l - r) < 0.15 ? 'either' : l > r ? 'left' : 'right';
  }
  const outdoors = walk + (signals ? SIGNAL_WAIT * signals : 0);
  const sun = s.sheltered ? 0 : outdoors * (1 - shaded);
  const unknown = s.outside ? outdoors : 0;
  const open = flags & F_SHELTERED ? 0 : outdoors;
  const time = walk + wait;
  let unwanted = 0;
  if (p.preference === 'cool') unwanted = sun + 0.5 * unknown;
  else if (p.preference === 'warm') unwanted = outdoors - sun;
  else if (p.preference === 'rain') unwanted = open;
  return { time, sun, unknown, open, cost: time + p.weight * unwanted + penalty, side };
}

/** Labels of one walking search, per node. */
export interface WalkTree {
  origin: Snap;
  startMs: number;
  /** +1: walking forward in time from origin; -1: backward search to a destination. */
  direction: 1 | -1;
  prefs: WalkPrefs;
  cost: Float64Array;
  time: Float32Array;
  sun: Float32Array;
  unknown: Float32Array;
  /** Edge used to reach the node (-1 at a start node). */
  prev: Int32Array;
  /** Nodes reached, in settle order. */
  settled: number[];
}

class Heap {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2);
      nk.set(this.keys);
      this.keys = nk;
      const nv = new Int32Array(this.size * 2);
      nv.set(this.vals);
      this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= k) break;
      this.keys[i] = this.keys[parent];
      this.vals[i] = this.vals[parent];
      i = parent;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }
  pop(): number {
    const top = this.vals[0];
    const k = this.keys[--this.size];
    const v = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = k;
    this.vals[i] = v;
    return top;
  }
  topKey(): number {
    return this.keys[0];
  }
}

/**
 * Heat-aware walking search from one point (or, with direction -1, towards
 * one point), bounded by walking time. The sun position follows the walk's
 * clock: a 20-minute walk starting at 10:00 is shaded as at 10:00 near the
 * start and as at 10:20 near the end.
 */
export function walkSearch(
  g: WalkGraph,
  x: ExposureModel,
  origin: Snap,
  startMs: number,
  prefs: WalkPrefs,
  maxSeconds: number,
  direction: 1 | -1 = 1,
): WalkTree {
  const n = g.nNodes;
  const cost = new Float64Array(n).fill(Infinity);
  const time = new Float32Array(n);
  const sun = new Float32Array(n);
  const unknown = new Float32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const settled: number[] = [];
  const heap = new Heap();
  const bucketAt = (sec: number) => sunBucket(startMs + direction * sec * 1000);

  // The origin sits partway along an edge: start from both of its ends.
  const e0 = origin.edge;
  const len0 = g.d.length[e0];
  const b0 = bucketAt(0);
  for (const [node, share, fwd] of [
    [g.d.u[e0], len0 > 0 ? origin.along / len0 : 0, false],
    [g.d.v[e0], len0 > 0 ? 1 - origin.along / len0 : 0, true],
  ] as const) {
    const c = stepCost(g, x, e0, share, b0, prefs, direction === 1 ? fwd : !fwd);
    if (!c) continue;
    if (c.cost < cost[node]) {
      cost[node] = c.cost;
      time[node] = c.time;
      sun[node] = c.sun;
      unknown[node] = c.unknown;
      prev[node] = -1;
      heap.push(c.cost, node);
    }
  }

  while (heap.size) {
    const node = heap.pop();
    if (done[node]) continue;
    done[node] = 1;
    settled.push(node);
    if (time[node] > maxSeconds) continue;
    const b = bucketAt(time[node]);
    for (let k = g.adjStart[node], end = g.adjStart[node + 1]; k < end; k++) {
      const e = g.adjEdge[k];
      const next = g.other(e, node);
      if (done[next]) continue;
      // Walking forward in time we go node → next; searching backward from a
      // destination, the walker actually goes next → node.
      const fromU = g.d.u[e] === node;
      const forward = direction === 1 ? fromU : !fromU;
      const c = stepCost(g, x, e, 1, b, prefs, forward);
      if (!c) continue;
      const nc = cost[node] + c.cost;
      if (nc < cost[next]) {
        cost[next] = nc;
        time[next] = time[node] + c.time;
        sun[next] = sun[node] + c.sun;
        unknown[next] = unknown[node] + c.unknown;
        prev[next] = e;
        heap.push(nc, next);
      }
    }
  }
  return { origin, startMs, direction, prefs, cost, time, sun, unknown, prev, settled };
}

/** One stretch of a walk, in walking order. */
export interface WalkStep {
  edge: number;
  /** Walking from the edge's u end towards v. */
  forward: boolean;
  /** Share of the edge walked (partial at the ends). */
  share: number;
  /** Metres along the edge from u where this step starts and ends. */
  from: number;
  to: number;
  cost: StepCost;
  /** Seconds after the walk's start at which the step begins. */
  at: number;
}

export interface Walk {
  steps: WalkStep[];
  time: number;
  sun: number;
  unknown: number;
  open: number;
  cost: number;
  metres: number;
}

/**
 * The walk from a search's origin to a point on the network, in walking
 * order (for a backward search, from the point to the search's origin).
 */
export function walkTo(g: WalkGraph, x: ExposureModel, tree: WalkTree, target: Snap): Walk | null {
  const e = target.edge;
  const len = g.d.length[e];
  const p = tree.prefs;
  // Through whichever end of the target edge is cheaper...
  let best: { node: number; share: number; fwdIntoTarget: boolean; total: number } | null = null;
  const b0 = sunBucket(tree.startMs);
  for (const [node, share, fwdIntoTarget] of [
    [g.d.u[e], len > 0 ? target.along / len : 0, true],
    [g.d.v[e], len > 0 ? 1 - target.along / len : 0, false],
  ] as const) {
    if (!Number.isFinite(tree.cost[node])) continue;
    const last = stepCost(g, x, e, share, b0, p, tree.direction === 1 ? fwdIntoTarget : !fwdIntoTarget);
    if (!last) continue;
    const total = tree.cost[node] + last.cost;
    if (!best || total < best.total) best = { node, share, fwdIntoTarget, total };
  }
  // ...or, on the origin's own edge, straight along it if that is cheaper.
  if (e === tree.origin.edge) {
    const a = tree.origin.along;
    const bAlong = target.along;
    const fwdPath = bAlong >= a;
    const share = len > 0 ? Math.abs(bAlong - a) / len : 0;
    const fwd = tree.direction === 1 ? fwdPath : !fwdPath;
    const c = stepCost(g, x, e, share, b0, p, fwd);
    if (c && (!best || c.cost <= best.total)) {
      const from = tree.direction === 1 ? a : bAlong;
      const to = tree.direction === 1 ? bAlong : a;
      return finish([{ edge: e, forward: fwd, share, from, to, cost: c, at: 0 }], g);
    }
  }
  if (!best) return null;
  // Chain of edges from the origin to best.node.
  const chain: { edge: number; towards: number }[] = [];
  let node = best.node;
  let guard = 0;
  while (tree.prev[node] !== -1 && guard++ < 1e6) {
    const pe = tree.prev[node];
    chain.push({ edge: pe, towards: node });
    node = g.other(pe, node);
  }
  chain.reverse();
  // `node` is now a start node: one of the origin edge's ends.
  const oe = tree.origin.edge;
  const oLen = g.d.length[oe];
  const steps: WalkStep[] = [];
  const startAtU = g.d.u[oe] === node;
  const firstShare = oLen > 0 ? (startAtU ? tree.origin.along / oLen : 1 - tree.origin.along / oLen) : 0;
  const pieces: { edge: number; forward: boolean; share: number; from: number; to: number }[] = [];
  if (firstShare > 0) pieces.push({ edge: oe, forward: !startAtU, share: firstShare, from: tree.origin.along, to: startAtU ? 0 : oLen });
  for (const c of chain) {
    const forward = g.d.v[c.edge] === c.towards;
    pieces.push({ edge: c.edge, forward, share: 1, from: forward ? 0 : g.d.length[c.edge], to: forward ? g.d.length[c.edge] : 0 });
  }
  if (best.share > 0) {
    pieces.push({ edge: e, forward: best.fwdIntoTarget, share: best.share, from: best.fwdIntoTarget ? 0 : len, to: target.along });
  }
  // A backward search found the path destination → origin: reverse it into walking order.
  const ordered =
    tree.direction === 1
      ? pieces
      : pieces.reverse().map((q) => ({ ...q, forward: !q.forward, from: q.to, to: q.from }));
  if (tree.direction === 1) {
    let t = 0;
    for (const q of ordered) {
      const c = stepCost(g, x, q.edge, q.share, sunBucket(tree.startMs + t * 1000), p, q.forward);
      if (!c) return null;
      steps.push({ ...q, cost: c, at: t });
      t += c.time;
    }
  } else {
    // The walk ends at the search's reference time: shade each step as at
    // the time it is walked, counting back from the end.
    const costs: StepCost[] = new Array(ordered.length);
    let back = 0;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const c = stepCost(g, x, ordered[i].edge, ordered[i].share, sunBucket(tree.startMs - back * 1000), p, ordered[i].forward);
      if (!c) return null;
      costs[i] = c;
      back += c.time;
    }
    let t = 0;
    ordered.forEach((q, i) => {
      steps.push({ ...q, cost: costs[i], at: t });
      t += costs[i].time;
    });
  }
  return finish(steps, g);
}

function finish(steps: WalkStep[], g: WalkGraph): Walk {
  let time = 0, sun = 0, unknown = 0, open = 0, cost = 0, metres = 0;
  for (const s of steps) {
    time += s.cost.time;
    sun += s.cost.sun;
    unknown += s.cost.unknown;
    open += s.cost.open;
    cost += s.cost.cost;
    metres += g.d.length[s.edge] * s.share;
  }
  return { steps, time, sun, unknown, open, cost, metres };
}

/**
 * Cost, time and sun to reach a point partway along an edge, from a
 * finished search, without rebuilding the path.
 */
export function labelAtSnap(g: WalkGraph, x: ExposureModel, tree: WalkTree, target: Snap): { cost: number; time: number; sun: number; unknown: number } | null {
  const e = target.edge;
  const len = g.d.length[e];
  let best: { cost: number; time: number; sun: number; unknown: number } | null = null;
  for (const [node, share, fwdIntoTarget] of [
    [g.d.u[e], len > 0 ? target.along / len : 0, true],
    [g.d.v[e], len > 0 ? 1 - target.along / len : 0, false],
  ] as const) {
    if (!Number.isFinite(tree.cost[node])) continue;
    const b = sunBucket(tree.startMs + tree.direction * tree.time[node] * 1000);
    const c = stepCost(g, x, e, share, b, tree.prefs, tree.direction === 1 ? fwdIntoTarget : !fwdIntoTarget);
    if (!c) continue;
    const cost = tree.cost[node] + c.cost;
    if (!best || cost < best.cost) best = { cost, time: tree.time[node] + c.time, sun: tree.sun[node] + c.sun, unknown: tree.unknown[node] + c.unknown };
  }
  if (e === tree.origin.edge) {
    const len0 = g.d.length[e];
    const share = len0 > 0 ? Math.abs(target.along - tree.origin.along) / len0 : 0;
    const fwdPath = target.along >= tree.origin.along;
    const c = stepCost(g, x, e, share, sunBucket(tree.startMs), tree.prefs, tree.direction === 1 ? fwdPath : !fwdPath);
    if (c && (!best || c.cost < best.cost)) best = { cost: c.cost, time: c.time, sun: c.sun, unknown: c.unknown };
  }
  return best;
}

/** The same path walked starting at another moment: shade follows the sun. */
export function recost(g: WalkGraph, x: ExposureModel, w: Walk, startMs: number, prefs: WalkPrefs): Walk {
  const steps: WalkStep[] = [];
  let t = 0;
  for (const s of w.steps) {
    const c = stepCost(g, x, s.edge, s.share, sunBucket(startMs + t * 1000), prefs, s.forward) ?? s.cost;
    steps.push({ ...s, cost: c, at: t });
    t += c.time;
  }
  return finish(steps, g);
}
