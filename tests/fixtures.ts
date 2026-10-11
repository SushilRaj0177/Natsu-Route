import type { NetworkData, TripRecord } from '../src/shared/network.ts';

/**
 * A tiny hand-made network. Times are minutes.
 *
 *   Line A (stations 0-1-2-3):  A0 ─ A1 ─ A2 ─ A3
 *   Line B (stations 4-5-6):         B4 ─ B5 ─ B6      B4 is at the same place as A1
 *   Station 7 (line C) is a 5-minute walk from A3.
 */
export function tinyNetwork(trips: Partial<TripRecord>[], extra: Partial<NetworkData> = {}): NetworkData {
  const station = (id: string, railway: number, place: number, lat: number, lon: number) => ({
    id, railway, name: { en: id, ja: id }, lat, lon, coord: 'odpt' as const, place,
  });
  return {
    version: 2,
    builtAt: '2026-10-01T00:00:00Z',
    timetableIssued: '2026-10-01',
    operators: [
      { id: 'OpA', name: { en: 'Op A', ja: 'A社' }, licence: 'public', fares: true },
      { id: 'OpB', name: { en: 'Op B', ja: 'B社' }, licence: 'public', fares: false },
    ],
    railways: [
      { id: 'OpA.A', operator: 0, name: { en: 'A Line', ja: 'A線' }, color: '#f00', timetable: 'published' },
      { id: 'OpB.B', operator: 1, name: { en: 'B Line', ja: 'B線' }, color: '#00f', timetable: 'published' },
      { id: 'OpA.C', operator: 0, name: { en: 'C Line', ja: 'C線' }, color: '#0f0', timetable: 'published' },
    ],
    stations: [
      station('A0', 0, 0, 35.0, 139.0),
      station('A1', 0, 1, 35.0, 139.01),
      station('A2', 0, 2, 35.0, 139.02),
      station('A3', 0, 3, 35.0, 139.03),
      station('B4', 1, 1, 35.0, 139.0101),
      station('B5', 1, 4, 35.01, 139.01),
      station('B6', 1, 5, 35.02, 139.01),
      station('C7', 2, 6, 35.0, 139.035),
    ],
    places: [
      { name: { en: 'P0', ja: 'P0' }, lat: 35, lon: 139.0, stations: [0] },
      { name: { en: 'P1', ja: 'P1' }, lat: 35, lon: 139.01, stations: [1, 4] },
      { name: { en: 'P2', ja: 'P2' }, lat: 35, lon: 139.02, stations: [2] },
      { name: { en: 'P3', ja: 'P3' }, lat: 35, lon: 139.03, stations: [3] },
      { name: { en: 'P4', ja: 'P4' }, lat: 35.01, lon: 139.01, stations: [5] },
      { name: { en: 'P5', ja: 'P5' }, lat: 35.02, lon: 139.01, stations: [6] },
      { name: { en: 'P6', ja: 'P6' }, lat: 35, lon: 139.035, stations: [7] },
    ],
    trainTypes: [
      { id: 'Local', name: { en: 'Local', ja: '各停' }, surcharge: false },
      { id: 'LtdExp', name: { en: 'Limited Express', ja: '特急' }, surcharge: true },
    ],
    destinations: [{ en: 'End', ja: '終点' }],
    trips: trips.map((t) => ({ ty: 0, cal: 7, src: 0, dest: 0, s: [], t: [], ...t }) as TripRecord),
    footpaths: [
      [1, 4, 120], [4, 1, 120],
      [3, 7, 300], [7, 3, 300],
    ],
    fares: [[0, 0, 3, 200, 210], [0, 0, 1, 150, 160]],
    holidays: ['2026-10-12'],
    calendars: [],
    busFares: { flat: {}, pairs: [] },
    coverage: { tripsPublished: 0, tripsRebuilt: 0, throughLinks: { published: 0, inferred: 0 }, stations: { total: 8, served: 8, coord: { odpt: 8, mlit: 0, interpolated: 0 } } },
    ...extra,
  };
}

/** Flat [arr, dep] minutes from "HH:MM" departures (arrival = departure). */
export const times = (...hhmm: string[]) =>
  hhmm.flatMap((x) => {
    const [h, m] = x.split(':').map(Number);
    return [h * 60 + m, h * 60 + m];
  });
