/**
 * What shade-aware routing changes across the 23 wards, measured.
 *
 *   npx tsx pipeline/tools/study.ts [trips=200] [walks=400]
 *
 * On the hottest replayed day (or the one given as REPLAY=YYYY-MM-DD):
 *
 * 1. Bus stops: how many stand in full sun at 10:00, 12:00 and 14:00, and
 *    how many have a roof (OpenStreetMap shelter tags, PLATEAU roofs).
 * 2. Walks: random walks of 400-1,200 m inside the wards, fastest path vs.
 *    heat-weighted path, at 10:00, 13:00 and 16:00.
 * 3. Door to door: random trips 1.5-7 km apart planned at 13:00, the
 *    fastest option vs. the coolest the planner offers.
 *
 * Writes data/build/study.json and docs/study.md. Random choices are seeded,
 * so reruns on the same data give the same numbers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadApp } from '../../src/server/load.ts';
import { sunBucket } from '../../src/server/walk/exposure.ts';
import { walkSearch, walkTo, type WalkPrefs } from '../../src/server/walk/search.ts';
import { toLonLat, toXY } from '../../src/shared/proj.ts';
import { instantOf } from '../../src/server/time.ts';
import { SUN_WEIGHT, levelOf } from '../../src/server/heat.ts';

const DIR = new URL('../../data/build', import.meta.url).pathname;
const DOCS = new URL('../../docs/', import.meta.url).pathname;
const TRIPS = Number(process.argv[2] ?? 200);
const WALKS = Number(process.argv[3] ?? 400);

// Small seeded generator (mulberry32) so the study is repeatable.
let seed = 20260722;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

const app = loadApp(DIR, console.log);
const replay = process.env.REPLAY ? app.heat.replays.find((r) => r.date === process.env.REPLAY)! : app.heat.replays[0];
if (!replay) throw new Error('no replay days: run npm run data:replay');
console.log(`study day ${replay.date} (${replay.label.en})`);
const at = (hour: number, minute = 0) => instantOf(replay.date, hour * 60 + minute).getTime();

// Points inside the wards with building data: walking nodes the shade engine covers.
const shade = app.exposure.shade;
const g = app.graph;
const inWards = app.transit.data.stations.filter((s) => s.wards).map((s) => toXY(s.lon, s.lat));
function randomPoint(): [number, number] {
  // Near a random bus stop inside the wards, so points are spread where people live.
  for (;;) {
    const [x, y] = inWards[Math.floor(rand() * inWards.length)];
    const p: [number, number] = [x + (rand() - 0.5) * 600, y + (rand() - 0.5) * 600];
    if (shade.covers(p[0], p[1])) return p;
  }
}

// ---------------------------------------------------------------- 1. bus stops
const poles = [...app.access.poles.entries()].filter(([s]) => app.transit.data.stations[s].wards);
const busStops: Record<string, { sunny: number; total: number }> = {};
for (const hour of [10, 12, 14]) {
  const b = sunBucket(at(hour));
  let sunny = 0;
  for (const [s, info] of poles) {
    if (info.sheltered) continue;
    const st = app.transit.data.stations[s];
    const [x, y] = toXY(st.lon, st.lat);
    if (shade.light(x, y, b.sun) > 0.5) sunny++;
  }
  busStops[`${hour}:00`] = { sunny, total: poles.length };
}
const roofed = poles.filter(([, i]) => i.sheltered === true).length;
const roofKnown = poles.filter(([, i]) => i.sheltered !== null).length;
console.log('bus stops', busStops, `roofed ${roofed}/${roofKnown} known of ${poles.length}`);

// ---------------------------------------------------------------- 2. walks
const walkResults: Record<string, { n: number; sunFast: number; sunCool: number; extraSec: number; reductions: number[]; extras: number[] }> = {};
for (const hour of [10, 13, 16]) {
  const ms = at(hour);
  const level = levelOf(app.heat.replayAt(replay, ms, '44132')?.wbgt ?? 28);
  const w = SUN_WEIGHT[level];
  const res = { n: 0, sunFast: 0, sunCool: 0, extraSec: 0, reductions: [] as number[], extras: [] as number[] };
  let tries = 0;
  while (res.n < WALKS / 3 && tries++ < WALKS * 3) {
    const [ax, ay] = randomPoint();
    const ang = rand() * Math.PI * 2;
    const dist = 400 + rand() * 800;
    const bx = ax + Math.cos(ang) * dist;
    const by = ay + Math.sin(ang) * dist;
    if (!shade.covers(bx, by)) continue;
    const a = g.snap(ax, ay, 150);
    const b = g.snap(bx, by, 150);
    if (!a || !b) continue;
    const base: WalkPrefs = { speed: 1.0, stairs: 'avoid', preference: 'cool', weight: 0 };
    const fast = walkTo(g, app.exposure, walkSearch(g, app.exposure, a, ms, base, 1800), b);
    const cool = walkTo(g, app.exposure, walkSearch(g, app.exposure, a, ms, { ...base, weight: w }, 1800), b);
    if (!fast || !cool || fast.unknown > 0 || cool.unknown > 0 || fast.sun < 30) continue;
    res.n++;
    res.sunFast += fast.sun;
    res.sunCool += cool.sun;
    res.extraSec += cool.time - fast.time;
    res.reductions.push(1 - cool.sun / fast.sun);
    res.extras.push(cool.time - fast.time);
  }
  walkResults[`${hour}:00`] = res;
  console.log(`walks ${hour}:00 (${level}, weight ${w}): n=${res.n} sun ${r1(res.sunFast / res.n / 60)} → ${r1(res.sunCool / res.n / 60)} min, median cut ${pct(median(res.reductions), 1)}%, +${r1(median(res.extras))} s`);
}

// ---------------------------------------------------------------- 3. door to door
const trips: { fastSun: number; coolSun: number; fastMin: number; coolMin: number; same: boolean }[] = [];
let attempts = 0;
const t0 = Date.now();
while (trips.length < TRIPS && attempts++ < TRIPS * 3) {
  const [ax, ay] = randomPoint();
  const [bx, by] = randomPoint();
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 1500 || d > 7000) continue;
  const [alon, alat] = toLonLat(ax, ay);
  const [blon, blat] = toLonLat(bx, by);
  try {
    // Today's timetable at 13:00, with the replayed day's heat and sun.
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const res = await app.planner.plan({
      from: { lat: alat, lon: alon },
      to: { lat: blat, lon: blon },
      at: instantOf(today, 13 * 60).toISOString(),
      replay: replay.date,
      speed: 1.0,
      stairs: 'avoid',
    });
    const fastest = res.options.find((o) => o.labels.includes('fastest'));
    const coolest = res.options.find((o) => o.labels.includes('coolest')) ?? fastest;
    if (!fastest || !coolest || fastest.partialShade) continue;
    trips.push({ fastSun: fastest.sunSeconds, coolSun: coolest.sunSeconds, fastMin: fastest.seconds / 60, coolMin: coolest.seconds / 60, same: fastest === coolest });
    if (trips.length % 20 === 0) console.log(`  ${trips.length} trips (${Math.round((Date.now() - t0) / trips.length)} ms each)`);
  } catch {
    /* unreachable pair: skip */
  }
}
const withSun = trips.filter((t) => t.fastSun >= 60);
const tripSummary = {
  n: trips.length,
  coolerOffered: trips.filter((t) => !t.same).length,
  medianSunFastestMin: r1(median(trips.map((t) => t.fastSun / 60))),
  medianSunCoolestMin: r1(median(trips.map((t) => t.coolSun / 60))),
  meanSunCutPct: pct(mean(withSun.map((t) => 1 - t.coolSun / t.fastSun)), 1),
  medianSunCutMin: r1(median(trips.map((t) => (t.fastSun - t.coolSun) / 60))),
  medianExtraMin: r1(median(trips.filter((t) => !t.same).map((t) => t.coolMin - t.fastMin))),
};
console.log('door to door', tripSummary);

