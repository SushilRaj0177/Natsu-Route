import { describe, expect, it } from 'vitest';
import { ShadeEngine } from '../src/server/shade/casters.ts';
import { F_STEPS, WalkGraph, type WalkData } from '../src/server/walk/graph.ts';
import { ExposureModel } from '../src/server/walk/exposure.ts';
import { walkSearch, walkTo, type WalkPrefs } from '../src/server/walk/search.ts';
import { casters } from './helpers.ts';

/** A walking network from straight edges between numbered points. */
function network(points: [number, number][], edges: { a: number; b: number; cls?: number; flags?: number }[]): WalkData {
  const geom: number[] = [];
  const gstart: number[] = [];
  for (const e of edges) {
    gstart.push(geom.length / 2);
    geom.push(...points[e.a], ...points[e.b]);
  }
  return {
    nodeXY: Float32Array.from(points.flat()),
    u: Uint32Array.from(edges.map((e) => e.a)),
    v: Uint32Array.from(edges.map((e) => e.b)),
    length: Float32Array.from(edges.map((e) => Math.hypot(points[e.b][0] - points[e.a][0], points[e.b][1] - points[e.a][1]))),
    flags: Uint16Array.from(edges.map((e) => e.flags ?? 0)),
    cls: Uint8Array.from(edges.map((e) => e.cls ?? 6)),
    width: new Float32Array(edges.length),
    name: new Int32Array(edges.length).fill(-1),
    signals: new Uint8Array(edges.length),
    gstart: Uint32Array.from(gstart),
    glen: new Uint16Array(edges.length).fill(2),
    geom: Float32Array.from(geom),
  };
}

// Noon at the August peak of heat: the sun stands high in the south.
const NOON = Date.UTC(2026, 7, 5, 2, 45);

// Two ways from A (0,0) to B (100,0): straight along y=0 in the sun, or a
// detour along y=30, in the shadow of a 40 m block standing between them.
const points: [number, number][] = [[0, 0], [100, 0], [0, 30], [100, 30]];
const edges = [
  { a: 0, b: 1 },
  { a: 0, b: 2 },
  { a: 2, b: 3 },
  { a: 3, b: 1 },
];
const block = casters([{ ring: [[10, 5], [90, 5], [90, 25], [10, 25]], zhi: 40 }]);

function setup(extraEdges = edges, pts = points) {
  const g = new WalkGraph(network(pts, extraEdges));
  const x = new ExposureModel(g, new ShadeEngine(block));
  return { g, x };
}

const prefs = (weight: number, extra: Partial<WalkPrefs> = {}): WalkPrefs => ({ speed: 1, stairs: 'ok', preference: 'cool', weight, ...extra });

describe('heat-aware walking', () => {
  it('takes the short sunny way when shade is not weighted', () => {
    const { g, x } = setup();
    const from = g.snap(0, 0)!;
    const to = g.snap(100, 0)!;
    const tree = walkSearch(g, x, from, NOON, prefs(0), 3600);
    const w = walkTo(g, x, tree, to)!;
    expect(Math.round(w.metres)).toBe(100);
    expect(w.sun).toBeGreaterThan(90);
  });

  it('takes the shaded detour when the sun is weighted', () => {
    const { g, x } = setup();
    const from = g.snap(0, 0)!;
    const to = g.snap(100, 0)!;
    const tree = walkSearch(g, x, from, NOON, prefs(4), 3600);
    const w = walkTo(g, x, tree, to)!;
    expect(Math.round(w.metres)).toBe(160);
    // Only the two 30 m connectors and the ends beyond the block are in sun.
    expect(w.sun).toBeCloseTo(80, 0);
    expect(w.steps.map((s) => s.edge)).toEqual([1, 2, 3]);
  });

  it('prefers the sunny way when warmth is wanted (winter)', () => {
    const { g, x } = setup();
    const tree = walkSearch(g, x, g.snap(0, 0)!, NOON, prefs(4, { preference: 'warm' }), 3600);
    const w = walkTo(g, x, tree, g.snap(100, 0)!)!;
    expect(Math.round(w.metres)).toBe(100);
  });

  it('finds the same walk searching backward from the destination', () => {
    const { g, x } = setup();
    const back = walkSearch(g, x, g.snap(100, 0)!, NOON + 160_000, prefs(4), 3600, -1);
    const w = walkTo(g, x, back, g.snap(0, 0)!)!;
    expect(w.steps.map((s) => s.edge)).toEqual([1, 2, 3]);
    expect(w.steps[0].forward).toBe(true);
    expect(w.steps.at(-1)!.forward).toBe(true);
  });

  it('never uses steps for someone who cannot', () => {
    const pts: [number, number][] = [[0, 0], [100, 0], [0, 200], [100, 200]];
    const es = [
      { a: 0, b: 1, flags: F_STEPS },
      { a: 0, b: 2 },
      { a: 2, b: 3 },
      { a: 3, b: 1 },
    ];
    const { g, x } = setup(es, pts);
    const w = walkTo(g, x, walkSearch(g, x, g.snap(0, 0)!, NOON, prefs(0, { stairs: 'never' }), 3600), g.snap(100, 0)!)!;
    expect(w.steps.some((s) => s.edge === 0)).toBe(false);
  });

  it('starts and ends partway along edges', () => {
    const { g, x } = setup();
    const from = g.snap(20, 1)!;
    const to = g.snap(70, -1)!;
    expect(from.edge).toBe(0);
    const w = walkTo(g, x, walkSearch(g, x, from, NOON, prefs(0), 3600), to)!;
    expect(Math.round(w.metres)).toBe(50);
  });

  it('tells which pavement is shadier on a road', () => {
    // An east-west road with a tall block right along its south side; noon sun from the south.
    const pts: [number, number][] = [[0, 0], [100, 0]];
    const g = new WalkGraph({ ...network(pts, [{ a: 0, b: 1, cls: 4 }]), width: Float32Array.from([8]) });
    const shade = new ShadeEngine(casters([{ ring: [[0, -30], [100, -30], [100, -6], [0, -6]], zhi: 20 }]));
    const x = new ExposureModel(g, shade);
    const tree = walkSearch(g, x, g.snap(0, 0)!, NOON, prefs(2), 3600);
    const w = walkTo(g, x, tree, g.snap(100, 0)!)!;
    // Walking east, the south pavement is on the right.
    expect(w.steps[0].cost.side).toBe('right');
  });
});
