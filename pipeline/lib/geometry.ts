import { distance, type LatLon } from './geo.ts';
import type { MlitSection } from './mlit.ts';

/**
 * A routable graph of one operator's tracks from MLIT N02, used to trace the
 * real alignment between two stations.
 */
export class TrackGraph {
  private nodes: [number, number][] = [];
  private index = new Map<string, number>();
  private adj: { to: number; w: number }[][] = [];
  private grid = new Map<string, number[]>();

  constructor(sections: MlitSection[]) {
    for (const s of sections) {
      let prev = -1;
      for (const p of s.coords) {
        const n = this.node(p);
        if (prev >= 0 && prev !== n) {
          const w = distance(this.pt(prev), this.pt(n));
          this.adj[prev].push({ to: n, w });
          this.adj[n].push({ to: prev, w });
        }
        prev = n;
      }
    }
    // Section ends that almost touch (data joins at junctions) get connected.
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.adj[i].length !== 1) continue;
      for (const j of this.near(this.pt(i), 25)) {
        if (j !== i && !this.adj[i].some((e) => e.to === j)) {
          const w = distance(this.pt(i), this.pt(j));
          this.adj[i].push({ to: j, w });
          this.adj[j].push({ to: i, w });
        }
      }
    }
  }

  private pt(i: number): LatLon {
    return { lat: this.nodes[i][0], lon: this.nodes[i][1] };
  }

  private cellKey(lat: number, lon: number) {
    return `${Math.floor(lat / 0.004)}|${Math.floor(lon / 0.005)}`;
  }

  private node([lat, lon]: [number, number]): number {
    const k = `${lat.toFixed(5)}|${lon.toFixed(5)}`;
    let i = this.index.get(k);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push([lat, lon]);
      this.adj.push([]);
      this.index.set(k, i);
      const c = this.cellKey(lat, lon);
      (this.grid.get(c) ?? this.grid.set(c, []).get(c)!).push(i);
    }
    return i;
  }

  /** Node indices within `radius` metres. */
  near(p: LatLon, radius: number): number[] {
    const out: number[] = [];
    const cy = Math.floor(p.lat / 0.004);
    const cx = Math.floor(p.lon / 0.005);
    const r = Math.ceil(radius / 400) + 1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const i of this.grid.get(`${cy + dy}|${cx + dx}`) ?? []) {
          if (distance(p, this.pt(i)) <= radius) out.push(i);
        }
      }
    }
    return out;
  }

  nearest(p: LatLon, radius = 500): number {
    let best = -1;
    let bestD = Infinity;
    for (const i of this.near(p, radius)) {
      const d = distance(p, this.pt(i));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Shortest track paths from one station to several others. Returns
   * [lat, lon] polylines that start and end at the stations themselves.
   */
  paths(from: LatLon, targets: LatLon[]): ([number, number][] | null)[] {
    const src = this.nearest(from);
    const result: ([number, number][] | null)[] = targets.map(() => null);
    if (src < 0) return result;
    const goal = new Map<number, number[]>();
    let maxStraight = 0;
    targets.forEach((t, k) => {
      const n = this.nearest(t);
      if (n < 0) return;
      (goal.get(n) ?? goal.set(n, []).get(n)!).push(k);
      maxStraight = Math.max(maxStraight, distance(from, t));
    });
    if (!goal.size) return result;
    const limit = Math.max(maxStraight * 2.5, maxStraight + 3000);
    const dist = new Map<number, number>([[src, 0]]);
    const prev = new Map<number, number>();
    // Binary heap of [dist, node].
    const heap: [number, number][] = [[0, src]];
    const push = (x: [number, number]) => {
      heap.push(x);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    let remaining = goal.size;
    while (heap.length && remaining) {
      const [d, u] = pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (d > limit) break;
      const ks = goal.get(u);
      if (ks) {
        remaining--;
        const path: [number, number][] = [];
        for (let x: number | undefined = u; x !== undefined; x = prev.get(x)) path.push(this.nodes[x]);
        path.reverse();
        for (const k of ks) {
          const t = targets[k];
          result[k] = [[from.lat, from.lon], ...path, [t.lat, t.lon]];
        }
      }
      for (const e of this.adj[u]) {
        const nd = d + e.w;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, u);
          push([nd, e.to]);
        }
      }
    }
    return result;
  }
}
