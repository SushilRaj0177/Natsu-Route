import type { Names } from '../shared/network.ts';
import { toXY } from '../shared/proj.ts';
import type { Transit } from './transit.ts';
import { F_STEPS, type Snap, type WalkGraph } from './walk/graph.ts';
import { ROOF, type ShadeEngine } from './shade/casters.ts';

/** A point of interest from data/build/geo/pois.json. */
export interface Poi {
  kind: string;
  x: number;
  y: number;
  lon?: number;
  lat?: number;
  name?: string;
  name_en?: string;
  ref?: string;
  wheelchair?: string;
  shelter?: string | boolean;
  bench?: string;
  opening_hours?: string;
  src: string;
  [k: string]: unknown;
}

/** Where a walker joins a station or bus stop. */
export interface AccessPoint {
  stop: number;
  snap: Snap;
  /** Base seconds from the street to the platform or bus door (indoors for stations), at 1.2 m/s. */
  inner: number;
  /** The station entrance used, if known. */
  entrance?: { exit?: string; name?: Names; stepFree: boolean | null; lat: number; lon: number };
}

export interface PoleInfo {
  /** A roof over the stop: OpenStreetMap shelter=yes or a PLATEAU bus-stop roof. */
  sheltered: boolean | null;
  bench: boolean | null;
}

/** Street-to-platform time at a subway station (stairs or lifts down to the trains). */
const SUBWAY_INNER = 150;
const SURFACE_INNER = 90;
const SUBWAY_OPERATORS = new Set(['TokyoMetro', 'Toei']);
const SURFACE_TOEI = new Set(['Toei.Arakawa', 'Toei.NipporiToneri']);

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[ヶケが]/g, 'ケ')
    .replace(/[\s・〈〉<>()（）]/g, '')
    .replace(/駅.*$/, '');

/** "溜池山王駅(11)" -> { base: "溜池山王", exit: "11" } */
export function parseEntranceName(name: string | undefined, ref: string | undefined, nameEn: string | undefined): { base?: string; exit?: string } {
  if (!name && !ref) return {};
  const m = name ? /^(.+?)駅\s*[(（]?\s*([^()（）]*?)\s*[)）]?\s*$/.exec(name.normalize('NFKC')) : null;
  let exit = m?.[2] || ref || undefined;
  if (!exit && nameEn) exit = /Exit\s*([A-Za-z0-9-]+)/i.exec(nameEn)?.[1];
  if (exit) exit = exit.replace(/(番?出口|口)$/, '');
  return { base: m ? norm(m[1]) : name ? norm(name) : undefined, exit: exit || undefined };
}

/**
 * Links every station and bus stop to the walking network. Stations join
 * through their mapped entrances where OpenStreetMap has them (with the
 * exit number and whether it is step-free); otherwise through the street
 * nearest the station. Bus stops join at the kerb.
 */
export class AccessIndex {
  readonly points: AccessPoint[] = [];
  readonly byStop: number[][];
  readonly poles = new Map<number, PoleInfo>();
  /** Stations whose entrances were found in OpenStreetMap. */
  entranceStations = 0;

