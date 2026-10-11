import { arr, readPack } from '../pack.ts';

/** Edge flags, shared with geo/osm.py. */
export const F_COVERED = 1 << 0;
export const F_INDOOR = 1 << 1;
export const F_UNDERGROUND = 1 << 2;
export const F_STEPS = 1 << 3;
export const F_ELEVATOR = 1 << 4;
export const F_ESCALATOR = 1 << 5;
export const F_SIGNAL = 1 << 6;
export const F_CROSSING = 1 << 7;
export const F_SIDEWALK_SEPARATE = 1 << 8;
export const F_FOOT_ONLY = 1 << 9;
export const F_BRIDGE = 1 << 10;
export const F_TUNNEL = 1 << 11;
export const F_RAMP = 1 << 12;
export const F_NO_SIDEWALK = 1 << 13;
/** From MLIT's walking-space data: slope over 5 %. */
export const F_STEEP = 1 << 14;
/** From MLIT's walking-space data: a step or kerb over 2 cm. */
export const F_KERB = 1 << 15;
/** Anything overhead that keeps off sun and rain. */
export const F_SHELTERED = F_COVERED | F_INDOOR | F_UNDERGROUND;

/** Road classes (geo/osm.py CLASS). 1-5 carry traffic; 6-8 are for people only. */
export const CLASS_FOOT = 6;

/** Typical carriageway width by class, where OSM has no width or lanes. */
const DEFAULT_WIDTH = [0, 20, 14, 10, 6, 4.5, 0, 0, 0];

export interface WalkData {
  nodeXY: Float32Array;
  u: Uint32Array;
  v: Uint32Array;
  length: Float32Array;
  flags: Uint16Array;
  cls: Uint8Array;
  width: Float32Array;
  name: Int32Array;
  signals: Uint8Array;
  gstart: Uint32Array;
  glen: Uint16Array;
  geom: Float32Array;
}

export function loadWalk(path: string): { data: WalkData; meta: Record<string, unknown> } {
  const p = readPack(path);
  return {
    meta: p.meta,
    data: {
      nodeXY: arr(p, 'node_xy', 'f4'),
      u: arr(p, 'u', 'u4'),
      v: arr(p, 'v', 'u4'),
      length: arr(p, 'length', 'f4'),
      flags: arr(p, 'flags', 'u2'),
      cls: arr(p, 'cls', 'u1'),
      width: arr(p, 'width', 'f4'),
      name: arr(p, 'name', 'i4'),
      signals: arr(p, 'signals', 'u1'),
      gstart: arr(p, 'gstart', 'u4'),
      glen: arr(p, 'glen', 'u2'),
      geom: arr(p, 'geom', 'f4'),
    },
  };
}

export interface Snap {
  edge: number;
  /** Metres from the edge's u end to the snapped point. */
  along: number;
  /** Distance from the query point to the edge. */
  dist: number;
  x: number;
  y: number;
}

const SNAP_CELL = 64;

/** The walking network with adjacency and a grid for snapping points to it. */
export class WalkGraph {
  readonly d: WalkData;
  readonly nNodes: number;
  readonly nEdges: number;
  readonly adjStart: Int32Array;
  readonly adjEdge: Int32Array;
  private gx0: number;
  private gy0: number;
  private gnx: number;
  private gny: number;
  private gridStart: Int32Array;
  private gridItems: Int32Array;

  constructor(d: WalkData) {
    this.d = d;
    this.nNodes = d.nodeXY.length / 2;
    this.nEdges = d.u.length;
    const deg = new Int32Array(this.nNodes + 1);
    for (let e = 0; e < this.nEdges; e++) {
      deg[d.u[e] + 1]++;
      deg[d.v[e] + 1]++;
    }
    for (let i = 0; i < this.nNodes; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjEdge = new Int32Array(deg[this.nNodes]);
    const fill = new Int32Array(this.nNodes);
    for (let e = 0; e < this.nEdges; e++) {
      this.adjEdge[deg[d.u[e]] + fill[d.u[e]]++] = e;
      this.adjEdge[deg[d.v[e]] + fill[d.v[e]]++] = e;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < d.nodeXY.length; i += 2) {
      if (d.nodeXY[i] < minX) minX = d.nodeXY[i];
      if (d.nodeXY[i] > maxX) maxX = d.nodeXY[i];
      if (d.nodeXY[i + 1] < minY) minY = d.nodeXY[i + 1];
      if (d.nodeXY[i + 1] > maxY) maxY = d.nodeXY[i + 1];
    }
    if (!this.nNodes) minX = minY = maxX = maxY = 0;
    this.gx0 = minX - SNAP_CELL;
    this.gy0 = minY - SNAP_CELL;
    this.gnx = Math.ceil((maxX - this.gx0) / SNAP_CELL) + 2;
    this.gny = Math.ceil((maxY - this.gy0) / SNAP_CELL) + 2;
    const cells = this.gnx * this.gny;
    const count = new Int32Array(cells + 1);
    const each = (e: number, f: (k: number) => void) => {
      let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
      for (let k = d.gstart[e], end = k + d.glen[e]; k < end; k++) {
        const x = d.geom[2 * k];
        const y = d.geom[2 * k + 1];
        if (x < ax) ax = x;
        if (x > bx) bx = x;
        if (y < ay) ay = y;
        if (y > by) by = y;
      }
      const cx0 = Math.floor((ax - this.gx0) / SNAP_CELL);
      const cy0 = Math.floor((ay - this.gy0) / SNAP_CELL);
      const cx1 = Math.floor((bx - this.gx0) / SNAP_CELL);
      const cy1 = Math.floor((by - this.gy0) / SNAP_CELL);
      for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) f(y * this.gnx + x);
    };
    for (let e = 0; e < this.nEdges; e++) each(e, (k) => count[k + 1]++);
    for (let k = 0; k < cells; k++) count[k + 1] += count[k];
    this.gridStart = count;
    this.gridItems = new Int32Array(count[cells]);
    const gfill = new Int32Array(cells);
    for (let e = 0; e < this.nEdges; e++) each(e, (k) => (this.gridItems[count[k] + gfill[k]++] = e));
  }

