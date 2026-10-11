import { describe, expect, it } from 'vitest';
import { buildTimetable } from '../src/server/timetable.ts';
import { raptor } from '../src/server/raptor.ts';
import { tinyNetwork, times } from './fixtures.ts';

const min = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 60 + m) * 60;
};

function run(net: ReturnType<typeof tinyNetwork>, from: number, to: number[], at: string, opts: { surcharge?: boolean } = {}) {
  const tt = buildTimetable(net, (i) => (net.trips[i].cal & 1) !== 0);
  return raptor(tt, {
    sources: [{ stop: from, time: min(at) }],
    targets: to.map((stop) => ({ stop, extra: 0 })),
    maxRounds: 5,
    allowSurcharge: opts.surcharge ?? true,
    minChangeSec: 60,
  });
}

describe('raptor', () => {
  it('takes the first train that leaves after the query time', () => {
    const net = tinyNetwork([
      { s: [0, 1, 2, 3], t: times('08:00', '08:05', '08:10', '08:15') },
      { s: [0, 1, 2, 3], t: times('08:10', '08:15', '08:20', '08:25') },
    ]);
    const [j] = run(net, 0, [3], '08:01');
    expect(j.trains).toBe(1);
    expect(j.arr).toBe(min('08:25'));
    expect(j.legs[0]).toMatchObject({ kind: 'ride', from: 0, to: 3, dep: min('08:10') });
  });

  it('changes trains via a walking link and respects the walk time', () => {
    const net = tinyNetwork([
      { s: [0, 1, 2, 3], t: times('08:00', '08:05', '08:10', '08:15') },
      // Leaves B4 one minute after A1 arrival: too soon for the 2-minute walk.
      { s: [4, 5, 6], t: times('08:06', '08:10', '08:15') },
      { s: [4, 5, 6], t: times('08:12', '08:16', '08:21') },
    ]);
    const [j] = run(net, 0, [6], '07:59');
    expect(j.arr).toBe(min('08:21'));
    expect(j.legs.map((l) => l.kind)).toEqual(['ride', 'walk', 'ride']);
  });

  it('needs a minute to change at the same stop', () => {
    const net = tinyNetwork([
      { s: [0, 1], t: times('08:00', '08:05') },
      { s: [1, 2, 3], t: times('08:05', '08:10', '08:15') },
      { s: [1, 2, 3], t: times('08:06', '08:11', '08:16') },
    ]);
    const [j] = run(net, 0, [3], '07:59');
    expect(j.arr).toBe(min('08:16'));
  });

  it('returns the Pareto set: one train later vs two trains sooner', () => {
    const net = tinyNetwork([
      { s: [0, 1, 2, 3], t: times('08:00', '08:10', '08:20', '08:30') },
      { s: [0, 1], t: times('08:00', '08:03') },
      { s: [1, 2, 3], t: times('08:05', '08:08', '08:11') },
    ]);
    const js = run(net, 0, [3], '07:59');
    expect(js.map((j) => [j.trains, j.arr / 60])).toEqual([
      [1, 8 * 60 + 30],
      [2, 8 * 60 + 11],
    ]);
  });

  it('walks to a target that is near a station', () => {
    const net = tinyNetwork([{ s: [0, 1, 2, 3], t: times('08:00', '08:05', '08:10', '08:15') }]);
    const [j] = run(net, 0, [7], '07:59');
    expect(j.arr).toBe(min('08:15') + 300);
    expect(j.legs.at(-1)).toMatchObject({ kind: 'walk', from: 3, to: 7 });
  });

  it('skips surcharge trains when asked to', () => {
    const net = tinyNetwork([
      { s: [0, 3], t: times('08:00', '08:08'), ty: 1 },
      { s: [0, 1, 2, 3], t: times('08:00', '08:05', '08:10', '08:15') },
    ]);
    expect(run(net, 0, [3], '07:59')[0].arr).toBe(min('08:08'));
    expect(run(net, 0, [3], '07:59', { surcharge: false })[0].arr).toBe(min('08:15'));
  });

  it('keeps overtaking trains on separate routes so the faster one is found', () => {
    const net = tinyNetwork([
      // Same stops; the later train overtakes the earlier one.
      { s: [0, 1, 2, 3], t: times('08:00', '08:10', '08:20', '08:40') },
      { s: [0, 1, 2, 3], t: times('08:02', '08:06', '08:10', '08:14') },
    ]);
    const tt = buildTimetable(net, (i) => (net.trips[i].cal & 1) !== 0);
    expect(tt.nRoutes).toBe(2);
    expect(run(net, 0, [3], '07:59')[0].arr).toBe(min('08:14'));
  });

  it('ignores trips that do not run on the day type', () => {
    const net = tinyNetwork([
      { s: [0, 3], t: times('08:00', '08:05'), cal: 6 },
      { s: [0, 3], t: times('08:30', '08:35'), cal: 1 },
    ]);
    expect(run(net, 0, [3], '07:59')[0].arr).toBe(min('08:35'));
  });

  it('reports nothing when the target cannot be reached', () => {
    const net = tinyNetwork([{ s: [0, 1], t: times('08:00', '08:05') }]);
    expect(run(net, 0, [6], '07:59')).toEqual([]);
  });
});

describe('raptor with walking to the destination', () => {
  it('weighs the walk from each final stop', () => {
    // Two trains: one to stop 2 (then a long walk), one a little later to stop 3 (then a short walk).
    const net = tinyNetwork([
      { s: [0, 2], t: times('08:00', '08:10') },
      { s: [0, 3], t: times('08:05', '08:15') },
    ]);
    const tt = buildTimetable(net, (i) => (net.trips[i].cal & 1) !== 0);
    const [j] = raptor(tt, {
      sources: [{ stop: 0, time: min('07:55') }],
      targets: [
        { stop: 2, extra: 900 },
        { stop: 3, extra: 60 },
      ],
      maxRounds: 3,
      allowSurcharge: true,
      minChangeSec: 60,
    });
    expect(j.target).toBe(3);
    expect(j.arr).toBe(min('08:15') + 60);
  });
});
