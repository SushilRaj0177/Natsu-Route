import { sunPosition, sunVector, type SunVector } from '../shade/sun.ts';
import type { ShadeEngine } from '../shade/casters.ts';
import { CLASS_FOOT, F_NO_SIDEWALK, F_SHELTERED, type WalkGraph } from './graph.ts';

/** Shade codes stored per edge side: 0..250 = shaded share × 250. */
const OUTSIDE = 253;
const UNKNOWN = 255;

/** Spacing of the sample points along an edge. */
const STEP = 10;

/** Shade on one stretch of path. */
export interface EdgeShade {
  /** Shaded share (0..1) along the left pavement, walking u → v. */
  left: number;
  /** Shaded share (0..1) along the right pavement. */
  right: number;
  /** Roofed, indoors or underground: no sun at all. */
  sheltered: boolean;
  /** Outside the area with building data: shade unknown. */
  outside: boolean;
  /** Pavements on both sides, so a walker can pick the shadier one. */
  twoSides: boolean;
}

/** Where the sun stands, rounded so nearby times share one cache entry. */
export interface SunBucket {
  key: string;
  sun: SunVector;
}

/** Tokyo's sun position at a moment, rounded to 2° of azimuth and 1° of elevation. */
export function sunBucket(ms: number): SunBucket {
  const p = sunPosition(ms, 35.68, 139.75);
  const az = Math.round(p.azimuth / 2) * 2;
  const el = Math.round(p.elevation);
  if (el <= 0) return { key: 'night', sun: sunVector({ azimuth: 0, elevation: -10 }) };
  return { key: `${az}|${el}`, sun: sunVector({ azimuth: az, elevation: el }) };
}

/**
 * Shade along every stretch of path for a given sun position, computed on
 * demand and kept for the most recent sun positions.
 *
 * Pavements run beside the road, not down its middle, and on a hot
 * afternoon the shady side can be a few metres from the sunny one. So for
 * roads each sample is taken on both pavements, set back from the centre
 * line by half the carriageway; footpaths are sampled on the line itself.
 * A sample that lands inside a building outline (the road was narrower than
 * assumed) is pulled back towards the centre line until it is outside.
 */
export class ExposureModel {
  private cache = new Map<string, Uint8Array>();
  private order: string[] = [];
  computed = 0;

  constructor(
    readonly graph: WalkGraph,
    readonly shade: ShadeEngine,
    private maxBuckets = 24,
  ) {}

  edge(e: number, b: SunBucket): EdgeShade {
    const g = this.graph;
    const flags = g.d.flags[e];
    const twoSides = g.d.cls[e] < CLASS_FOOT && (flags & F_NO_SIDEWALK) === 0;
    if (flags & F_SHELTERED) return { left: 1, right: 1, sheltered: true, outside: false, twoSides };
    if (b.key === 'night') return { left: 1, right: 1, sheltered: false, outside: false, twoSides };
    const codes = this.codes(b);
    if (codes[2 * e] === UNKNOWN) this.compute(e, b.sun, codes);
    const l = codes[2 * e];
    const r = codes[2 * e + 1];
    if (l === OUTSIDE) return { left: 0, right: 0, sheltered: false, outside: true, twoSides };
    return { left: l / 250, right: r / 250, sheltered: false, outside: false, twoSides };
  }

  /** Light (0..1) at a single spot, such as a bus stop. */
  lightAt(x: number, y: number, b: SunBucket): number {
    if (b.key === 'night') return 0;
    return this.shade.light(x, y, b.sun);
  }

  private codes(b: SunBucket): Uint8Array {
    let c = this.cache.get(b.key);
    if (!c) {
      c = new Uint8Array(2 * this.graph.nEdges).fill(UNKNOWN);
      this.cache.set(b.key, c);
      this.order.push(b.key);
      while (this.order.length > this.maxBuckets) this.cache.delete(this.order.shift()!);
    } else {
      // Most recently used goes to the back.
      const i = this.order.indexOf(b.key);
      if (i >= 0 && i !== this.order.length - 1) {
        this.order.splice(i, 1);
        this.order.push(b.key);
      }
    }
    return c;
  }

  private compute(e: number, sun: SunVector, codes: Uint8Array): void {
    this.computed++;
    const g = this.graph;
    const len = g.d.length[e];
    const mid = g.pointAt(e, len / 2);
    if (!this.shade.covers(mid.x, mid.y)) {
      codes[2 * e] = OUTSIDE;
      codes[2 * e + 1] = OUTSIDE;
      return;
    }
    const n = Math.max(1, Math.round(len / STEP));
    const road = g.d.cls[e] < CLASS_FOOT;
    const offset = road ? Math.max(1.2, g.roadWidth(e) / 2 + (g.d.cls[e] <= 3 ? 1.5 : -0.5)) : 0;
    let left = 0;
    let right = 0;
    for (let i = 0; i < n; i++) {
      const p = g.pointAt(e, ((i + 0.5) * len) / n);
      if (!road) {
        const s = 1 - this.shade.light(p.x, p.y, sun);
        left += s;
        right += s;
        continue;
      }
      // Left of travel is (-ty, tx).
      left += 1 - this.lightBeside(p.x, p.y, -p.ty, p.tx, offset, sun);
      right += 1 - this.lightBeside(p.x, p.y, p.ty, -p.tx, offset, sun);
    }
    codes[2 * e] = Math.round((250 * left) / n);
    codes[2 * e + 1] = Math.round((250 * right) / n);
  }

  private lightBeside(x: number, y: number, nx: number, ny: number, offset: number, sun: SunVector): number {
    for (const f of [1, 0.6, 0.3, 0]) {
      const px = x + nx * offset * f;
      const py = y + ny * offset * f;
      if (f === 0 || !this.shade.insideBuilding(px, py)) return this.shade.light(px, py, sun);
    }
    return this.shade.light(x, y, sun);
  }
}
