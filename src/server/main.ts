/**
 * NatsuRoute server: the trip planner API, the heat and shade endpoints, and
 * the built web app.
 *
 *   npm run dev      (API on :8787, web on :5173 with a proxy)
 *   npm run build && npm start
 */
import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadApp } from './load.ts';
import { LiveData } from './live.ts';
import { createApp } from './app.ts';

function loadEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnv();
const dataDir = process.env.DATA_DIR ?? 'data/build';
for (const f of ['network.json', 'geo/casters.pack', 'geo/walk.pack']) {
  if (!existsSync(`${dataDir}/${f}`)) {
    console.error(`Missing ${dataDir}/${f}. Run \`npm run geo\` and \`npm run data\` first (see README).`);
    process.exit(1);
  }
}

const core = loadApp(dataDir, console.log);
// Build today's timetable now so the first request is quick.
core.transit.timetable(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10));

const endpoints = [
  { base: 'https://api.odpt.org/api/v4/', key: process.env.ODPT_API_KEY ?? '' },
  { base: 'https://api-challenge.odpt.org/api/v4/', key: process.env.ODPT_CHALLENGE_TOKEN ?? '' },
].filter((e) => e.key);
const live = new LiveData(core.transit, endpoints);
core.planner.attachLive(live);
if (process.env.LIVE !== 'off') live.start();
if (!endpoints.length) console.warn('No ODPT keys set: live status and delays are off.');

const app = createApp({ app: core, live, contact: process.env.CONTACT_EMAIL });
if (existsSync('dist/web/index.html')) {
  app.use('/*', serveStatic({ root: 'dist/web' }));
  app.get('*', serveStatic({ path: 'dist/web/index.html' }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`NatsuRoute on http://localhost:${port}`));
