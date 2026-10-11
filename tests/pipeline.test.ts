import { describe, expect, it } from 'vitest';
import { chainBestDirection, chainDepartures, type Departure } from '../pipeline/lib/chain.ts';
import { linkInferred, linkPublished, mergeTrips, normaliseTimes, withoutPassPoints, type DraftTrip } from '../pipeline/lib/trips.ts';
import { cleanEn, normaliseCode } from '../pipeline/lib/stations.ts';
import { dayTypeOf, serviceTime } from '../src/server/time.ts';

const dep = (time: number, type: string, dest: string, truth?: string, isOrigin = false): Departure => ({ time, type, dest, isOrigin, truth });

describe('rebuilding trains from station timetables', () => {
  it('follows an express past the stations it skips', () => {
    // Local every station (2 min hops); express skips station 1 and 2.
    const order = ['s0', 's1', 's2', 's3'];
    const departures = [
      [dep(600, 'Local', 'X', 'L1', true), dep(602, 'Exp', 'X', 'E1', true), dep(610, 'Local', 'X', 'L2', true), dep(612, 'Exp', 'X', 'E2', true)],
      [dep(602, 'Local', 'X', 'L1'), dep(612, 'Local', 'X', 'L2')],
      [dep(604, 'Local', 'X', 'L1'), dep(614, 'Local', 'X', 'L2')],
      [dep(606, 'Exp', 'X', 'E1'), dep(608, 'Local', 'X', 'L1'), dep(616, 'Exp', 'X', 'E2'), dep(618, 'Local', 'X', 'L2')],
    ];
    const { trains } = chainDepartures({ order, departures, hopMetres: [1500, 1500, 1500] });
    for (const t of trains) {
      const truths = new Set(t.stops.map((s) => s.truth).filter(Boolean));
      expect(truths.size).toBe(1);
    }
    expect(trains).toHaveLength(4);
  });

  it('keeps a train whose type changes part-way', () => {
    const order = ['a', 'b', 'c'];
    const departures = [[dep(600, 'Exp', 'Z', 'T', true)], [dep(604, 'Exp', 'Z', 'T')], [dep(607, 'Local', 'Z', 'T')]];
    const { trains } = chainDepartures({ order, departures, hopMetres: [3000, 3000] });
    expect(trains).toHaveLength(1);
    expect(trains[0].stops.map((s) => s.type)).toEqual(['Exp', 'Exp', 'Local']);
  });

  it('works out the direction of travel from the data', () => {
    const order = ['a', 'b', 'c'];
    // Departures that only make sense going c -> b -> a.
    const departures = [[], [dep(605, 'L', 'a', 'T')], [dep(600, 'L', 'a', 'T', true)]];
    const r = chainBestDirection({ order, departures, hopMetres: [2000, 2000] });
    expect(r.reversed).toBe(true);
    expect(r.trains[0].stops.map((s) => s.station)).toEqual(['c', 'b', 'a']);
  });
});

const trip = (key: string, stops: [string, number, number][], extra: Partial<DraftTrip> = {}): DraftTrip => ({
  key,
  calendar: 1,
  type: 'Local',
  numbers: [key],
  dest: [],
  stops: stops.map(([station, arr, dep]) => ({ station, arr, dep })),
  src: 0,
  ...extra,
});

