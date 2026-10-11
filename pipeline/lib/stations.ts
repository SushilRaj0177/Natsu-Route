import { local, type Multilingual, type OdptRailway, type OdptStation } from './odpt.ts';
import { distance, type LatLon } from './geo.ts';
import { MLIT_OPERATOR, type MlitStation } from './mlit.ts';
import type { CoordSource, Names } from '../../src/shared/network.ts';

export interface StationDraft {
  id: string;
  operator: string;
  railway: string;
  name: Names;
  code?: string;
  lat?: number;
  lon?: number;
  coord?: CoordSource;
  connecting: string[];
  connectingRailways: string[];
}

/**
 * Display names. Operators romanise differently ("Keikyū Kamata" vs
 * "Keikyu-kamata"), so macrons are dropped; bracketed sub-names
 * ("Oshiage<SKYTREE>", "押上〈スカイツリー前〉") are removed.
 */
export function cleanEn(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[<〈][^>〉]*[>〉]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function cleanJa(s: string): string {
  return s.replace(/[〈<][^〉>]*[〉>]/g, '').trim();
}

export function names(m: Multilingual | undefined, fallbackJa?: string, fallbackId?: string): Names {
  const ja = m?.ja ?? fallbackJa ?? '';
  const en = m?.en ?? fallbackId?.split('.').pop()?.replace(/([a-z])([A-Z])/g, '$1-$2') ?? ja;
  return { en: cleanEn(en), ja: cleanJa(ja || en) };
}

/** "TY1" -> "TY01", "TI-07" -> "TI07", "Mb03" -> "Mb03". */
export function normaliseCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const m = /^([A-Za-z]{1,3})-?(\d{1,3})$/.exec(code.trim());
  return m ? `${m[1]}${m[2].padStart(2, '0')}` : code.trim();
}

/** Normalise a Japanese station name for matching across datasets. */
export function normJa(s: string): string {
  return s
    .replace(/[（(〈<][^）)〉>]*[）)〉>]/g, '')
    .replace(/駅$/, '')
    .replace(/ヶ/g, 'ケ')
    .replace(/ヵ/g, 'カ')
    .replace(/[\s・･]/g, '');
}

/** Merge railway records from both endpoints, keeping the fullest of each field. */
export function mergeRailways(lists: OdptRailway[][]): Map<string, OdptRailway> {
  const out = new Map<string, OdptRailway>();
  for (const list of lists) {
    for (const r of list) {
      const id = local(r['owl:sameAs']);
      const prev = out.get(id);
      if (!prev) {
        out.set(id, r);
        continue;
      }
      const longer = (r['odpt:stationOrder']?.length ?? 0) > (prev['odpt:stationOrder']?.length ?? 0) ? r : prev;
      out.set(id, {
        ...prev,
        ...longer,
        'odpt:color': prev['odpt:color'] ?? r['odpt:color'],
        'odpt:lineCode': prev['odpt:lineCode'] ?? r['odpt:lineCode'],
        'odpt:railwayTitle': prev['odpt:railwayTitle'] ?? r['odpt:railwayTitle'],
      });
    }
  }
  return out;
}

export function mergeStations(lists: OdptStation[][]): Map<string, StationDraft> {
  const out = new Map<string, StationDraft>();
  for (const list of lists) {
    for (const s of list) {
      const id = local(s['owl:sameAs']);
      const prev = out.get(id);
      const lat = s['geo:lat'] ?? prev?.lat;
      const lon = s['geo:long'] ?? prev?.lon;
      out.set(id, {
        id,
        operator: local(s['odpt:operator']),
        railway: local(s['odpt:railway']),
        name: prev?.name ?? names(s['odpt:stationTitle'], s['dc:title'], id),
        code: prev?.code ?? normaliseCode(s['odpt:stationCode']),
        lat,
        lon,
        coord: lat !== undefined ? 'odpt' : undefined,
        connecting: [...new Set([...(prev?.connecting ?? []), ...(s['odpt:connectingStation'] ?? []).map(local)])],
        connectingRailways: [...new Set([...(prev?.connectingRailways ?? []), ...(s['odpt:connectingRailway'] ?? []).map(local)])],
      });
    }
  }
  return out;
}

/**
 * Fill in coordinates ODPT omits: first from MLIT N02 by operator and
 * Japanese name (nearest to the line's other stations when the name is
 * ambiguous), then by interpolating along the railway's station order.
 */
