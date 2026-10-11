import { existsSync, readFileSync } from 'node:fs';
import { Transit } from './transit.ts';
import { loadCasters, ShadeEngine } from './shade/casters.ts';
import { loadWalk, WalkGraph } from './walk/graph.ts';
import { ExposureModel } from './walk/exposure.ts';
import { AccessIndex, type Poi } from './access.ts';
import { HeatService } from './heat.ts';
import { RestIndex } from './rest.ts';
import { Planner, type PlannerDeps } from './planner.ts';

export interface App extends PlannerDeps {
  planner: Planner;
  pois: Poi[];
  wards: unknown;
  geoMeta: { casters: Record<string, unknown>; walk: Record<string, unknown> };
}

/** Everything the server needs, from data/build. */
export function loadApp(dir: string, log: (msg: string) => void = () => {}): App {
  const t0 = Date.now();
  const step = (msg: string) => log(`[${((Date.now() - t0) / 1000).toFixed(1)}s ${Math.round(process.memoryUsage().rss / 1e6)} MB] ${msg}`);
  const transit = Transit.load(dir);
  step(`timetables: ${transit.data.stations.length} stops, ${transit.data.trips.length} trips`);
  const casters = loadCasters(`${dir}/geo/casters.pack`);
  const shade = new ShadeEngine(casters);
  step(`shade: ${casters.n} casters`);
  const walk = loadWalk(`${dir}/geo/walk.pack`);
  const graph = new WalkGraph(walk.data);
  step(`walking network: ${graph.nEdges} edges`);
  const pois = JSON.parse(readFileSync(`${dir}/geo/pois.json`, 'utf8')) as Poi[];
  const streetNames = JSON.parse(readFileSync(`${dir}/geo/street-names.json`, 'utf8')) as { ja: string; en?: string | null }[];
  const exposure = new ExposureModel(graph, shade);
  const access = new AccessIndex(transit, graph, shade, pois);
  step(`access: ${access.points.length} entry points (${access.entranceStations} stations with mapped entrances)`);
  const heat = new HeatService(`${dir}/heat-replay.json`);
  const rest = new RestIndex(pois);
  const wards = existsSync(`${dir}/geo/wards.geojson`) ? JSON.parse(readFileSync(`${dir}/geo/wards.geojson`, 'utf8')) : null;
  const deps: PlannerDeps = { transit, graph, exposure, access, heat, rest, streetNames };
  const planner = new Planner(deps);
  step('ready');
  return { ...deps, planner, pois, wards, geoMeta: { casters: casters.meta, walk: walk.meta } };
}
