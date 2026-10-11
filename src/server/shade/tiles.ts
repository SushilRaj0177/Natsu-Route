import { deflateSync } from 'node:zlib';
import { toXY } from '../../shared/proj.ts';
import { BUILDING, TREE, OSM_TREE, type ShadeEngine } from './casters.ts';
import type { SunVector } from './sun.ts';

/**
 * Map tiles of the shade on the ground at one moment, drawn from the same
 * buildings, trees and decks the router uses. Each caster's shadow is the
 * area its outline sweeps when pushed away from the sun from the bottom to
 * the top of its height band; filling those areas into one mask merges
 * overlapping shadows. Building outlines are then cleared, so what remains
 * is shade on streets, pavements and open ground.
 */
const SIZE = 256;
const MAX_SHADOW = 500;

export interface TileStyle {
  /** RGB of the shade. */
  color: [number, number, number];
  /** Opacity of full shade, 0..1. */
  alpha: number;
}

export function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lon0 = (x / n) * 360 - 180;
  const lon1 = ((x + 1) / n) * 360 - 180;
  const lat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return { lon0, lon1, lat0: lat(y + 1), lat1: lat(y) };
}

export function renderShadeTile(shade: ShadeEngine, z: number, tx: number, ty: number, sun: SunVector, style: TileStyle): Buffer {
  const mask = new Float32Array(SIZE * SIZE);
  if (sun.up) {
    const b = tileBounds(z, tx, ty);
    const [X0, Y0] = toXY(b.lon0, b.lat0);
    const [X1, Y1] = toXY(b.lon1, b.lat1);
    const sx = SIZE / (X1 - X0);
    const sy = SIZE / (Y1 - Y0);
    const px = (x: number) => (x - X0) * sx;
    const py = (y: number) => (Y1 - y) * sy;
    // Shadow offset per metre of height, pointing away from the sun.
    const vx = -sun.dx / sun.tanEl;
    const vy = -sun.dy / sun.tanEl;
    const reach = Math.min(MAX_SHADOW, shade.heightNear((X0 + X1) / 2, (Y0 + Y1) / 2) / sun.tanEl);
    const c = shade.c;
    const buildings: number[] = [];
    const poly = new Float64Array(2048);
    const quad = new Float64Array(8);
    // Casters up to `reach` metres towards the sun can throw shade into the tile.
    const ox = sun.dx * reach;
    const oy = sun.dy * reach;
    shade.forEachInBox(Math.min(X0, X0 + ox) - 10, Math.min(Y0, Y0 + oy) - 10, Math.max(X1, X1 + ox) + 10, Math.max(Y1, Y1 + oy) + 10, (i) => {
      const k = c.kind[i];
      const start = c.ringStart[i];
      const len = c.ringLen[i];
      const zlo = c.zlo[i];
      const zhi = c.zhi[i];
      const a = k === TREE ? 0.75 : k === OSM_TREE ? 0.6 : 1;
      if (k === BUILDING) buildings.push(i);
      const n = Math.min(len, 1000);
      // Bottom and top of the swept band, then each side's sweep.
      for (const h of [zlo, zhi]) {
        for (let j = 0; j < n; j++) {
          poly[2 * j] = px(c.coords[2 * (start + j)] + vx * h);
          poly[2 * j + 1] = py(c.coords[2 * (start + j) + 1] + vy * h);
        }
        fill(mask, poly, n, a);
      }
      for (let j = 0; j < n; j++) {
        const j2 = j + 1 === n ? 0 : j + 1;
        const ax = c.coords[2 * (start + j)];
        const ay = c.coords[2 * (start + j) + 1];
        const bx = c.coords[2 * (start + j2)];
        const by = c.coords[2 * (start + j2) + 1];
        quad[0] = px(ax + vx * zlo);
        quad[1] = py(ay + vy * zlo);
        quad[2] = px(bx + vx * zlo);
        quad[3] = py(by + vy * zlo);
        quad[4] = px(bx + vx * zhi);
        quad[5] = py(by + vy * zhi);
        quad[6] = px(ax + vx * zhi);
        quad[7] = py(ay + vy * zhi);
        fill(mask, quad, 4, a);
      }
    });
    // Shade on rooftops is not where people walk: clear building outlines.
    for (const i of buildings) {
      const start = c.ringStart[i];
      const n = Math.min(c.ringLen[i], 1000);
      for (let j = 0; j < n; j++) {
        poly[2 * j] = px(c.coords[2 * (start + j)]);
        poly[2 * j + 1] = py(c.coords[2 * (start + j) + 1]);
      }
      fill(mask, poly, n, -1);
    }
  }
  return png(mask, style);
}

const xs = new Float64Array(4096);

/** Scanline fill. a > 0 raises the mask to a; a < 0 clears it. */
function fill(mask: Float32Array, p: Float64Array, n: number, a: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let j = 0; j < n; j++) {
    const y = p[2 * j + 1];
    const x = p[2 * j];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  if (maxY < 0 || minY >= SIZE || maxX < 0 || minX >= SIZE) return;
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(SIZE - 1, Math.ceil(maxY));
  for (let row = y0; row <= y1; row++) {
    const cy = row + 0.5;
    let m = 0;
    for (let j = 0, k = n - 1; j < n; k = j++) {
      const yj = p[2 * j + 1];
      const yk = p[2 * k + 1];
      if (yj > cy !== yk > cy) {
        xs[m++] = p[2 * j] + ((cy - yj) * (p[2 * k] - p[2 * j])) / (yk - yj);
      }
    }
    if (m < 2) continue;
    // insertion sort, m is small
    for (let i = 1; i < m; i++) {
      const v = xs[i];
      let j = i - 1;
      while (j >= 0 && xs[j] > v) {
        xs[j + 1] = xs[j];
        j--;
      }
      xs[j + 1] = v;
    }
    const base = row * SIZE;
    for (let i = 0; i + 1 < m; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(SIZE - 1, Math.floor(xs[i + 1] - 0.5));
      for (let col = xa; col <= xb; col++) {
        if (a < 0) mask[base + col] = 0;
        else if (mask[base + col] < a) mask[base + col] = a;
      }
    }
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(mask: Float32Array, style: TileStyle): Buffer {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  const [r, g, b] = style.color;
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < SIZE; x++) {
      const m = mask[y * SIZE + x];
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = Math.round(m * style.alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
