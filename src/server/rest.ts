import type { RestKind, RestStop, WalkSegment } from '../shared/api.ts';
import { toXY } from '../shared/proj.ts';
import type { Poi } from './access.ts';

/** POI kinds that count as a place to cool down, drink, sit or use a toilet. */
const KINDS: Record<string, RestKind> = {
  cooling: 'cooling',
  konbini: 'konbini',
  water: 'water',
  toilet: 'toilet',
  bench: 'bench',
  vending: 'vending',
  library: 'library',
  shelter: 'shelter',
};
/** How far off the walk each kind is still worth mentioning. */
const REACH: Record<RestKind, number> = { cooling: 120, library: 100, konbini: 60, water: 40, toilet: 60, bench: 25, vending: 25, shelter: 30 };
const CELL = 100;
const PRIORITY: RestKind[] = ['cooling', 'library', 'konbini', 'water', 'toilet', 'shelter', 'bench', 'vending'];

/** Rest stops near a walk, from a 100 m grid over the points of interest. */
export class RestIndex {
  private grid = new Map<string, Poi[]>();

  constructor(pois: Poi[]) {
    for (const p of pois) {
      if (!KINDS[p.kind]) continue;
      const k = `${Math.floor(p.x / CELL)}|${Math.floor(p.y / CELL)}`;
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(p);
    }
  }

  /** Points along the segments' lines, each listed once at the first minute it is passed. */
  along(segments: WalkSegment[], maxPerKind = 2, maxTotal = 6): RestStop[] {
    const found = new Map<Poi, RestStop>();
    let minute = 0;
    for (const seg of segments) {
      const n = seg.line.length;
      for (let i = 0; i < n; i++) {
        const [x, y] = toXY(seg.line[i][0], seg.line[i][1]);
        const at = minute + (seg.seconds / 60) * (n > 1 ? i / (n - 1) : 0);
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        for (let a = -1; a <= 1; a++)
          for (let b = -1; b <= 1; b++)
            for (const p of this.grid.get(`${cx + a}|${cy + b}`) ?? []) {
              const kind = KINDS[p.kind];
              const d = Math.hypot(p.x - x, p.y - y);
              if (d > REACH[kind]) continue;
              const prev = found.get(p);
              if (prev && prev.off <= d) continue;
              found.set(p, {
                kind,
                name: p.name ? { ja: String(p.name), en: String(p.name_en ?? p.name) } : undefined,
                lat: p.lat ?? 0,
                lon: p.lon ?? 0,
                off: Math.round(d),
                atMinute: prev?.atMinute ?? Math.round(at * 10) / 10,
                designated: kind === 'cooling' ? p.shelter === true : undefined,
                hours: (p.hours as string | undefined) ?? (p.opening_hours as string | undefined),
                stepFree: p.wheelchair === 'yes' ? true : undefined,
              });
            }
      }
      minute += seg.seconds / 60;
    }
    // A short, useful list: places to cool down first, then drinks and
    // toilets, then somewhere to sit; at most two of a kind.
    const byKind = new Map<RestKind, RestStop[]>();
    for (const r of found.values()) (byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!).push(r);
    const out: RestStop[] = [];
    for (const kind of PRIORITY) {
      const list = (byKind.get(kind) ?? []).sort((a, b) => Number(!!b.name) - Number(!!a.name) || a.off - b.off);
      // Spread them along the walk rather than bunching at one corner.
      const picked: RestStop[] = [];
      for (const r of list) {
        if (picked.length >= maxPerKind) break;
        if (picked.some((p) => Math.abs(p.atMinute - r.atMinute) < 2)) continue;
        picked.push(r);
      }
      out.push(...picked);
      if (out.length >= maxTotal) break;
    }
    return out.slice(0, maxTotal).sort((a, b) => a.atMinute - b.atMinute);
  }
}
