/**
 * Download every source the build needs into data/raw/.
 *
 *   npm run data:fetch            # skips files fetched in the last 20 hours
 *   npm run data:fetch -- --force
 *
 * ODPT serves whole datasets as dumps (`odpt:Type.json`), which avoids the
 * 1,000-record cap on ordinary queries. Files are streamed to disk.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadEnv } from './lib/env.ts';

loadEnv();
const RAW = new URL('../data/raw/', import.meta.url).pathname;
const FORCE = process.argv.includes('--force');
const FRESH_MS = 20 * 3600 * 1000;

const TYPES = [
  'Operator', 'Railway', 'Station', 'TrainType', 'TrainTimetable',
  'StationTimetable', 'RailwayFare',
  'BusstopPole', 'BusroutePattern', 'BusTimetable', 'BusroutePatternFare',
];

const ENDPOINTS = [
  { dir: 'std', base: 'https://api.odpt.org/api/v4/', key: process.env.ODPT_API_KEY },
  { dir: 'chal', base: 'https://api-challenge.odpt.org/api/v4/', key: process.env.ODPT_CHALLENGE_TOKEN },
];

async function download(url: string, dest: string, label: string) {
  if (!FORCE && existsSync(dest) && Date.now() - statSync(dest).mtimeMs < FRESH_MS) {
    console.log(`  fresh   ${label}`);
    return;
  }
  const t = Date.now();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, dest);
  console.log(`  fetched ${label} ${(statSync(dest).size / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

async function main() {
  const jobs: Promise<void>[] = [];
  for (const ep of ENDPOINTS) {
    if (!ep.key) {
      console.warn(`! ${ep.dir}: no key set (see .env.example); skipping that endpoint`);
      continue;
    }
    mkdirSync(`${RAW}${ep.dir}`, { recursive: true });
    for (const t of TYPES) {
      const url = `${ep.base}odpt:${t}.json?acl:consumerKey=${encodeURIComponent(ep.key)}`;
      jobs.push(download(url, `${RAW}${ep.dir}/${t}.json`, `${ep.dir}/${t}`));
    }
  }
  mkdirSync(`${RAW}mlit`, { recursive: true });
  jobs.push(download('https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-24/N02-24_GML.zip', `${RAW}mlit/N02-24.zip`, 'mlit/N02-24'));
  jobs.push(download('https://holidays-jp.github.io/api/v1/date.json', `${RAW}holidays.json`, 'holidays'));
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) console.error('x', (f as PromiseRejectedResult).reason.message);
  if (failed.length) process.exit(1);
}

main();
