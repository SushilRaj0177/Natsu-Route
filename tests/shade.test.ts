import { describe, expect, it } from 'vitest';
import { sunPosition, sunVector } from '../src/server/shade/sun.ts';
import { DECK, ShadeEngine, TREE } from '../src/server/shade/casters.ts';
import { casters } from './helpers.ts';

const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Sun from a given azimuth and elevation. */
const sun = (azimuth: number, elevation: number) => sunVector({ azimuth, elevation });

describe('sun position', () => {
  it('stands high in the south at noon on the summer solstice in Tokyo', () => {
    // Local solar noon in Tokyo is about 11:43 JST in late June.
    const p = sunPosition(Date.UTC(2026, 5, 21, 2, 43), 35.68, 139.77);
    expect(p.elevation).toBeGreaterThan(77);
    expect(p.elevation).toBeLessThan(78.5);
    expect(Math.abs(p.azimuth - 180)).toBeLessThan(6);
  });

  it('is low in the winter', () => {
    const p = sunPosition(Date.UTC(2026, 11, 21, 2, 39), 35.68, 139.77);
    expect(p.elevation).toBeGreaterThan(30);
    expect(p.elevation).toBeLessThan(31.6);
  });

  it('rises in the east-north-east before 5 am in midsummer', () => {
    // 2026-07-01 04:30 JST: sunrise in Tokyo is around 04:28.
    const p = sunPosition(Date.UTC(2026, 5, 30, 19, 30), 35.68, 139.77);
    expect(p.elevation).toBeGreaterThan(-1);
    expect(p.elevation).toBeLessThan(1.5);
    expect(p.azimuth).toBeGreaterThan(55);
    expect(p.azimuth).toBeLessThan(70);
  });
});

describe('shade engine', () => {
  // A 20 m building north of the origin: x 0..10, y 10..20.
  const eng = new ShadeEngine(casters([{ ring: box(0, 10, 10, 20), zhi: 20 }]));

  it('shades a spot when the building stands between it and the sun', () => {
    expect(eng.light(5, 0, sun(0, 45))).toBe(0);
  });

  it('leaves a spot in the sun once the shadow is too short to reach it', () => {
    // At 45° a 20 m building casts ~19 m of shadow (to chest height); 35 m away is clear.
    expect(eng.light(5, -25, sun(0, 45))).toBe(1);
  });

  it('leaves a spot in the sun when the ray passes beside the building', () => {
    expect(eng.light(15, 0, sun(0, 45))).toBe(1);
  });

  it('casts long shadows when the sun is low', () => {
    expect(eng.light(5, -25, sun(0, 15))).toBe(0);
  });

  it('is dark at night', () => {
    expect(eng.light(5, -25, sun(0, -5))).toBe(0);
  });

  it('shades a spot under an elevated deck but not one the low sun reaches beneath it', () => {
    const deck = new ShadeEngine(casters([{ ring: box(-50, 0, 50, 20), zlo: 8, zhi: 10, kind: DECK }]));
    // Directly under the deck, high sun: shaded.
    expect(deck.light(0, 10, sun(0, 60))).toBe(0);
    // South of the deck, low sun from the north passes under it (ray from 1.2 m
    // chest height crosses the deck outline at 1.5..6.8 m, below the deck).
    expect(deck.light(0, -1, sun(0, 15))).toBe(1);
  });

  it('lets some light through tree crowns', () => {
    const tree = new ShadeEngine(casters([{ ring: box(-3, 2, 3, 8), zlo: 2.5, zhi: 9, kind: TREE }]));
    const l = tree.light(0, 0, sun(0, 60));
    expect(l).toBeGreaterThan(0.1);
    expect(l).toBeLessThan(0.3);
  });

  it('knows when a spot is inside a building outline', () => {
    expect(eng.insideBuilding(5, 15)).toBe(true);
    expect(eng.insideBuilding(5, 5)).toBe(false);
  });
});