describe('joining through services', () => {
  const nameOf = (id: string) => id.split('.').pop()!;

  it('merges at a shared station into one stop', () => {
    const a = trip('A', [['M.F.Ikebukuro', 600, 600], ['M.F.Shibuya', 615, 615]]);
    const b = trip('B', [['T.Y.Shibuya', 615, 616], ['T.Y.Yokohama', 640, 640]]);
    const m = mergeTrips(a, b, nameOf)!;
    expect(m.stops.map((s) => [s.station, s.arr, s.dep])).toEqual([
      ['M.F.Ikebukuro', 600, 600],
      ['T.Y.Shibuya', 615, 616],
      ['T.Y.Yokohama', 640, 640],
    ]);
  });

  it('keeps pass-through points until segments are linked (Narita Express)', () => {
    const a = trip('SobuRapid.2019M', [['J.SR.Tokyo', 663, 663], ['J.SR.Chiba', 687, 687]], { next: ['Sobu.2019M'] });
    const b = trip('Sobu.2019M', [['J.S.Chiba', 688, 688], ['J.S.Sakura', NaN, NaN]], { prev: ['SobuRapid.2019M'], next: ['Air.2019M'] });
    const c = trip('Air.2019M', [['J.A.Sakura', NaN, NaN], ['J.A.Terminal1', 717, 717]], { prev: ['Sobu.2019M'] });
    const { trips } = linkPublished([a, b, c], nameOf);
    const clean = trips.map(withoutPassPoints).filter(Boolean) as DraftTrip[];
    expect(clean).toHaveLength(1);
    expect(clean[0].stops.map((s) => s.station)).toEqual(['J.SR.Tokyo', 'J.S.Chiba', 'J.A.Terminal1']);
  });

  it('gives each half of a coupled train its own single-seat trip', () => {
    const x = trip('X', [['a', 600, 600], ['hub', 610, 610]], { next: ['Z'] });
    const y = trip('Y', [['b', 602, 602], ['hub', 611, 611]], { next: ['Z'] });
    const z = trip('Z', [['hub', 612, 614], ['end', 640, 640]], { prev: ['X', 'Y'] });
    const { trips } = linkPublished([x, y, z], nameOf);
    expect(trips.map((t) => t.stops[0].station).sort()).toEqual(['a', 'b']);
  });

  it('does not join an express to a local even when everything else fits', () => {
    const exp = trip('E', [['J.SR.Tokyo', 600, 600], ['J.SR.Chiba', 625, 625]], { dest: ['J.A.Terminal1'], type: 'LtdExp' });
    const loc = trip('L', [['J.S.Chiba', 628, 628], ['J.A.Terminal1', 680, 680]], { dest: ['J.A.Terminal1'] });
    const names = (r: string) => (r === 'J.SR' ? ['Tokyo', 'Chiba'] : ['Chiba', 'Terminal1']);
    const { trips } = linkInferred(
      [exp, loc], nameOf, () => ({ lat: 35, lon: 140 }), (id) => id.split('.').slice(0, 2).join('.'), names,
      (a, b) => (a.type === 'LtdExp') === (b.type === 'LtdExp'),
    );
    expect(trips).toHaveLength(2);
  });

  it('wraps times past midnight onto the same service day', () => {
    const stops = [{ station: 'a', arr: 1430, dep: 1430 }, { station: 'b', arr: 5, dep: 5 }];
    normaliseTimes(stops);
    expect(stops.map((s) => s.dep)).toEqual([1430, 1445]);
  });
});

describe('names and codes', () => {
  it('normalises station numbers to signage form', () => {
    expect(normaliseCode('TY1')).toBe('TY01');
    expect(normaliseCode('TI-07')).toBe('TI07');
    expect(normaliseCode('G01')).toBe('G01');
  });

  it('drops macrons and bracketed sub-names', () => {
    expect(cleanEn('Keikyū Kamata')).toBe('Keikyu Kamata');
    expect(cleanEn('Oshiage<SKYTREE>')).toBe('Oshiage');
    expect(cleanEn('Meiji-jingumae (Harajuku)')).toBe('Meiji-jingumae (Harajuku)');
  });
});

describe('service days', () => {
  it('counts 00:30 as part of the previous day', () => {
    expect(serviceTime(new Date('2026-10-14T00:30:00+09:00'))).toEqual({ date: '2026-10-13', minute: 24 * 60 + 30 });
    expect(serviceTime(new Date('2026-10-14T03:00:00+09:00'))).toEqual({ date: '2026-10-14', minute: 180 });
  });

  it('picks the timetable for weekends, holidays and New Year', () => {
    const hol = new Set(['2026-11-03']);
    expect(dayTypeOf('2026-10-13', hol)).toBe('weekday');
    expect(dayTypeOf('2026-10-17', hol)).toBe('saturday');
    expect(dayTypeOf('2026-10-18', hol)).toBe('holiday');
    expect(dayTypeOf('2026-11-03', hol)).toBe('holiday');
    expect(dayTypeOf('2026-12-31', hol)).toBe('holiday');
    expect(dayTypeOf('2027-01-04', hol)).toBe('weekday');
  });
});