  constructor(transit: Transit, graph: WalkGraph, shade: ShadeEngine, pois: Poi[]) {
    const d = transit.data;
    this.byStop = d.stations.map(() => []);
    const walkable = (e: number) => (graph.d.flags[e] & F_STEPS) === 0;

    // Entrances grouped by the place (station group) they belong to.
    const entrances = pois.filter((p) => p.kind === 'subway_entrance');
    const placeByName = new Map<string, number[]>();
    d.places.forEach((p, i) => {
      const k = norm(p.name.ja);
      (placeByName.get(k) ?? placeByName.set(k, []).get(k)!).push(i);
    });
    const placeXY = d.places.map((p) => toXY(p.lon, p.lat));
    const entrancesOfPlace = new Map<number, { poi: Poi; exit?: string }[]>();
    for (const e of entrances) {
      const { base, exit } = parseEntranceName(e.name, e.ref, e.name_en);
      let place: number | undefined;
      let bestD = Infinity;
      const candidates = base ? placeByName.get(base) ?? [] : [];
      for (const pi of candidates) {
        const dd = Math.hypot(placeXY[pi][0] - e.x, placeXY[pi][1] - e.y);
        if (dd < 700 && dd < bestD) {
          bestD = dd;
          place = pi;
        }
      }
      if (place === undefined) {
        // Unnamed: the nearest railway place within 250 m.
        for (let pi = 0; pi < d.places.length; pi++) {
          const s0 = d.stations[d.places[pi].stations[0]];
          if (s0?.pole) continue;
          const dd = Math.hypot(placeXY[pi][0] - e.x, placeXY[pi][1] - e.y);
          if (dd < 250 && dd < bestD) {
            bestD = dd;
            place = pi;
          }
        }
      }
      if (place === undefined) continue;
      (entrancesOfPlace.get(place) ?? entrancesOfPlace.set(place, []).get(place)!).push({ poi: e, exit });
    }

    // OpenStreetMap bus stops, for shelters and benches.
    const osmStops = pois.filter((p) => p.kind === 'bus_stop');
    const stopGrid = new Map<string, Poi[]>();
    const cell = (x: number, y: number) => `${Math.floor(x / 50)}|${Math.floor(y / 50)}`;
    for (const p of osmStops) (stopGrid.get(cell(p.x, p.y)) ?? stopGrid.set(cell(p.x, p.y), []).get(cell(p.x, p.y))!).push(p);
    const nearOsmStop = (x: number, y: number) => {
      let best: Poi | undefined;
      let bd = 30;
      const cx = Math.floor(x / 50);
      const cy = Math.floor(y / 50);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (const p of stopGrid.get(`${cx + i}|${cy + j}`) ?? []) {
            const dd = Math.hypot(p.x - x, p.y - y);
            if (dd < bd) {
              bd = dd;
              best = p;
            }
          }
      return best;
    };

    d.stations.forEach((s, i) => {
      const [x, y] = toXY(s.lon, s.lat);
      if (s.pole) {
        const snap = graph.snap(x, y, 80, walkable) ?? graph.snap(x, y, 80);
        if (snap) this.add({ stop: i, snap, inner: 0 });
        const osm = nearOsmStop(x, y);
        const yes = (v: unknown) => (v === 'yes' ? true : v === 'no' ? false : null);
        const plateauRoof = shade.c.n > 0 && this.roofNear(shade, x, y);
        this.poles.set(i, {
          sheltered: plateauRoof ? true : yes(osm?.shelter),
          bench: yes(osm?.bench),
        });
        return;
      }
      const rw = d.railways[s.railway];
      const op = d.operators[rw.operator].id;
      const inner = SUBWAY_OPERATORS.has(op) && !SURFACE_TOEI.has(rw.id) ? SUBWAY_INNER : SURFACE_INNER;
      const ents = entrancesOfPlace.get(s.place) ?? [];
      if (ents.length) this.entranceStations++;
      for (const { poi, exit } of ents) {
        const snap = graph.snap(poi.x, poi.y, 60);
        if (!snap) continue;
        const stepFree = poi.wheelchair === 'yes' || poi.wheelchair === 'designated' || poi.wheelchair === 'limited' ? true : poi.wheelchair === 'no' ? false : null;
        this.add({
          stop: i,
          snap,
          inner,
          entrance: { exit, name: poi.name ? { ja: poi.name, en: poi.name_en ?? poi.name } : undefined, stepFree, lat: poi.lat ?? 0, lon: poi.lon ?? 0 },
        });
      }
      if (!ents.length) {
        const snap = graph.snap(x, y, 250);
        if (snap) this.add({ stop: i, snap, inner: inner + Math.round(snap.dist / 1.2) });
      }
    });
  }

  private add(p: AccessPoint) {
    this.byStop[p.stop].push(this.points.length);
    this.points.push(p);
  }

  /** A PLATEAU bus-stop roof (上屋) within 8 m. Roofs are few, so a scan over them is cheap. */
  private roofs: number[] | null = null;
  private roofNear(shade: ShadeEngine, x: number, y: number): boolean {
    const c = shade.c;
    if (!this.roofs) {
      this.roofs = [];
      for (let i = 0; i < c.n; i++) if (c.kind[i] === ROOF) this.roofs.push(i);
    }
    for (const i of this.roofs) {
      const b = 4 * i;
      if (x > c.bbox[b] - 8 && x < c.bbox[b + 2] + 8 && y > c.bbox[b + 1] - 8 && y < c.bbox[b + 3] + 8) return true;
    }
    return false;
  }
}
