import type { Preference, RideLeg, TripOption, WalkLeg, WalkSegment } from '../shared/api.ts';
import { clock, metres, minutes } from './format.ts';
import type { I18n, Key } from './i18n.ts';

/** One walking instruction in words: "左に曲がり、地蔵通りを右側の歩道（日陰）で70m". */
export function segmentText(s: WalkSegment, i: I18n, pref: Preference, first: boolean, withShade = true): string {
  const { t, name, lang } = i;
  const parts: string[] = [];
  if (!first && s.turn && s.turn !== 'straight') parts.push(t(`turn_${s.turn}` as Key));
  const where = s.name ? t('alongStreet', { name: name(s.name) }) : '';
  let how = '';
  if (s.side !== 'either') how = t(`side_${s.side}${pref === 'warm' ? '_warm' : ''}` as Key);
  const extras: string[] = [];
  if (s.shelter) extras.push(t(s.shelter as Key));
  if (s.stairs) extras.push(t('stairsStep'));
  if (s.elevator) extras.push(t('elevator'));
  if (s.escalator) extras.push(t('escalator'));
  if (s.steep) extras.push(t('steep'));
  if (s.kerb) extras.push(t('kerb'));
  if (s.signals) extras.push(t('signals', { n: s.signals }));
  if (!s.shelter && withShade) extras.push(shadeWord(s, i));
  // A few metres of stairs or a lift is a step, not a distance.
  const dist = s.metres >= 5 ? metres(s.metres, lang) : '';
  if (lang === 'ja') {
    const head = parts.length ? `${parts.join('、')}、` : '';
    if (!dist) return `${head}${extras.join('・')}`;
    return `${head}${where}${how ? `${how}で` : ''}${dist}${extras.length ? `（${extras.join('・')}）` : ''}`;
  }
  const head = parts.length ? `${parts.join(', ')}, ` : '';
  return `${head}${dist}${where ? ` ${where}` : ''}${how ? `, ${how}` : ''}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

export function shadeWord(s: WalkSegment, i: I18n): string {
  if (s.sun === null) return i.t('unknownShade');
  if (s.sun < 0.25) return i.t('shady');
  if (s.sun < 0.65) return i.t('partly');
  return i.t('sunny');
}

function walkText(l: WalkLeg, i: I18n, pref: Preference): string[] {
  const { t, name, lang } = i;
  if (l.inStation) return [t('inStation', { min: minutes(l.seconds, lang) })];
  const out = [
    `${t('walkTo', { place: name(l.to) })}: ${t('walkMinutes', { min: minutes(l.seconds, lang), m: metres(l.metres, lang) })}${
      pref === 'cool' ? `, ${l.sunSeconds < 30 ? t('allShade') : t('sunOnWalk', { min: minutes(l.sunSeconds, lang) })}` : ''
    }`,
  ];
  l.segments.forEach((s, k) => out.push(segmentText(s, i, pref, k === 0)));
  if (l.entrance?.exit) out.push(t('exit', { exit: l.entrance.exit }));
  return out;
}

function rideText(r: RideLeg, i: I18n): string[] {
  const { t, name, lang } = i;
  const line = r.mode === 'bus' ? `${name(r.line.operator)} ${r.line.name.ja}` : name(r.line.name);
  const out: string[] = [];
  if (r.wait.seconds >= 60) out.push(t(r.wait.outdoor ? 'waitStop' : 'waitPlatform', { min: minutes(r.wait.seconds, lang) }));
  out.push(`${clock(r.dep)} ${t('board', { stop: name(r.from.name) })}: ${t('ride', { line, dest: name(r.destination) })}`);
  out.push(`${clock(r.arr)} ${t('getOff', { stop: name(r.to.name) })}（${t(r.mode === 'bus' ? 'rideStopsBus' : 'rideStops', { n: r.stops })}）`);
  return out;
}

/** The whole trip as plain lines, for reading aloud and for sending. */
export function tripLines(o: TripOption, i: I18n, pref: Preference): string[] {
  const { t } = i;
  const out: string[] = [`${clock(o.leave)} ${t('leaveHome')}。${pref === 'warm' ? t('leaveAdviceWarm') : t('leaveAdvice')}`];
  for (const l of o.legs) out.push(...(l.kind === 'walk' ? walkText(l, i, pref) : rideText(l, i)));
  out.push(`${clock(o.arrive)} ${t('arrive')}`);
  return out;
}

export function shareText(o: TripOption, i: I18n, pref: Preference, from: string, to: string, url: string): string {
  const { t, lang } = i;
  const head = [
    `【${t('appName')}】${t('shareTitle', { from, to })}`,
    `${clock(o.leave)} → ${clock(o.arrive)}（${minutes(o.seconds, lang)}）`,
    pref === 'cool' ? `${t('inSun')}: ${minutes(o.sunSeconds, lang)}` : '',
  ].filter(Boolean);
  const rides = o.legs.filter((l): l is RideLeg => l.kind === 'ride').flatMap((r) => rideText(r, i));
  return [...head, '', ...rides, '', url].join('\n');
}
