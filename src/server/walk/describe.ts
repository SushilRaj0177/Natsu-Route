import type { Names } from '../../shared/network.ts';
import type { WalkSegment } from '../../shared/api.ts';
import { toLonLat } from '../../shared/proj.ts';
import { F_ELEVATOR, F_ESCALATOR, F_INDOOR, F_KERB, F_SHELTERED, F_STEEP, F_STEPS, F_UNDERGROUND, type WalkGraph } from './graph.ts';
import type { Walk, WalkStep } from './search.ts';

/**
 * Turns a walk's edge-by-edge steps into the stretches a person follows:
 * one street, one pavement, one kind of cover at a time, with the turn to
 * make at the start of each.
 */
export function describeWalk(g: WalkGraph, w: Walk, streetNames: { ja: string; en?: string | null }[]): WalkSegment[] {
  const out: WalkSegment[] = [];
  let prevHeading: number | null = null;
  for (const s of w.steps) {
    const line = stepLine(g, s);
    if (line.length < 2) continue;
    const flags = g.d.flags[s.edge];
    const shelter: WalkSegment['shelter'] =
      flags & F_UNDERGROUND ? 'underground' : flags & F_INDOOR ? 'indoor' : flags & F_SHELTERED ? 'covered' : undefined;
    const ni = g.d.name[s.edge];
    const name: Names | undefined = ni >= 0 ? { ja: streetNames[ni].ja, en: streetNames[ni].en || streetNames[ni].ja } : undefined;
    const metres = g.d.length[s.edge] * s.share;
    const startHeading = heading(line[0], line[1]);
    const endHeading = heading(line[line.length - 2], line[line.length - 1]);
    const turn = prevHeading === null ? undefined : turnOf(prevHeading, startHeading);
    prevHeading = endHeading;
    const last = out[out.length - 1];
    const sunShare = s.cost.unknown > 0 ? null : s.cost.time > 0 ? Math.min(1, s.cost.sun / Math.max(1, s.cost.open || s.cost.time)) : 0;
    const same =
      last &&
      (last.name?.ja ?? '') === (name?.ja ?? '') &&
      last.shelter === shelter &&
      !!last.stairs === !!(flags & F_STEPS) &&
      (turn === undefined || turn === 'straight' || turn === 'slight-left' || turn === 'slight-right') &&
      (last.side === s.cost.side || s.cost.side === 'either' || last.side === 'either');
    const lonlat = line.map(([x, y]) => toLonLat(x, y).map((v) => Math.round(v * 1e6) / 1e6) as [number, number]);
    if (same) {
      const t = last.seconds + s.cost.time;
      last.sun = last.sun === null || sunShare === null ? null : t > 0 ? (last.sun * last.seconds + sunShare * s.cost.time) / t : 0;
      last.metres += metres;
      last.seconds = t;
      last.sunSeconds += s.cost.sun;
      if (last.side === 'either') last.side = s.cost.side;
      if (flags & F_STEEP) last.steep = true;
      if (flags & F_KERB) last.kerb = true;
      last.signals = (last.signals ?? 0) + g.d.signals[s.edge] * s.share || undefined;
      last.line.push(...lonlat.slice(1));
      continue;
    }
    out.push({
      name,
      metres,
      seconds: s.cost.time,
      sunSeconds: s.cost.sun,
      side: s.cost.side,
      shelter,
      stairs: flags & F_STEPS ? true : undefined,
      escalator: flags & F_ESCALATOR ? true : undefined,
      elevator: flags & F_ELEVATOR ? true : undefined,
      steep: flags & F_STEEP ? true : undefined,
      kerb: flags & F_KERB ? true : undefined,
      signals: g.d.signals[s.edge] ? Math.round(g.d.signals[s.edge] * s.share) || undefined : undefined,
      turn,
      sun: sunShare,
      line: lonlat,
    });
  }
  for (const seg of out) {
    seg.metres = Math.round(seg.metres);
    seg.seconds = Math.round(seg.seconds);
    seg.sunSeconds = Math.round(seg.sunSeconds);
    if (seg.sun !== null) seg.sun = Math.round(seg.sun * 100) / 100;
  }
  // Tiny pieces (under 15 m) fold into their neighbour so directions stay readable.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].metres < 15 && !out[i].stairs && !out[i].elevator) {
      const p = out[i - 1];
      p.metres += out[i].metres;
      p.seconds += out[i].seconds;
      p.sunSeconds += out[i].sunSeconds;
      p.line.push(...out[i].line.slice(1));
      out.splice(i, 1);
    }
  }
  return out;
}

/** Points of the part of the edge a step covers, in walking order. */
export function stepLine(g: WalkGraph, s: WalkStep): [number, number][] {
  const full = g.polyline(s.edge);
  const len = g.d.length[s.edge];
  const a = Math.min(s.from, s.to);
  const b = Math.max(s.from, s.to);
  const out: [number, number][] = [];
  let acc = 0;
  const pa = g.pointAt(s.edge, a);
  out.push([pa.x, pa.y]);
  for (let i = 1; i < full.length; i++) {
    acc += Math.hypot(full[i][0] - full[i - 1][0], full[i][1] - full[i - 1][1]);
    if (acc > a + 0.01 && acc < b - 0.01) out.push(full[i]);
  }
  const pb = g.pointAt(s.edge, Math.min(b, len));
  out.push([pb.x, pb.y]);
  return s.from <= s.to ? out : out.reverse();
}

function heading(a: [number, number], b: [number, number]): number {
  return Math.atan2(b[0] - a[0], b[1] - a[1]) * (180 / Math.PI);
}

function turnOf(from: number, to: number): WalkSegment['turn'] {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  const a = Math.abs(d);
  if (a < 25) return 'straight';
  if (a > 155) return 'back';
  if (a < 60) return d > 0 ? 'slight-right' : 'slight-left';
  return d > 0 ? 'right' : 'left';
}
