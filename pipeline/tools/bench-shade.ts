/**
 * Loads the real shade and walking data and times the parts a trip plan
 * uses: building the grid, single shade rays, and heat-aware walking
 * searches around a few Tokyo stations.
 *
 *   npx tsx pipeline/tools/bench-shade.ts
 */
import { loadCasters, ShadeEngine } from '../../src/server/shade/casters.ts';
import { loadWalk, WalkGraph } from '../../src/server/walk/graph.ts';
import { ExposureModel, sunBucket } from '../../src/server/walk/exposure.ts';
import { walkSearch, walkTo } from '../../src/server/walk/search.ts';
import { toXY } from '../../src/shared/proj.ts';

const GEO = new URL('../../data/build/geo/', import.meta.url).pathname;
const mem = () => `${Math.round(process.memoryUsage().rss / 1e6)} MB`;
let t = Date.now();
const lap = (label: string) => {
  console.log(`${label}: ${Date.now() - t} ms (${mem()})`);
  t = Date.now();
};

const casters = loadCasters(`${GEO}casters.pack`);
lap(`load casters (${casters.n})`);
const shade = new ShadeEngine(casters);
lap('grid');
const walk = loadWalk(`${GEO}walk.pack`);
const graph = new WalkGraph(walk.data);
lap(`walk graph (${graph.nEdges} edges)`);
const x = new ExposureModel(graph, shade);

const noon = Date.UTC(2026, 6, 22, 3, 0); // 22 Jul 2026 12:00 JST
const b = sunBucket(noon);
let lit = 0;
const N = 20000;
for (let i = 0; i < N; i++) {
  const e = Math.floor(Math.random() * graph.nEdges);
  const p = graph.pointAt(e, graph.d.length[e] / 2);
  lit += shade.light(p.x, p.y, b.sun);
}
lap(`${N} rays (mean light ${(lit / N).toFixed(2)})`);

const places: [string, number, number][] = [
  ['Shinjuku', 139.7006, 35.6905],
  ['Sugamo', 139.7393, 35.7334],
  ['Kita-Senju', 139.8048, 35.7497],
  ['Jiyugaoka', 139.6687, 35.6076],
];
for (const [name, lon, lat] of places) {
  const [px, py] = toXY(lon, lat);
  const snap = graph.snap(px, py)!;
  for (const weight of [0, 2.5]) {
    const before = x.computed;
    const tree = walkSearch(graph, x, snap, noon, { speed: 1.0, stairs: 'avoid', preference: 'cool', weight }, 900);
    const ms = Date.now() - t;
    const target = graph.snap(px + 500, py + 300)!;
    const w = walkTo(graph, x, tree, target);
    console.log(
      `${name} w=${weight}: ${ms} ms, ${tree.settled.length} nodes, ${x.computed - before} edges shaded; to +500/+300 m: ${Math.round(w?.time ?? 0)} s, sun ${Math.round(w?.sun ?? 0)} s`,
    );
    t = Date.now();
  }
}
console.log(`peak ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
