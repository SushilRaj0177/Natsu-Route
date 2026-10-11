import { arr, readPack } from '../pack.ts';
import type { SunVector } from './sun.ts';

/** Caster kinds, shared with geo/pack.py. */
export const BUILDING = 0;
export const TREE = 1;
export const DECK = 2;
export const ROOF = 3;
export const OSM_TREE = 4;

/**
 * Share of direct sunlight each kind blocks. Buildings, elevated decks and
 * roofs block it all. Tree crowns let some through: PLATEAU trees are
 * surveyed crowns; OpenStreetMap trees often have a default crown size, so
 * they are trusted a little less.
 */
const OPACITY = [1, 0.8, 1, 0.95, 0.7];

/** Height of the body the sun falls on (a walking adult's chest). */
export const BODY_HEIGHT = 1.2;
const CELL = 24;
const COARSE = 8; // fine cells per coarse cell side (192 m)
const MAX_RAY = 600;

export interface CasterSet {
  n: number;
  kind: Uint8Array;
  zlo: Float32Array;
  zhi: Float32Array;
  ringStart: Uint32Array;
  ringLen: Uint16Array;
  coords: Float32Array;
  bbox: Float32Array;
  meta: Record<string, unknown>;
}

export function loadCasters(path: string): CasterSet {
  const p = readPack(path);
  const kind = arr(p, 'kind', 'u1');
  return {
    n: kind.length,
    kind,
    zlo: arr(p, 'zlo', 'f4'),
    zhi: arr(p, 'zhi', 'f4'),
    ringStart: arr(p, 'ring_start', 'u4'),
    ringLen: arr(p, 'ring_len', 'u2'),
    coords: arr(p, 'coords', 'f4'),
    bbox: arr(p, 'bbox', 'f4'),
    meta: p.meta,
  };
}

/**
 * Answers "how much direct sun reaches this spot right now?" by casting a
 * ray from the spot towards the sun through every building, tree, deck and
 * roof it passes. Casters sit in a 24 m grid; each cell also keeps its
 * tallest caster so a ray that has already climbed above the skyline stops
 * early.
 */
export class ShadeEngine {
  readonly c: CasterSet;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private cellMax: Float32Array;
  private coarseMax: Float32Array;
  private cnx: number;
  private cny: number;
  private seen: Uint32Array;
  private stamp = 0;
  private ts = new Float64Array(1024);