  other(e: number, node: number): number {
    return this.d.u[e] === node ? this.d.v[e] : this.d.u[e];
  }

  nodeX(n: number): number {
    return this.d.nodeXY[2 * n];
  }

  nodeY(n: number): number {
    return this.d.nodeXY[2 * n + 1];
  }

  /** Carriageway width used to place the pavements either side. */
  roadWidth(e: number): number {
    const w = this.d.width[e];
    return w > 0 ? w : DEFAULT_WIDTH[this.d.cls[e]] ?? 0;
  }

  /**
   * Nearest walkable edge to (x, y) within maxDist metres. `accept` can
   * exclude edges (for example steps, for someone who cannot use them).
   */
  snap(x: number, y: number, maxDist = 400, accept?: (e: number) => boolean): Snap | null {
    const d = this.d;
    let best: Snap | null = null;
    const r = Math.ceil(maxDist / SNAP_CELL);
    const cx = Math.floor((x - this.gx0) / SNAP_CELL);
    const cy = Math.floor((y - this.gy0) / SNAP_CELL);
    // Search rings outward; stop once the ring is farther than the best hit.
    const seen = new Set<number>();
    for (let ring = 0; ring <= r; ring++) {
      if (best && (ring - 1) * SNAP_CELL > best.dist) break;
      for (let yy = cy - ring; yy <= cy + ring; yy++) {
        for (let xx = cx - ring; xx <= cx + ring; xx++) {
          if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== ring) continue;
          if (xx < 0 || yy < 0 || xx >= this.gnx || yy >= this.gny) continue;
          const k = yy * this.gnx + xx;
          for (let j = this.gridStart[k]; j < this.gridStart[k + 1]; j++) {
            const e = this.gridItems[j];
            if (seen.has(e)) continue;
            seen.add(e);
            if (accept && !accept(e)) continue;
            let along = 0;
            for (let p = d.gstart[e], end = p + d.glen[e] - 1; p < end; p++) {
              const ax = d.geom[2 * p], ay = d.geom[2 * p + 1];
              const bx = d.geom[2 * p + 2], by = d.geom[2 * p + 3];
              const sx = bx - ax, sy = by - ay;
              const L2 = sx * sx + sy * sy;
              const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * sx + (y - ay) * sy) / L2)) : 0;
              const px = ax + t * sx, py = ay + t * sy;
              const dist = Math.hypot(x - px, y - py);
              const segLen = Math.sqrt(L2);
              if (dist <= maxDist && (!best || dist < best.dist)) best = { edge: e, along: along + t * segLen, dist, x: px, y: py };
              along += segLen;
            }
          }
        }
      }
    }
    return best;
  }

  /** Point at `along` metres from the u end, with the direction of travel there. */
  pointAt(e: number, along: number): { x: number; y: number; tx: number; ty: number } {
    const d = this.d;
    let acc = 0;
    const last = d.gstart[e] + d.glen[e] - 1;
    for (let p = d.gstart[e]; p < last; p++) {
      const ax = d.geom[2 * p], ay = d.geom[2 * p + 1];
      const bx = d.geom[2 * p + 2], by = d.geom[2 * p + 3];
      const seg = Math.hypot(bx - ax, by - ay);
      if (acc + seg >= along || p === last - 1) {
        const t = seg > 0 ? Math.max(0, Math.min(1, (along - acc) / seg)) : 0;
        return { x: ax + t * (bx - ax), y: ay + t * (by - ay), tx: seg > 0 ? (bx - ax) / seg : 1, ty: seg > 0 ? (by - ay) / seg : 0 };
      }
      acc += seg;
    }
    const p = d.gstart[e];
    return { x: d.geom[2 * p], y: d.geom[2 * p + 1], tx: 1, ty: 0 };
  }

  /** The edge's polyline as [x, y] pairs from u to v. */
  polyline(e: number): [number, number][] {
    const d = this.d;
    const out: [number, number][] = [];
    for (let p = d.gstart[e], end = p + d.glen[e]; p < end; p++) out.push([d.geom[2 * p], d.geom[2 * p + 1]]);
    return out;
  }
}
