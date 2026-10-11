/**
 * Build data/build/network.json and data/build/geometry.json from the raw
 * sources fetched by fetch.ts.
 *
 *   npm run data:build
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readArray } from './lib/read.ts';
import {
  local,
  type OdptFare,
  type OdptOperator,
  type OdptRailway,
  type OdptStation,
  type OdptStationTimetable,
  type OdptTrainTimetable,
  type OdptTrainType,
} from './lib/odpt.ts';
import { encodePolyline, simplify, type LatLon } from './lib/geo.ts';
import { loadMlit, MLIT_OPERATOR, type MlitSection } from './lib/mlit.ts';
import { buildChainGroups } from './lib/chain-input.ts';
import { chainBestDirection } from './lib/chain.ts';
import {
  buildFootpaths,
  buildPlaces,
  mergeRailways,
  mergeStations,
  names,
  normJa,
  resolveCoordinates,
  type StationDraft,
} from './lib/stations.ts';
import { fromChained, fromTrainTimetable, linkInferred, linkPublished, validTimes, withoutPassPoints, type DraftTrip } from './lib/trips.ts';
import { TrackGraph } from './lib/geometry.ts';
import { BUS_OPERATORS, loadBus } from './lib/bus.ts';
import { romaji } from '../src/shared/romaji.ts';
import { distance } from './lib/geo.ts';
import type {
  CalendarInfo,
  CoordSource,
  GeometryData,
  Names,
  NetworkData,
  OperatorInfo,
  PlaceInfo,
  RailwayInfo,
  StationInfo,
  TrainTypeInfo,
  TripRecord,
} from '../src/shared/network.ts';

const RAW = new URL('../data/raw/', import.meta.url).pathname;
const OUT = new URL('../data/build/', import.meta.url).pathname;

/** Operators in the Tokyo network. Order sets display priority for place names. */
const OPERATORS = [
  'JR-East', 'TokyoMetro', 'Toei', 'Tokyu', 'Odakyu', 'Keio', 'Seibu', 'Tobu', 'Keikyu', 'Sotetsu',
  'MIR', 'TWR', 'Yurikamome', 'YokohamaMunicipal', 'TamaMonorail',
  // No timetable in open data; stations are kept so they can be searched and walked from.
  'Keisei', 'TokyoMonorail', 'Minatomirai', 'SaitamaRailway', 'Hokuso', 'ToyoRapid', 'Shibayama', 'JR-Central',
];
/** Operators whose trains are rebuilt from station timetables, by endpoint. */
const REBUILD: Record<'std' | 'chal', string[]> = { std: ['Yurikamome'], chal: ['Tokyu', 'Odakyu', 'Seibu', 'Keikyu'] };
/** Railways kept although no trips run on them. JR East's long-distance lines are left out. */
const KEEP_WITHOUT_TRIPS = (railway: string, operator: string) =>
  operator === 'JR-Central' ? railway === 'JR-Central.TokaidoShinkansen' : operator !== 'JR-East';

/** Train types that need a limited-express or reserved-seat ticket on top of the fare. */
const SURCHARGE = new Set([
  'JR-East.LimitedExpress', 'JR-East.Liner', 'Tobu.LimitedExpress', 'Tobu.TJ-Liner', 'Tobu.TH-LINER',
  'Seibu.LimitedExpress', 'Seibu.S-TRAIN', 'Seibu.HaijimaLiner', 'Tokyu.S-TRAIN', 'TokyoMetro.S-TRAIN',
  // Odakyu's Romancecar and Tobu's TH Liner keep their ticketed type on Tokyo Metro track.
  'TokyoMetro.LimitedExpress', 'TokyoMetro.TH-LINER',
  'Odakyu.LimitedExpress', 'Keio.KeioLiner', 'Keikyu.MorningWing', 'Keikyu.EveningWing',
]);

/**
 * Line colours for railways ODPT publishes without one. Operator brand
 * colours, not guesses at line colours: where a line has no official colour
 * of its own, the operator's is what its signage uses.
 */