export function resolveCoordinates(
  stations: Map<string, StationDraft>,
  railways: Map<string, OdptRailway>,
  mlit: MlitStation[],
): { missing: string[] } {
  const byName = new Map<string, MlitStation[]>();
  for (const m of mlit) {
    const k = `${m.operator}|${normJa(m.name)}`;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(m);
  }
  const railwayCentre = (railway: string): LatLon | undefined => {
    const pts = [...stations.values()].filter((s) => s.railway === railway && s.lat !== undefined);
    if (!pts.length) return undefined;
    return { lat: pts.reduce((a, s) => a + s.lat!, 0) / pts.length, lon: pts.reduce((a, s) => a + s.lon!, 0) / pts.length };
  };

  for (const s of stations.values()) {
    if (s.lat !== undefined) continue;
    const candidates = (MLIT_OPERATOR[s.operator] ?? []).flatMap((op) => byName.get(`${op}|${normJa(s.name.ja)}`) ?? []);
    if (!candidates.length) continue;
    const centre = railwayCentre(s.railway);
    const best = centre
      ? candidates.reduce((a, b) => (distance(a, centre) <= distance(b, centre) ? a : b))
      : candidates[0];
    s.lat = best.lat;
    s.lon = best.lon;
    s.coord = 'mlit';
  }

  // Interpolate the rest between neighbours with known positions.
  for (const rw of railways.values()) {
    const order = [...(rw['odpt:stationOrder'] ?? [])].sort((a, b) => a['odpt:index'] - b['odpt:index']).map((o) => local(o['odpt:station']));
    for (let i = 0; i < order.length; i++) {
      const s = stations.get(order[i]);
      if (!s || s.lat !== undefined) continue;
      let a = i - 1;
      while (a >= 0 && stations.get(order[a])?.lat === undefined) a--;
      let b = i + 1;
      while (b < order.length && stations.get(order[b])?.lat === undefined) b++;
      const A = a >= 0 ? stations.get(order[a]) : undefined;
      const B = b < order.length ? stations.get(order[b]) : undefined;
      if (A?.lat !== undefined && B?.lat !== undefined) {
        const f = (i - a) / (b - a);
        s.lat = A.lat + (B.lat! - A.lat) * f;
        s.lon = A.lon! + (B.lon! - A.lon!) * f;
        s.coord = 'interpolated';
      }
    }
  }
  return { missing: [...stations.values()].filter((s) => s.lat === undefined).map((s) => s.id) };
}

/** Group stations sharing a Japanese name within 800 m into one place. */
export function buildPlaces(list: StationDraft[]): number[] {
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byName = new Map<string, number[]>();
  list.forEach((s, i) => {
    const k = normJa(s.name.ja);
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(i);
  });
  for (const group of byName.values()) {
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const a = list[group[x]];
        const b = list[group[y]];
        if (distance(a as LatLon, b as LatLon) <= 800) parent[find(group[x])] = find(group[y]);
      }
    }
  }
  return list.map((_, i) => find(i));
}

/**
 * Walking links between stations: everything within 700 m, plus ODPT's own
 * "connecting station" pairs up to 1.2 km (underground passages). Time is a
 * fixed 60 s to get off the platform plus the path at 1.15 m/s with a 1.3
 * detour factor. These are estimates — ODPT publishes no transfer times —
 * and the planner says so.
 */
export function buildFootpaths(list: StationDraft[]): [number, number, number][] {
  const index = new Map(list.map((s, i) => [s.id, i]));
  const out: [number, number, number][] = [];
  const seen = new Set<string>();
  const add = (i: number, j: number) => {
    if (i === j) return;
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    const d = distance(list[i] as LatLon, list[j] as LatLon);
    const secs = Math.max(90, Math.round(60 + (d * 1.3) / 1.15));
    out.push([i, j, secs], [j, i, secs]);
  };
  // Grid for the proximity search.
  const cell = (lat: number, lon: number) => `${Math.floor(lat / 0.007)}|${Math.floor(lon / 0.008)}`;
  const grid = new Map<string, number[]>();
  list.forEach((s, i) => {
    const k = cell(s.lat!, s.lon!);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  list.forEach((s, i) => {
    const gy = Math.floor(s.lat! / 0.007);
    const gx = Math.floor(s.lon! / 0.008);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gy + dy}|${gx + dx}`) ?? []) {
          if (j > i && distance(s as LatLon, list[j] as LatLon) <= 700) add(i, j);
        }
      }
    }
    for (const c of s.connecting) {
      const j = index.get(c);
      if (j !== undefined && distance(s as LatLon, list[j] as LatLon) <= 1200) add(i, j);
    }
  });
  return out;
}
