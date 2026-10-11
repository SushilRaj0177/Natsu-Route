import { readFileSync } from 'node:fs';

/**
 * Reader for the typed-array container written by geo/packfile.py:
 * "NRPK", uint32 header length, JSON header, then 8-byte-aligned arrays.
 */
type Dtype = 'u1' | 'u2' | 'u4' | 'i1' | 'i2' | 'i4' | 'f4' | 'f8';

const CTORS = {
  u1: Uint8Array,
  u2: Uint16Array,
  u4: Uint32Array,
  i1: Int8Array,
  i2: Int16Array,
  i4: Int32Array,
  f4: Float32Array,
  f8: Float64Array,
} as const;

export interface Pack {
  meta: Record<string, unknown>;
  arrays: Record<string, { dtype: Dtype; shape: number[]; data: ArrayLike<number> & { length: number } }>;
}

export function readPack(path: string): Pack {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'NRPK') throw new Error(`${path}: not a pack file`);
  const n = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + n)) as {
    meta: Record<string, unknown>;
    arrays: Record<string, { dtype: Dtype; shape: number[]; offset: number }>;
  };
  // Copy into a fresh, aligned ArrayBuffer so typed views can sit on it.
  const base = 8 + n;
  const body = new ArrayBuffer(buf.length - base);
  new Uint8Array(body).set(buf.subarray(base));
  const arrays: Pack['arrays'] = {};
  for (const [name, e] of Object.entries(header.arrays)) {
    const Ctor = CTORS[e.dtype];
    const count = e.shape.reduce((a, b) => a * b, 1);
    arrays[name] = { dtype: e.dtype, shape: e.shape, data: new Ctor(body, e.offset, count) };
  }
  return { meta: header.meta, arrays };
}

export function arr<T extends keyof typeof CTORS>(p: Pack, name: string, dtype: T): InstanceType<(typeof CTORS)[T]> {
  const a = p.arrays[name];
  if (!a) throw new Error(`pack: missing array ${name}`);
  if (a.dtype !== dtype) throw new Error(`pack: ${name} is ${a.dtype}, expected ${dtype}`);
  return a.data as InstanceType<(typeof CTORS)[T]>;
}