const COLOR_FALLBACK: Record<string, string> = {
  'Toei.Arakawa': '#E85298',
  'Toei.NipporiToneri': '#E85298',
  'MIR.TsukubaExpress': '#2E3192',
  'Keisei.Main': '#0055A5',
  'Keisei.NaritaSkyAccess': '#FF6F00',
  'Keisei.Oshiage': '#0055A5',
  'TokyoMonorail.HanedaAirport': '#00589D',
  'Minatomirai.Minatomirai': '#0B3F8C',
  'SaitamaRailway.SaitamaRailway': '#00AC9B',
  'Hokuso.Hokuso': '#6CBB5A',
  'ToyoRapid.ToyoRapid': '#2E9F5E',
  'Shibayama.Shibayama': '#0067B0',
  'JR-Central.TokaidoShinkansen': '#0072BC',
};

async function collect<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) {
    console.warn(`! missing ${path}`);
    return [];
  }
  const out: T[] = [];
  for await (const r of readArray<T>(path)) out.push(r);
  return out;
}

const t0 = Date.now();
const log = (msg: string) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s ${String(Math.round(process.memoryUsage().rss / 1e6)).padStart(4)} MB] ${msg}`);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const included = new Set(OPERATORS);

  // ---------------------------------------------------------------- metadata
  const railways = mergeRailways([await collect<OdptRailway>(`${RAW}std/Railway.json`), await collect<OdptRailway>(`${RAW}chal/Railway.json`)]);
  const allStations = mergeStations([await collect<OdptStation>(`${RAW}std/Station.json`), await collect<OdptStation>(`${RAW}chal/Station.json`)]);
  // Station-order titles cover stations missing from odpt:Station.
  for (const rw of railways.values()) {
    for (const o of rw['odpt:stationOrder'] ?? []) {
      const id = local(o['odpt:station']);
      if (!allStations.has(id)) {
        allStations.set(id, { id, operator: local(rw['odpt:operator']), railway: local(rw['owl:sameAs']), name: names(o['odpt:stationTitle'], undefined, id), connecting: [], connectingRailways: [] });
      }
    }
  }
  const nameJa = (id: string) => allStations.get(id)?.name.ja ?? id;
  const operatorRecords = [...(await collect<OdptOperator>(`${RAW}std/Operator.json`)), ...(await collect<OdptOperator>(`${RAW}chal/Operator.json`))];
  const trainTypeRecords = [...(await collect<OdptTrainType>(`${RAW}std/TrainType.json`)), ...(await collect<OdptTrainType>(`${RAW}chal/TrainType.json`))];
  log(`metadata: ${railways.size} railways, ${allStations.size} stations`);

  const mlit = await loadMlit(`${RAW}mlit/N02-24.zip`);
  log(`MLIT N02: ${mlit.stations.length} stations, ${mlit.sections.length} track sections`);

  const { missing } = resolveCoordinates(allStations, railways, mlit.stations);
  log(`coordinates: ${missing.length} stations still without a position`);
  const coordOf = (id: string): LatLon | undefined => {
    const s = allStations.get(id);
    return s?.lat !== undefined ? { lat: s.lat, lon: s.lon! } : undefined;
  };

  // ------------------------------------------------------------- published trips
  let drafts: DraftTrip[] = [];
  let issued = '';
  const licenceOf = new Map<string, 'public' | 'challenge'>();
  for (const ep of ['std', 'chal'] as const) {
    for await (const r of readArray<OdptTrainTimetable>(`${RAW}${ep}/TrainTimetable.json`)) {
      const op = local(r['odpt:operator']);
      if (!included.has(op)) continue;
      const trip = fromTrainTimetable(r);
      if (!trip) continue;
      drafts.push(trip);
      licenceOf.set(op, ep === 'std' ? (licenceOf.get(op) ?? 'public') : 'challenge');
      if (r['dct:issued'] && r['dct:issued'] > issued) issued = r['dct:issued'];
    }
  }
  log(`published trips: ${drafts.length}`);

  // --------------------------------------------------------------- rebuilt trips
  const coordMap = new Map<string, LatLon>();
  for (const s of allStations.values()) if (s.lat !== undefined) coordMap.set(s.id, { lat: s.lat, lon: s.lon! });
  let rebuilt = 0;
  for (const ep of ['std', 'chal'] as const) {
    const wanted = new Set(REBUILD[ep]);
    const records: OdptStationTimetable[] = [];
    for await (const r of readArray<OdptStationTimetable>(`${RAW}${ep}/StationTimetable.json`)) {
      if (wanted.has(local(r['odpt:operator']))) records.push(r);
    }
    const connects = (station: string, railway: string) => allStations.get(station)?.connectingRailways.includes(railway) ?? false;
    const { groups, skipped } = buildChainGroups(records, railways, coordMap, { connects });
    for (const g of groups) {
      const { trains } = chainBestDirection(g.input);
      trains.forEach((t, n) => {
        const trip = fromChained(t, `${g.railway}.${g.calendar}.${g.direction}.${n}`, g.calendar);
        if (trip) {
          drafts.push(trip);
          rebuilt++;
        }
      });
    }
    for (const op of REBUILD[ep]) licenceOf.set(op, ep === 'std' ? 'public' : 'challenge');
    if (Object.keys(skipped).length) log(`rebuild ${ep}: skipped ${JSON.stringify(skipped)}`);
  }
  log(`rebuilt trips: ${rebuilt}`);

  // ------------------------------------------------------------ through services
  const pub = linkPublished(drafts, nameJa);
  drafts = pub.trips.map(withoutPassPoints).filter((t): t is DraftTrip => t !== null);
  const railwayOf = (id: string) => allStations.get(id)?.railway ?? id.split('.').slice(0, 2).join('.');
  const railwayNames = (id: string) =>
    [...(railways.get(id)?.['odpt:stationOrder'] ?? [])]
      .sort((a, b) => a['odpt:index'] - b['odpt:index'])
      .map((o) => nameJa(local(o['odpt:station'])));
  const compatible = (a: DraftTrip, b: DraftTrip) => SURCHARGE.has(a.type) === SURCHARGE.has(b.type);
  const inf = linkInferred(drafts, nameJa, coordOf, railwayOf, railwayNames, compatible);
  drafts = inf.trips;
  log(`through services: ${pub.merged} linked by the operator, ${inf.merged} inferred across operators`);
  writeFileSync(`${OUT}through-links.json`, JSON.stringify(Object.fromEntries([...inf.byRailway].sort((a, b) => b[1] - a[1])), null, 1));

  // ------------------------------------------------------------ station set
  const railwaysWithTrips = new Set<string>();
  for (const t of drafts) for (const s of t.stops) railwaysWithTrips.add(railwayOf(s.station));
  const keepRailway = (id: string) => {
    const rw = railways.get(id);
    const op = rw ? local(rw['odpt:operator']) : id.split('.')[0];
    return included.has(op) && (railwaysWithTrips.has(id) || KEEP_WITHOUT_TRIPS(id, op));
  };
  const stationDrafts: StationDraft[] = [...allStations.values()].filter((s) => keepRailway(s.railway) && s.lat !== undefined);
  // Stable order: by operator priority, then railway, then id.
  const opRank = new Map(OPERATORS.map((o, i) => [o, i]));
  stationDrafts.sort((a, b) => (opRank.get(a.operator)! - opRank.get(b.operator)!) || a.railway.localeCompare(b.railway) || a.id.localeCompare(b.id));
  const stationIndex = new Map(stationDrafts.map((s, i) => [s.id, i]));

  let droppedTrips = 0;
  drafts = drafts.filter((t) => {
    const ok = t.stops.every((s) => stationIndex.has(s.station)) && validTimes(t);
    if (!ok) droppedTrips++;
    return ok;
  });
  // Exact duplicates (the same train published twice) are removed.
  const seen = new Set<string>();
  drafts = drafts.filter((t) => {
    const k = `${t.calendar}|${t.stops.map((s) => `${s.station}@${s.dep}`).join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  log(`trips kept: ${drafts.length} (dropped ${droppedTrips} with unknown stations or bad times)`);

  // ------------------------------------------------------------ operators & railways
  const opTitle = new Map(operatorRecords.map((o) => [local(o['owl:sameAs']), o]));
  const operators: OperatorInfo[] = OPERATORS.map((id) => ({
    id,
    name: names(opTitle.get(id)?.['odpt:operatorTitle'], opTitle.get(id)?.['dc:title'], id),
    licence: licenceOf.get(id) ?? 'public',
    fares: false,
  }));
  const operatorIndex = new Map(operators.map((o, i) => [o.id, i]));

  const railwayIds = [...new Set(stationDrafts.map((s) => s.railway))];
  const sourceOf = new Map<string, 0 | 1>();
  for (const t of drafts) for (const s of t.stops) {
    const r = railwayOf(s.station);
    if (sourceOf.get(r) !== 0) sourceOf.set(r, t.src);
  }
  const railwayInfos: RailwayInfo[] = railwayIds.map((id) => {
    const rw = railways.get(id);
    const op = rw ? local(rw['odpt:operator']) : id.split('.')[0];
    const src = sourceOf.get(id);
    return {
      id,
      operator: operatorIndex.get(op)!,
      name: names(rw?.['odpt:railwayTitle'], rw?.['dc:title'], id),
      color: rw?.['odpt:color'] ?? COLOR_FALLBACK[id] ?? '#6B7280',
      code: rw?.['odpt:lineCode'],
      timetable: src === 0 ? 'published' : src === 1 ? 'rebuilt' : 'none',
    };
  });
  const railwayIndex = new Map(railwayInfos.map((r, i) => [r.id, i]));
  const noColour = railwayInfos.filter((r) => r.color === '#6B7280').map((r) => r.id);
  if (noColour.length) log(`railways with no known colour: ${noColour.join(', ')}`);

  // ------------------------------------------------------------ places & walking
  const placeOfStation = buildPlaces(stationDrafts);
  const placeRoots = [...new Set(placeOfStation)];
  const placeIndex = new Map(placeRoots.map((r, i) => [r, i]));
  const places: PlaceInfo[] = placeRoots.map((root) => {
    const members = stationDrafts.map((s, i) => [s, i] as const).filter(([, i]) => placeOfStation[i] === root);
    const count = (key: 'en' | 'ja') => {
      const c = new Map<string, number>();
      for (const [s] of members) c.set(s.name[key], (c.get(s.name[key]) ?? 0) + 1);
      return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    return {
      name: { en: count('en'), ja: count('ja') },
      lat: members.reduce((a, [s]) => a + s.lat!, 0) / members.length,
      lon: members.reduce((a, [s]) => a + s.lon!, 0) / members.length,
      stations: members.map(([, i]) => i),
    };
  });
  // Within a place, spellings that differ only in case, spaces or hyphens
  // ("Keikyu Kamata" / "Keikyu-kamata") are shown one way.
  const spellKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  stationDrafts.forEach((s, i) => {
    const place = places[placeIndex.get(placeOfStation[i])!];
    if (spellKey(s.name.en) === spellKey(place.name.en)) s.name = { ...s.name, en: place.name.en };
  });
  const footpaths = buildFootpaths(stationDrafts);
  log(`places: ${places.length}; walking links: ${footpaths.length / 2}`);

  const stations: StationInfo[] = stationDrafts.map((s, i) => ({
    id: s.id,
    railway: railwayIndex.get(s.railway)!,
    name: s.name,
    code: s.code,
    lat: Math.round(s.lat! * 1e6) / 1e6,
    lon: Math.round(s.lon! * 1e6) / 1e6,
    coord: s.coord as CoordSource,
    place: placeIndex.get(placeOfStation[i])!,
  }));

  // ------------------------------------------------------------ train types & destinations
  const ttTitle = new Map(trainTypeRecords.map((t) => [local(t['owl:sameAs']), t]));
  const typeIds = [...new Set(drafts.flatMap((t) => [t.type, ...t.stops.map((s) => s.type ?? t.type)]))].sort();
  const trainTypes: TrainTypeInfo[] = typeIds.map((id) => ({
    id,
    name: names(ttTitle.get(id)?.['odpt:trainTypeTitle'], ttTitle.get(id)?.['dc:title'], id),
    surcharge: SURCHARGE.has(id),
  }));
  const typeIndex = new Map(typeIds.map((t, i) => [t, i]));
  const destinations: Names[] = [];
  const destIndex = new Map<string, number>();
  const destOf = (ids: string[]) => {
    const n: Names = ids.length
      ? { en: ids.map((d) => allStations.get(d)?.name.en ?? d.split('.').pop()!).join(' / '), ja: ids.map((d) => allStations.get(d)?.name.ja ?? d).join('・') }
      : { en: '', ja: '' };
    const k = `${n.en}|${n.ja}`;
    let i = destIndex.get(k);
    if (i === undefined) {
      i = destinations.length;
      destinations.push(n);
      destIndex.set(k, i);
    }
    return i;
  };

  // ------------------------------------------------------------ trips
  const trips: TripRecord[] = drafts.map((t) => {
    const rec: TripRecord = {
      ty: typeIndex.get(t.stops[0].type ?? t.type)!,
      cal: t.calendar,
      src: t.src,
      dest: destOf(t.dest),
      s: t.stops.map((s) => stationIndex.get(s.station)!),
      t: t.stops.flatMap((s) => [s.arr, s.dep]),
    };
    if (t.numbers.length) rec.n = t.numbers.join('/');
    const est = t.stops.flatMap((s, i) => (s.est ? [i] : []));
    if (est.length) rec.est = est;
    const tc: [number, number][] = [];
    let cur = rec.ty;
    t.stops.forEach((s, i) => {
      const ty = typeIndex.get(s.type ?? t.type)!;
      if (ty !== cur) tc.push([i, (cur = ty)]);
    });
    if (tc.length) rec.tc = tc;
    const rb = t.stops.flatMap((s, i) => (s.rebuilt ? [i] : []));
    if (rb.length) rec.rb = rb;
    if (t.stops.some((s) => s.platform)) rec.pl = t.stops.map((s) => s.platform ?? null);
    return rec;
  });

  // ------------------------------------------------------------ fares
  const fares: NetworkData['fares'] = [];
  const fareSeen = new Set<string>();
  for (const ep of ['std', 'chal']) {
    for await (const f of readArray<OdptFare>(`${RAW}${ep}/RailwayFare.json`)) {
      const op = operatorIndex.get(local(f['odpt:operator']));
      const a = stationIndex.get(local(f['odpt:fromStation']));
      const b = stationIndex.get(local(f['odpt:toStation']));
      if (op === undefined || a === undefined || b === undefined) continue;
      const k = `${a}|${b}`;
      if (fareSeen.has(k)) continue;
      fareSeen.add(k);
      fares.push([op, a, b, f['odpt:icCardFare'], f['odpt:ticketFare']]);
      operators[op].fares = true;
    }
  }
  log(`fares: ${fares.length} station pairs`);

  // ------------------------------------------------------------ buses
  const bus = await loadBus(RAW, ['std', 'chal']);
  log(`buses: ${bus.routes.length} routes, ${bus.patterns.length} patterns, ${bus.trips.length} trips`);
  const inWards = loadWardsTest();
  const toeiRail = operators.find((o) => o.id === 'Toei');
  if (toeiRail) toeiRail.silver = true; // Toei subway, Toden Arakawa and Nippori-Toneri Liner
  const busOpIndex = new Map<string, number>();
  for (const op of Object.keys(BUS_OPERATORS)) {
    if (!bus.trips.some((t) => t.operator === op)) continue;
    busOpIndex.set(op, operators.length);
    operators.push({
      id: `Bus.${op}`,
      name: BUS_OPERATORS[op].name,
      // Kokusai Kogyo Bus comes from the Challenge 2026 endpoint; the others are public.
      licence: op === 'KokusaiKogyoBus' ? 'challenge' : 'public',
      fares: bus.flatFare[op] != null || [...bus.pairFares.keys()].some((k) => k.startsWith(`${op}.`)),
      bus: true,
      silver: BUS_OPERATORS[op].silver,
    });
  }
  const busRouteIndex = bus.routes.map((r) => {
    const i = railwayInfos.length;
    railwayInfos.push({
      id: `Bus.${r.id}`,
      operator: busOpIndex.get(r.operator)!,
      name: { ja: r.name, en: r.name },
      color: BUS_OPERATORS[r.operator].color,
      timetable: 'published',
      mode: 'bus',
    });
    return i;
  });
  // Poles used by a trip become stops; poles sharing a name within 300 m form one place.
  const usedPoles = [...new Set(bus.trips.flatMap((t) => t.stops.map((s) => s.pole)))].sort();
  const poleIndex = new Map<string, number>();
  const poleRoute = new Map<string, number>();
  for (const t of bus.trips) for (const s of t.stops) if (!poleRoute.has(s.pole)) poleRoute.set(s.pole, busRouteIndex[bus.patterns[t.pattern].route]);
  const busPlaces = new Map<string, number[]>();
  for (const id of usedPoles) {
    const p = bus.poles.get(id)!;
    const key = p.name.ja;
    const group = busPlaces.get(key) ?? [];
    let place = group.find((pi) => distance(places[pi], p) < 300);
    if (place === undefined) {
      place = places.length;
      places.push({ name: { ja: p.name.ja, en: p.name.en || (p.kana ? romaji(p.kana) : p.name.ja) }, lat: p.lat, lon: p.lon, stations: [] });
      group.push(place);
      busPlaces.set(key, group);
    }
    poleIndex.set(id, stations.length);
    places[place].stations.push(stations.length);
    stations.push({
      id: `Bus.${id}`,
      railway: poleRoute.get(id)!,
      name: { ja: p.name.ja, en: p.name.en || (p.kana ? romaji(p.kana) : p.name.ja) },
      lat: Math.round(p.lat * 1e6) / 1e6,
      lon: Math.round(p.lon * 1e6) / 1e6,
      coord: 'odpt',
      place,
      pole: true,
      kana: p.kana,
      number: p.number,
      ...(inWards(p.lat, p.lon) ? { wards: true as const } : {}),
    });
  }
  const busType = trainTypes.length;
  trainTypes.push({ id: 'Bus', name: { ja: '路線バス', en: 'Bus' }, surcharge: false });
  const usedCalendars = new Map<number, number>();
  const calendars: CalendarInfo[] = [];
  const calOf = (i: number) => {
    let j = usedCalendars.get(i);
    if (j === undefined) {
      j = calendars.length;
      usedCalendars.set(i, j);
      calendars.push(bus.calendars[i]);
    }
    return j;
  };
  const busDest = new Map<string, number>();
  for (const t of bus.trips) {
    let d = busDest.get(t.dest);
    if (d === undefined) {
      d = destinations.length;
      destinations.push({ ja: t.dest, en: t.dest });
      busDest.set(t.dest, d);
    }
    const rec: TripRecord = {
      ty: busType,
      cal: t.dayBits,
      src: 0,
      dest: d,
      s: t.stops.map((s) => poleIndex.get(s.pole)!),
      t: t.stops.flatMap((s) => [s.arr, s.dep]),
      r: busRouteIndex[bus.patterns[t.pattern].route],
      dc: calOf(t.calendar),
      pt: t.pattern,
    };
    if (t.nonStep) rec.ns = 1;
    rec.n = t.id;
    trips.push(rec);
  }
  // Walking links between bus stops and to stations nearby (straight line,
  // 1.0 m/s with a detour factor); the server refines these on the street network.
  const poleIdx = [...poleIndex.values()];
  const cellOf = (lat: number, lon: number) => `${Math.floor(lat / 0.003)}|${Math.floor(lon / 0.004)}`;
  const grid = new Map<string, number[]>();
  stations.forEach((s, i) => {
    const k = cellOf(s.lat, s.lon);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  let busLinks = 0;
  for (const a of poleIdx) {
    const sa = stations[a];
    const ci = Math.floor(sa.lat / 0.003);
    const cj = Math.floor(sa.lon / 0.004);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const b of grid.get(`${ci + di}|${cj + dj}`) ?? []) {
          if (b === a) continue;
          const d = distance(sa, stations[b]);
          if (d > 250) continue;
          const sec = Math.round(60 + (d * 1.35) / 1.0);
          footpaths.push([a, b, sec], [b, a, sec]);
          busLinks++;
        }
  }
  const busFares: NetworkData['busFares'] = { flat: {}, pairs: [] };
  for (const [op, f] of Object.entries(bus.flatFare)) if (f && busOpIndex.has(op)) busFares.flat[busOpIndex.get(op)!] = [f.ic, f.ticket];
  for (const [k, [ic, ticket]] of bus.pairFares) {
    const [a, b] = k.split('|');
    const ia = poleIndex.get(a);
    const ib = poleIndex.get(b);
    if (ia !== undefined && ib !== undefined) busFares.pairs.push([ia, ib, ic, ticket]);
  }
  log(`bus network: ${poleIndex.size} stops, ${bus.trips.length} trips, ${calendars.length} calendars, ${busLinks} walking links; flat fares ${JSON.stringify(bus.flatFare)}`);

  // ------------------------------------------------------------ holidays
  const holidays = existsSync(`${RAW}holidays.json`) ? Object.keys(JSON.parse(readFileSync(`${RAW}holidays.json`, 'utf8'))).sort() : [];

  const coordCount: Record<CoordSource, number> = { odpt: 0, mlit: 0, interpolated: 0 };
  for (const s of stations) coordCount[s.coord]++;
  const served = new Set(trips.flatMap((t) => t.s));

  const network: NetworkData = {
    version: 2,
    builtAt: new Date().toISOString(),
    timetableIssued: issued,
    operators,
    railways: railwayInfos,
    stations,
    places,
    trainTypes,
    destinations,
    trips,
    footpaths,
    fares,
    holidays,
    calendars,
    busFares,
    coverage: {
      tripsPublished: trips.filter((t) => t.src === 0).length,
      tripsRebuilt: trips.filter((t) => t.src === 1).length,
      throughLinks: { published: pub.merged, inferred: inf.merged },
      stations: { total: stations.length, served: served.size, coord: coordCount },
    },
  };
  writeFileSync(`${OUT}network.json`, JSON.stringify(network));
  log(`wrote network.json: ${stations.length} stations, ${trips.length} trips`);

  // ------------------------------------------------------------ geometry
  const graphs = new Map<string, TrackGraph>();
  const graphFor = (operator: string) => {
    let g = graphs.get(operator);
    if (!g) {
      const wanted = new Set(MLIT_OPERATOR[operator] ?? []);
      const secs: MlitSection[] = mlit.sections.filter((s) => wanted.has(s.operator));
      g = new TrackGraph(secs);
      graphs.set(operator, g);
    }
    return g;
  };
  const hopsWanted = new Map<number, Set<number>>();
  const wantHop = (a: number, b: number) => {
    if (a === b) return;
    (hopsWanted.get(a) ?? hopsWanted.set(a, new Set()).get(a)!).add(b);
  };
  for (const t of trips) if (t.r === undefined) for (let i = 1; i < t.s.length; i++) wantHop(t.s[i - 1], t.s[i]);
  // Overview lines: consecutive stations in each railway's published order.
  const overviewPairs = new Map<number, [number, number][]>();
  for (const [id, ri] of railwayIndex) {
    const order = [...(railways.get(id)?.['odpt:stationOrder'] ?? [])]
      .sort((a, b) => a['odpt:index'] - b['odpt:index'])
      .map((o) => stationIndex.get(local(o['odpt:station'])))
      .filter((x): x is number => x !== undefined);
    const pairs: [number, number][] = [];
    for (let i = 1; i < order.length; i++) {
      pairs.push([order[i - 1], order[i]]);
      wantHop(order[i - 1], order[i]);
    }
    overviewPairs.set(ri, pairs);
  }
  const hops: Record<string, string> = {};
  let traced = 0;
  let straight = 0;
  const operatorOfStation = (i: number) => operators[railwayInfos[stations[i].railway].operator].id;
  for (const [a, targets] of hopsWanted) {
    const from = stations[a];
    const list = [...targets];
    // Trace on the destination station's operator first, then the origin's.
    const byOp = new Map<string, number[]>();
    for (const b of list) {
      const op = operatorOfStation(b);
      (byOp.get(op) ?? byOp.set(op, []).get(op)!).push(b);
    }
    for (const [op, bs] of byOp) {
      let paths = graphFor(op).paths(from, bs.map((b) => stations[b]));
      const fallbackOp = operatorOfStation(a);
      if (fallbackOp !== op && paths.some((p) => !p)) {
        const retry = graphFor(fallbackOp).paths(from, bs.map((b) => stations[b]));
        paths = paths.map((p, k) => p ?? retry[k]);
      }
      bs.forEach((b, k) => {
        const p = paths[k];
        const to = stations[b];
        const line: [number, number][] = p ? simplify(p, 6) : [[from.lat, from.lon], [to.lat, to.lon]];
        if (p) traced++;
        else straight++;
        hops[`${a}>${b}`] = encodePolyline(line);
      });
    }
  }
  const railwayGeo: Record<string, string[]> = {};
  for (const [ri, pairs] of overviewPairs) {
    if (pairs.length) railwayGeo[ri] = pairs.map(([a, b]) => hops[`${a}>${b}`]);
  }
  // Railways without a published order (trip-only) draw from their trips' hops.
  for (const ri of railwayIndex.values()) {
    if (railwayGeo[ri]) continue;
    const keys = new Set<string>();
    for (const t of trips) {
      if (t.r !== undefined) continue;
      for (let i = 1; i < t.s.length; i++) {
        if (stations[t.s[i]].railway === ri && stations[t.s[i - 1]].railway === ri) {
          const [x, y] = [t.s[i - 1], t.s[i]].sort((p, q) => p - q);
          keys.add(`${x}>${y}`);
        }
      }
    }
    const lines = [...keys].map((k) => hops[k] ?? hops[k.split('>').reverse().join('>')]).filter(Boolean);
    if (lines.length) railwayGeo[ri] = lines;
  }
  // Railways with neither (no timetable, no published order) take their track
  // straight from MLIT, matched by line name, so the map can still show them.
  const lineKey = (s: string) => s.replace(/^(京成|東京モノレール)/, '').replace(/21/, '').replace(/線$/, '').replace('成田スカイアクセス', '成田空港');
  for (const [id, ri] of railwayIndex) {
    if (railwayGeo[ri]) continue;
    const info = railwayInfos[ri];
    const op = operators[info.operator].id;
    const secs = mlit.sections.filter((s) => (MLIT_OPERATOR[op] ?? []).includes(s.operator));
    const sameOperator = railwayInfos.filter((r) => r.operator === info.operator).length;
    let mine = secs.filter((s) => lineKey(s.line) === lineKey(info.name.ja));
    if (!mine.length && sameOperator === 1 && op !== 'JR-Central') mine = secs;
    if (mine.length) railwayGeo[ri] = mine.map((s) => encodePolyline(simplify(s.coords, 6)));
    else log(`no overview geometry for ${id}`);
  }
  const patterns = bus.patterns.map((p) => {
    const line = p.line ?? p.poles.map((id) => bus.poles.get(id)).filter((q) => q !== undefined).map((q) => [q!.lat, q!.lon] as [number, number]);
    return line.length >= 2 ? encodePolyline(simplify(line, 4)) : '';
  });
  const geometry: GeometryData = { hops, railways: railwayGeo, patterns };
  writeFileSync(`${OUT}geometry.json`, JSON.stringify(geometry));
  log(`wrote geometry.json: ${traced} hops traced along track, ${straight} straight (no track match)`);

  // Human-readable summary for the README / About page.
  const unmatchedNames = stationDrafts.filter((s) => s.coord === 'interpolated').map((s) => s.id);
  writeFileSync(
    `${OUT}report.json`,
    JSON.stringify({ coverage: network.coverage, interpolatedStations: unmatchedNames, stationsWithoutPosition: missing.filter((id) => keepRailway(allStations.get(id)!.railway)) }, null, 2),
  );
  log(`done (peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Point-in-23-wards test from the geo pipeline's ward outlines (always false if absent). */
function loadWardsTest(): (lat: number, lon: number) => boolean {
  const paths = [new URL('../data/build/geo/wards.geojson', import.meta.url).pathname, new URL('../geo/out/osm/wards.geojson', import.meta.url).pathname];
  const path = paths.find((p) => existsSync(p));
  if (!path) {
    console.warn('! no ward outlines (run the geo pipeline); bus stops are not marked as inside the 23 wards');
    return () => false;
  }
  const fc = JSON.parse(readFileSync(path, 'utf8')) as { features: { properties: { name: string }; geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] };
  const all = fc.features.find((f) => f.properties.name === '23区') ?? fc.features[0];
  const polys = (all.geometry.type === 'Polygon' ? [all.geometry.coordinates] : all.geometry.coordinates) as number[][][][];
  const inRing = (ring: number[][], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (lat, lon) => polys.some((poly) => inRing(poly[0], lon, lat) && !poly.slice(1).some((hole) => inRing(hole, lon, lat)));
}

// Re-exported for tests.
export { normJa };
