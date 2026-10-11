import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import type { HeatLevel, PlanQuery, TimeOfDayPoint } from '../shared/api.ts';
import type { App } from './load.ts';
import type { LiveData } from './live.ts';
import { PlanError } from './planner.ts';
import { PlaceSearch, nameOfPoint, searchAddress } from './places.ts';
import { HeatService, levelOf, nearestPoint, POINTS } from './heat.ts';
import { renderShadeTile } from './shade/tiles.ts';
import { sunBucket } from './walk/exposure.ts';
import { instantOf, serviceTime } from './time.ts';

export interface AppOptions {
  app: App;
  live?: LiveData;
  /** Shown on the About page as the developer contact (ODPT's guideline asks for one). */
  contact?: string;
}

/** Small per-IP limiter so a public deployment cannot be hammered. */
function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      hits.set(ip, { n: 1, reset: now + 60_000 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    return ++h.n <= perMinute;
  };
}

/** Least-recently-used cache. */
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

const inTokyo = (lat: unknown, lon: unknown) =>
  typeof lat === 'number' && typeof lon === 'number' && lat > 35.3 && lat < 36.1 && lon > 139.2 && lon < 140.3;

export function createApp({ app: core, live, contact }: AppOptions) {
  const app = new Hono();
  const allow = rateLimit(300);
  const allowPlan = rateLimit(40);
  const search = new PlaceSearch(core.transit, core.pois);
  const tiles = new Lru<Buffer>(4000);
  const bestTimes = new Lru<TimeOfDayPoint[]>(200);

  app.use('*', secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: undefined }));
  app.use('/api/*', compress());
  app.use('/api/*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
    if (!allow(ip)) return c.json({ error: 'Too many requests' }, 429);
    await next();
  });
  const ipOf = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';

  app.get('/api/health', (c) => c.json({ ok: true, builtAt: core.transit.data.builtAt, liveFetchedAt: live?.fetchedAt ?? null }));

  app.get('/api/places', async (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 80);
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    const near = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
    let hits = search.search(q, near, 10);
    // Something that looks like an address: ask GSI as well.
    if (/[0-9０-９丁目番地号区町]/.test(q) && q.length >= 3) hits = [...hits.slice(0, 6), ...(await searchAddress(q))];
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(hits);
  });

  app.get('/api/reverse', async (c) => {
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    if (!inTokyo(lat, lon)) return c.json({ name: null });
    return c.json({ name: await nameOfPoint(lat, lon) });
  });

  const readQuery = async (c: { req: { json: () => Promise<unknown> } }): Promise<PlanQuery> => {
    const b = (await c.req.json().catch(() => null)) as PlanQuery | null;
    if (!b || !b.from || !b.to || !inTokyo(b.from.lat, b.from.lon) || !inTokyo(b.to.lat, b.to.lon) || typeof b.at !== 'string') {
      throw new PlanError('from, to (in Tokyo) and at are required');
    }
    return b;
  };

  app.post('/api/plan', async (c) => {
    if (!allowPlan(ipOf(c))) return c.json({ error: 'Too many requests' }, 429);
    try {
      const q = await readQuery(c);
      return c.json(await core.planner.plan(q));
    } catch (e) {
      if (e instanceof PlanError) return c.json({ error: e.message }, e.status as 400);
      console.error(e);
      return c.json({ error: 'planning failed' }, 500);
    }
  });

  /**
   * The same trip at other times of day: sun on the way and the heat index,
   * so a person can pick a cooler time to go.
   */
  app.post('/api/best-time', async (c) => {
    if (!allowPlan(ipOf(c))) return c.json({ error: 'Too many requests' }, 429);
    try {
      const q = await readQuery(c);
      const st = serviceTime(new Date(q.at));
      const key = JSON.stringify({ ...q, at: st.date });
      const hit = bestTimes.get(key);
      if (hit) return c.json(hit);
      const out: TimeOfDayPoint[] = [];
      for (const hour of [7, 9, 11, 13, 15, 17, 19]) {
        const at = instantOf(st.date, hour * 60).toISOString();
        const res = await core.planner.plan({ ...q, at, arriveBy: false });
        const best = res.options.find((o) => o.labels.includes('coolest') || o.labels.includes('sunniest')) ?? res.options[0];
        out.push({
          leave: best?.leave ?? at,
          sunSeconds: best?.sunSeconds ?? 0,
          wbgt: res.heat?.wbgt ?? null,
          level: res.heat?.level ?? null,
        });
      }
      bestTimes.set(key, out);
      return c.json(out);
    } catch (e) {
      if (e instanceof PlanError) return c.json({ error: e.message }, e.status as 400);
      console.error(e);
      return c.json({ error: 'failed' }, 500);
    }
  });

  /** Heat now and through the day where the person is. */
  app.get('/api/heat', async (c) => {
    const lat = Number(c.req.query('lat') ?? 35.68);
    const lon = Number(c.req.query('lon') ?? 139.76);
    const replayDate = c.req.query('replay');
    const replay = replayDate ? core.heat.replays.find((r) => r.date === replayDate) : undefined;
    const point = nearestPoint(lat, lon);
    const now = Date.now();
    const st = serviceTime(new Date(now));
    const date = replay?.date ?? st.date;
    const hours: { at: string; wbgt: number; level: HeatLevel; kind: string }[] = [];
    for (let h = 5; h <= 20; h++) {
      const ms = instantOf(date, h * 60).getTime();
      const v = replay ? core.heat.replayAt(replay, ms, point) : await core.heat.at(ms, point);
      if (v) hours.push({ at: new Date(ms).toISOString(), wbgt: v.wbgt, level: v.level, kind: v.kind });
    }
    const nowMs = replay ? instantOf(replay.date, Math.min(20 * 60, st.minute)).getTime() : now;
    const cur = replay ? core.heat.replayAt(replay, nowMs, point) : await core.heat.at(now, point);
    const alerts = replay ? { today: replay.alert, tomorrow: 'none' as const, issuedFor: replay.date } : await core.heat.alerts();
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({
      point: POINTS.find((p) => p.code === point)!.name,
      inSeason: HeatService.inSeason(now),
      now: cur ? { wbgt: cur.wbgt, level: levelOf(cur.wbgt), kind: cur.kind } : null,
      hours,
      alert: alerts ?? null,
      replay: replay ? { date: replay.date, label: replay.label } : null,
    });
  });

  app.get('/api/replays', (c) => c.json(core.heat.replays.map((r) => ({ date: r.date, label: r.label, alert: r.alert, peak: Math.max(...Object.values(r.hourly).flat().filter((v) => typeof v === 'number')) }))));

  /** Shade on the ground at one moment: /api/shade/{z}/{x}/{y}.png?t=<epoch ms of the sun> */
  app.get('/api/shade/:z/:x/:y', (c) => {
    const z = Number(c.req.param('z'));
    const x = Number(c.req.param('x'));
    const y = Number(c.req.param('y').replace(/\.png$/, ''));
    const t = Number(c.req.query('t') ?? Date.now());
    if (![z, x, y, t].every(Number.isFinite) || z < 14 || z > 19) return c.body(null, 404);
    const b = sunBucket(t);
    const key = `${z}/${x}/${y}/${b.key}`;
    let png = tiles.get(key);
    if (!png) {
      png = renderShadeTile(core.exposure.shade, z, x, y, b.sun, { color: [26, 38, 74], alpha: 0.42 });
      tiles.set(key, png);
    }
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  });

  app.get('/api/wards', (c) => {
    c.header('Cache-Control', 'public, max-age=86400');
    return c.json(core.wards ?? { type: 'FeatureCollection', features: [] });
  });

  app.get('/api/status', (c) =>
    c.json({
      fetchedAt: live?.fetchedAt ?? null,
      lines: (live?.lineStatuses() ?? []).map((s) => ({ ...s, line: core.planner.lineRef(s.railway) })),
      silentOperators: live?.silentOperators() ?? [],
    }),
  );

  app.get('/api/about', (c) => {
    const d = core.transit.data;
    const kinds: Record<string, number> = {};
    for (const p of core.pois) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const ops = d.operators.map((o) => ({ name: o.name, licence: o.licence, bus: !!o.bus, silver: !!o.silver, fares: o.fares }));
    return c.json({
      data: { builtAt: d.builtAt, timetableIssued: d.timetableIssued, geoBuiltAt: core.geoMeta.casters.builtAt },
      shade: core.geoMeta.casters,
      walk: core.geoMeta.walk,
      transit: {
        stations: d.stations.filter((s) => !s.pole).length,
        busStops: d.stations.filter((s) => s.pole).length,
        railTrips: d.trips.filter((t) => t.r === undefined).length,
        busTrips: d.trips.filter((t) => t.r !== undefined).length,
        busRoutes: d.railways.filter((r) => r.mode === 'bus').length,
        entrances: core.access.points.filter((p) => p.entrance).length,
        stationsWithEntrances: core.access.entranceStations,
      },
      pois: kinds,
      operators: ops,
      replays: core.heat.replays.map((r) => ({ date: r.date, label: r.label })),
      contact: contact ?? null,
    });
  });

  return app;
}
