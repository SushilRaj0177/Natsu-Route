import { BUILDING, type CasterSet } from '../src/server/shade/casters.ts';

/** Casters from plain outlines, for tests. */
export function casters(items: { ring: [number, number][]; zlo?: number; zhi: number; kind?: number }[]): CasterSet {
  const coords: number[] = [];
  const ringStart: number[] = [];
  const ringLen: number[] = [];
  const bbox: number[] = [];
  for (const it of items) {
    ringStart.push(coords.length / 2);
    ringLen.push(it.ring.length);
    for (const [x, y] of it.ring) coords.push(x, y);
    const xs = it.ring.map((p) => p[0]);
    const ys = it.ring.map((p) => p[1]);
    bbox.push(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  }
  return {
    n: items.length,
    kind: Uint8Array.from(items.map((i) => i.kind ?? BUILDING)),
    zlo: Float32Array.from(items.map((i) => i.zlo ?? 0)),
    zhi: Float32Array.from(items.map((i) => i.zhi)),
    ringStart: Uint32Array.from(ringStart),
    ringLen: Uint16Array.from(ringLen),
    coords: Float32Array.from(coords),
    bbox: Float32Array.from(bbox),
    meta: {},
  };
}

