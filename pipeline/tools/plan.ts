/**
 * Plan a trip from the command line against the built data.
 *
 *   npx tsx pipeline/tools/plan.ts <fromLat,fromLon> <toLat,toLon> [ISO time] [replay date]
 */
import { loadApp } from '../../src/server/load.ts';
import type { Leg } from '../../src/shared/api.ts';

const DIR = new URL('../../data/build', import.meta.url).pathname;
const [from, to, at, replay] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: plan.ts <lat,lon> <lat,lon> [time] [replay date]');
  process.exit(1);
}
const ll = (s: string) => {
  const [lat, lon] = s.split(',').map(Number);
  return { lat, lon };
};

const app = loadApp(DIR, console.log);
const t = Date.now();
const res = await app.planner.plan({
  from: ll(from),
  to: ll(to),
  at: at ?? new Date().toISOString(),
  replay,
  speed: 1.0,
  stairs: 'avoid',
  silverPass: true,
});
console.log(`\nplanned in ${Date.now() - t} ms; preference ${res.preference}; heat ${JSON.stringify(res.heat)}; sun ${JSON.stringify(res.sun)}`);
for (const n of res.notes) console.log('note:', n.en);
const hm = (iso: string) => iso.slice(11, 16);
const min = (s: number) => `${Math.round(s / 6) / 10} min`;
for (const o of res.options) {
  console.log(
    `\n[${o.labels.join(', ')}] leave ${hm(o.leave)} arrive ${hm(o.arrive)} (${min(o.seconds)}) — sun ${min(o.sunSeconds)}, outdoors ${min(o.outdoorSeconds)}, walk ${o.walkMetres} m, ${o.transfers} changes, stairs ${o.stairs}, fare ¥${o.fare.ic} (Silver Pass ¥${o.fare.withSilverPass})${o.vsFastest ? `, vs fastest +${min(o.vsFastest.extraSeconds)} longer, arrives +${min(o.vsFastest.laterSeconds)}, sun -${min(o.vsFastest.lessSunSeconds)}` : ''}`,
  );
  for (const l of o.legs as Leg[]) {
    if (l.kind === 'walk') {
      console.log(`   walk ${l.role} ${hm(l.dep)}-${hm(l.arr)} ${l.metres} m, sun ${min(l.sunSeconds)}${l.entrance ? `, exit ${l.entrance.exit ?? '?'} step-free ${l.entrance.stepFree}` : ''}${l.inStation ? ' (in station)' : ''}`);
      for (const s of l.segments) console.log(`      ${s.turn ?? ''} ${s.name?.ja ?? '-'} ${Math.round(s.metres)} m side ${s.side} sun ${s.sun === null ? '?' : Math.round(s.sun * 100) + '%'}${s.shelter ? ' ' + s.shelter : ''}${s.stairs ? ' STAIRS' : ''}`);
      if (l.rest.length) console.log(`      rest: ${l.rest.map((r) => `${r.kind}${r.name ? ':' + r.name.ja : ''}@${r.atMinute}m`).join(', ')}`);
    } else {
      console.log(`   ${l.mode} ${l.line.name.ja} ${l.service.ja} for ${l.destination.ja}: ${l.from.name.ja} ${hm(l.dep)} -> ${l.to.name.ja} ${hm(l.arr)} (${l.stops} stops)${l.nonStep ? ' non-step' : ''}${l.silverPass ? ' [Silver Pass]' : ''}; wait ${min(l.wait.seconds)}${l.wait.outdoor ? ` outdoors, sun ${Math.round(l.wait.sun * 100)}%, roof ${l.wait.sheltered}` : ''}`);
    }
  }
}