const walkSummary = Object.fromEntries(
  Object.entries(walkResults).map(([h, r]) => [
    h,
    { n: r.n, meanSunFastestMin: r1(r.sunFast / r.n / 60), meanSunCoolMin: r1(r.sunCool / r.n / 60), medianCutPct: pct(median(r.reductions), 1), medianExtraSec: Math.round(median(r.extras)) },
  ]),
);
const study = {
  day: replay.date,
  label: replay.label,
  generatedAt: new Date().toISOString(),
  busStops: { byHour: busStops, roofed, roofKnown, total: poles.length },
  walks: walkSummary,
  trips: tripSummary,
};
mkdirSync(DOCS, { recursive: true });
writeFileSync(`${DIR}/study.json`, JSON.stringify(study, null, 1));

const busRows = Object.entries(busStops).map(([h, v]) => `| ${h} | ${v.sunny.toLocaleString()} / ${v.total.toLocaleString()} | ${pct(v.sunny, v.total)}% |`);
const walkRows = Object.entries(walkSummary).map(([h, v]) => `| ${h} | ${v.n} | ${v.meanSunFastestMin} | ${v.meanSunCoolMin} | ${v.medianCutPct}% | ${v.medianExtraSec} s |`);
writeFileSync(
  `${DOCS}study.md`,
  `# What shade-aware routing changes

Generated by \`pipeline/tools/study.ts\` on ${study.generatedAt.slice(0, 10)}, for the heat and sun of ${replay.date} (${replay.label.en}; ${replay.label.ja}). Random points are seeded, so the numbers repeat on the same data.

## Bus stops in the sun

Bus stops in the 23 wards (${poles.length.toLocaleString()} poles) whose waiting spot is in direct sun, out of all stops. A roof is known for ${roofKnown.toLocaleString()} of them from OpenStreetMap or PLATEAU; ${roofed.toLocaleString()} have one.

| Time | Stops in sun | Share |
|---|---|---|
${busRows.join('\n')}

## Walks of 400–1,200 m

Random walks inside the wards. "Fastest" is the shortest walking path; "cooler" is the path NatsuRoute picks for the heat index at that hour. Walks with under 30 seconds of sun on the fastest path are left out.

| Time | Walks | Sun, fastest (min) | Sun, cooler (min) | Median cut in sun | Median extra walking |
|---|---|---|---|---|---|
${walkRows.join('\n')}

## Door to door at 13:00

${tripSummary.n} random trips 1.5–7 km apart inside the wards, planned with the timetables of ${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)} and that day's heat and sun. NatsuRoute offered a cooler option than the fastest in ${tripSummary.coolerOffered} of them.

- Median time in the sun: fastest ${tripSummary.medianSunFastestMin} min, coolest ${tripSummary.medianSunCoolestMin} min
- Median minutes of sun saved: ${tripSummary.medianSunCutMin}; mean cut where the fastest had at least a minute of sun: ${tripSummary.meanSunCutPct}%
- Median extra door-to-door time when a cooler option was offered: ${tripSummary.medianExtraMin} min

## Limits

Shade comes from PLATEAU buildings and decks and from the trees PLATEAU and OpenStreetMap have; awnings, signs and clouds are not modelled, and tree cover is incomplete, so real streets are somewhat shadier than this. Results describe the model, not measured exposure.
`,
);
console.log('wrote data/build/study.json and docs/study.md');