  constructor(c: CasterSet) {
    this.c = c;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < c.n; i++) {
      minX = Math.min(minX, c.bbox[4 * i]);
      minY = Math.min(minY, c.bbox[4 * i + 1]);
      maxX = Math.max(maxX, c.bbox[4 * i + 2]);
      maxY = Math.max(maxY, c.bbox[4 * i + 3]);
    }
    if (!c.n) minX = minY = maxX = maxY = 0;
    this.x0 = Math.floor(minX / CELL) * CELL - CELL;
    this.y0 = Math.floor(minY / CELL) * CELL - CELL;
    this.nx = Math.ceil((maxX - this.x0) / CELL) + 2;
    this.ny = Math.ceil((maxY - this.y0) / CELL) + 2;
    const cells = this.nx * this.ny;
    const count = new Int32Array(cells + 1);
    const span = (i: number) => {
      const ax = Math.max(0, Math.floor((c.bbox[4 * i] - this.x0) / CELL));
      const ay = Math.max(0, Math.floor((c.bbox[4 * i + 1] - this.y0) / CELL));
      const bx = Math.min(this.nx - 1, Math.floor((c.bbox[4 * i + 2] - this.x0) / CELL));
      const by = Math.min(this.ny - 1, Math.floor((c.bbox[4 * i + 3] - this.y0) / CELL));
      return [ax, ay, bx, by] as const;
    };
    for (let i = 0; i < c.n; i++) {
      const [ax, ay, bx, by] = span(i);
      for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) count[y * this.nx + x + 1]++;
    }
    for (let k = 0; k < cells; k++) count[k + 1] += count[k];
    this.cellStart = count;
    this.cellItems = new Int32Array(count[cells]);
    this.cellMax = new Float32Array(cells);
    const fill = new Int32Array(cells);
    for (let i = 0; i < c.n; i++) {
      const [ax, ay, bx, by] = span(i);
      for (let y = ay; y <= by; y++)
        for (let x = ax; x <= bx; x++) {
          const k = y * this.nx + x;
          this.cellItems[count[k] + fill[k]++] = i;
          if (c.zhi[i] > this.cellMax[k]) this.cellMax[k] = c.zhi[i];
        }
    }
    this.cnx = Math.ceil(this.nx / COARSE);
    this.cny = Math.ceil(this.ny / COARSE);
    this.coarseMax = new Float32Array(this.cnx * this.cny);
    for (let y = 0; y < this.ny; y++)
      for (let x = 0; x < this.nx; x++) {
        const k = ((y / COARSE) | 0) * this.cnx + ((x / COARSE) | 0);
        const h = this.cellMax[y * this.nx + x];
        if (h > this.coarseMax[k]) this.coarseMax[k] = h;
      }
    this.seen = new Uint32Array(c.n);
  }

  /** Whether (x, y) lies inside the data's extent at all. */
  covers(x: number, y: number): boolean {
    return x > this.x0 && y > this.y0 && x < this.x0 + this.nx * CELL && y < this.y0 + this.ny * CELL;
  }

  /**
   * Fraction of direct sun reaching a body at (x, y): 1 in full sun, 0 in
   * full shade, in between under trees. 0 when the sun is down.
   */
  light(x: number, y: number, sun: SunVector, body = BODY_HEIGHT): number {
    if (!sun.up) return 0;
    const H = this.tallestNear(x, y);
    if (H <= body) return 1;
    const L = Math.min(MAX_RAY, (H - body) / sun.tanEl);
    const c = this.c;
    const stamp = ++this.stamp;
    if (stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    let transmit = 1;

    // A spot just outside the grid can still be shaded by casters inside it:
    // start where the ray enters the grid.
    const gx1 = this.x0 + this.nx * CELL;
    const gy1 = this.y0 + this.ny * CELL;
    let t = 0;
    if (!this.covers(x, y)) {
      t = rayEntry(x, y, sun.dx, sun.dy, this.x0 + 1e-6, this.y0 + 1e-6, gx1 - 1e-6, gy1 - 1e-6);
      if (t < 0 || t > L) return 1;
    }
    // Walk the grid cells the ray crosses (Amanatides & Woo).
    const fx = (x + sun.dx * t - this.x0) / CELL;
    const fy = (y + sun.dy * t - this.y0) / CELL;
    let cx = Math.floor(fx);
    let cy = Math.floor(fy);
    const stepX = sun.dx > 0 ? 1 : -1;
    const stepY = sun.dy > 0 ? 1 : -1;
    const tDeltaX = sun.dx !== 0 ? Math.abs(CELL / sun.dx) : Infinity;
    const tDeltaY = sun.dy !== 0 ? Math.abs(CELL / sun.dy) : Infinity;
    let tMaxX = sun.dx !== 0 ? t + ((sun.dx > 0 ? cx + 1 - fx : fx - cx) * CELL) / Math.abs(sun.dx) : Infinity;
    let tMaxY = sun.dy !== 0 ? t + ((sun.dy > 0 ? cy + 1 - fy : fy - cy) * CELL) / Math.abs(sun.dy) : Infinity;
    let tEnter = t;
    while (tEnter <= L) {
      if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) break;
      const k = cy * this.nx + cx;
      const rayZ = body + tEnter * sun.tanEl;
      if (this.cellMax[k] > rayZ) {
        for (let j = this.cellStart[k], end = this.cellStart[k + 1]; j < end; j++) {
          const i = this.cellItems[j];
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          if (c.zhi[i] <= rayZ) continue;
          if (this.blocks(i, x, y, sun, body, L)) {
            transmit *= 1 - OPACITY[c.kind[i]];
            if (transmit < 0.03) return 0;
          }
        }
      }
      if (tMaxX < tMaxY) {
        tEnter = tMaxX;
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tEnter = tMaxY;
        tMaxY += tDeltaY;
        cy += stepY;
      }
    }
    return transmit;
  }

  /** Calls fn once for every caster whose bounding box meets the box. */
  forEachInBox(minX: number, minY: number, maxX: number, maxY: number, fn: (i: number) => void): void {
    const ax = Math.max(0, Math.floor((minX - this.x0) / CELL));
    const ay = Math.max(0, Math.floor((minY - this.y0) / CELL));
    const bx = Math.min(this.nx - 1, Math.floor((maxX - this.x0) / CELL));
    const by = Math.min(this.ny - 1, Math.floor((maxY - this.y0) / CELL));
    const stamp = ++this.stamp;
    const c = this.c;
    for (let y = ay; y <= by; y++)
      for (let x = ax; x <= bx; x++) {
        const k = y * this.nx + x;
        for (let j = this.cellStart[k], end = this.cellStart[k + 1]; j < end; j++) {
          const i = this.cellItems[j];
          if (this.seen[i] === stamp) continue;
          this.seen[i] = stamp;
          const b = 4 * i;
          if (c.bbox[b + 2] < minX || c.bbox[b] > maxX || c.bbox[b + 3] < minY || c.bbox[b + 1] > maxY) continue;
          fn(i);
        }
      }
  }

  /** Tallest caster near a point (about 1 km around). */
  heightNear(x: number, y: number): number {
    return this.tallestNear(x, y);
  }

  /** Is (x, y) inside a building outline? Used to keep pavement samples out of walls. */
  insideBuilding(x: number, y: number): boolean {
    const cx = Math.floor((x - this.x0) / CELL);
    const cy = Math.floor((y - this.y0) / CELL);
    if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) return false;
    const k = cy * this.nx + cx;
    const c = this.c;
    for (let j = this.cellStart[k], end = this.cellStart[k + 1]; j < end; j++) {
      const i = this.cellItems[j];
      if (c.kind[i] !== BUILDING) continue;
      const b = 4 * i;
      if (x < c.bbox[b] || x > c.bbox[b + 2] || y < c.bbox[b + 1] || y > c.bbox[b + 3]) continue;
      if (pointInRing(c.coords, c.ringStart[i], c.ringLen[i], x, y)) return true;
    }
    return false;
  }

  /** Tallest caster within ~5 coarse cells (about 1 km across). */
  private tallestNear(x: number, y: number): number {
    const cx = Math.floor((x - this.x0) / CELL / COARSE);
    const cy = Math.floor((y - this.y0) / CELL / COARSE);
    let h = 0;
    for (let yy = cy - 2; yy <= cy + 2; yy++) {
      if (yy < 0 || yy >= this.cny) continue;
      for (let xx = cx - 2; xx <= cx + 2; xx++) {
        if (xx < 0 || xx >= this.cnx) continue;
        const v = this.coarseMax[yy * this.cnx + xx];
        if (v > h) h = v;
      }
    }
    return h;
  }

  /**
   * Does the ray from (x, y, body) towards the sun pass through caster i's
   * height band while inside its outline?
   */
  private blocks(i: number, x: number, y: number, sun: SunVector, body: number, L: number): boolean {
    const c = this.c;
    const b = 4 * i;
    // Ray vs bounding box first.
    if (!rayHitsBox(x, y, sun.dx, sun.dy, L, c.bbox[b], c.bbox[b + 1], c.bbox[b + 2], c.bbox[b + 3])) return false;
    const start = c.ringStart[i];
    const len = c.ringLen[i];
    const ts = len * 2 > this.ts.length ? new Float64Array(len * 2) : this.ts;
    let n = 0;
    for (let k = 0; k < len; k++) {
      const ax = c.coords[2 * (start + k)];
      const ay = c.coords[2 * (start + k) + 1];
      const k2 = k + 1 === len ? 0 : k + 1;
      const bx = c.coords[2 * (start + k2)];
      const by = c.coords[2 * (start + k2) + 1];
      const ex = bx - ax;
      const ey = by - ay;
      const denom = sun.dx * ey - sun.dy * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const wx = ax - x;
      const wy = ay - y;
      const t = (wx * ey - wy * ex) / denom;
      const s = (wx * sun.dy - wy * sun.dx) / denom;
      if (s >= 0 && s < 1 && t >= 0) ts[n++] = t;
    }
    if (n === 0) return false;
    sortSmall(ts, n);
    // Odd number of crossings ahead means the spot itself is inside.
    const inside = n % 2 === 1;
    const tan = sun.tanEl;
    const zlo = c.zlo[i];
    const zhi = c.zhi[i];
    let k = 0;
    let t0 = 0;
    if (!inside) t0 = ts[k++];
    while (k <= n) {
      const t1 = k < n ? ts[k] : Infinity;
      if (t0 > L) break;
      const h0 = body + t0 * tan;
      const h1 = body + Math.min(t1, L) * tan;
      if (h0 <= zhi && h1 >= zlo) return true;
      k++;
      if (k >= n) break;
      t0 = ts[k++];
    }
    return false;
  }
}

/** Distance along the ray to where it enters the box, or -1 if it misses. */
function rayEntry(x: number, y: number, dx: number, dy: number, minX: number, minY: number, maxX: number, maxY: number): number {
  let tmin = 0;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-12) {
    if (x < minX || x > maxX) return -1;
  } else {
    const t1 = (minX - x) / dx;
    const t2 = (maxX - x) / dx;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  if (Math.abs(dy) < 1e-12) {
    if (y < minY || y > maxY) return -1;
  } else {
    const t1 = (minY - y) / dy;
    const t2 = (maxY - y) / dy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmin <= tmax ? tmin : -1;
}

function rayHitsBox(x: number, y: number, dx: number, dy: number, L: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
  let tmin = 0;
  let tmax = L;
  if (Math.abs(dx) < 1e-12) {
    if (x < minX || x > maxX) return false;
  } else {
    let t1 = (minX - x) / dx;
    let t2 = (maxX - x) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-12) {
    if (y < minY || y > maxY) return false;
  } else {
    let t1 = (minY - y) / dy;
    let t2 = (maxY - y) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

export function pointInRing(coords: Float32Array, start: number, len: number, x: number, y: number): boolean {
  let inside = false;
  for (let k = 0, j = len - 1; k < len; j = k++) {
    const xi = coords[2 * (start + k)];
    const yi = coords[2 * (start + k) + 1];
    const xj = coords[2 * (start + j)];
    const yj = coords[2 * (start + j) + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sortSmall(a: Float64Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= 0 && a[j] > v) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = v;
  }
}
