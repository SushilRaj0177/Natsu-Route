import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeatService, levelOf, nearestPoint, parseActual, parseAlert, parseForecast } from '../src/server/heat.ts';
import { fold, PlaceSearch } from '../src/server/places.ts';
import { dayTypeOf } from '../src/server/time.ts';
import { Transit } from '../src/server/transit.ts';
import type { Poi } from '../src/server/access.ts';
import type { NetworkData } from '../src/shared/network.ts';
import { tinyNetwork, times } from './fixtures.ts';

/** JST wall clock -> epoch ms */
const jst = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - 9 * 3600_000;

// Lines in the Ministry's own formats (cut down from real files).
const FORECAST = [
  ',,2026101206,2026101209,2026101212,2026101215,2026101218,2026101221,2026101224',
  '44132,2026/10/12 05:25, 170, 210, 240, 220, 180, 180, 170',
].join('\r\n');
const ACTUAL = ['Date,Time,44132', '2026/7/1,13:00,26.3', '2026/7/1,24:00,22.3', '2026/7/2,1:00,', ''].join('\r\n');
const ALERT = [
  'Title,熱中症特別警戒情報・熱中症警戒情報,,,,,,,,,',
  'TargetDate1,2026/07/22,,,,,,,,,',
  'TargetDate2,2026/07/23,,,,,,,,,',
  '府県予報区,都府県・振興局表示番号,都府県・振興局表示番号サブ,府県予報区等コード,都道府県名,都道府県コード,TargetDate1フラグ,TargetDate2フラグ,日最高WBGT（10:00）,日最高WBGT（17:00）,日最高WBGT（5:00）',
  '宗谷地方,11,0,011000,北海道,01,0,9,宗谷岬:25/稚内:25,宗谷岬:24/稚内:25,宗谷岬:24/稚内:25',
  '東京都,44,0,130000,東京,13,1,9,練馬:35/東京:33/江戸川臨海:32,練馬:35/東京:35,練馬:34/東京:34',
].join('\r\n');

describe('heat index', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the guideline levels', () => {
    expect(levelOf(20.9)).toBe('safe');
    expect(levelOf(21)).toBe('caution');
    expect(levelOf(25)).toBe('warning');
    expect(levelOf(28)).toBe('severe');
    expect(levelOf(31)).toBe('danger');
  });

  it('reads forecasts in tenths, with hour 24 as midnight', () => {
    const f = parseForecast(FORECAST);
    expect(f.size).toBe(7);
    expect(f.get(jst(2026, 10, 12, 15))).toBe(22);
    expect(f.get(jst(2026, 10, 13, 0))).toBe(17);
  });

  it('reads hourly estimates and skips blanks', () => {
    const a = parseActual(ACTUAL);
    expect(a.size).toBe(2);
    expect(a.get(jst(2026, 7, 1, 13))).toBe(26.3);
    expect(a.get(jst(2026, 7, 2, 0))).toBe(22.3);
  });

  it("reads Tokyo's alert flags", () => {
    const a = parseAlert(ALERT)!;
    expect(a).toMatchObject({ date: '2026-07-22', today: 'alert', tomorrow: 'none' });
    expect(a.maxima['練馬']).toBe(35);
    expect(parseAlert(ALERT.replace('東京,13,1,9', '東京,13,3,1'))).toMatchObject({ today: 'special', tomorrow: 'alert' });
    expect(parseAlert('Title,x\r\n')).toBeNull();
  });

  it('picks the nearest observation point', () => {
    expect(nearestPoint(35.6812, 139.7671)).toBe('44132'); // Tokyo Station
    expect(nearestPoint(35.7356, 139.6517)).toBe('44071'); // Nerima
    expect(nearestPoint(35.6436, 139.8612)).toBe('44136'); // Kasai
  });

  it('knows the season', () => {
    expect(HeatService.inSeason(jst(2026, 4, 19, 12))).toBe(false);
    expect(HeatService.inSeason(jst(2026, 4, 20, 12))).toBe(true);
    expect(HeatService.inSeason(jst(2026, 10, 25, 12))).toBe(true);
    expect(HeatService.inSeason(jst(2026, 10, 26, 12))).toBe(false);
  });

  it('interpolates the forecast between 3-hourly values', async () => {
    vi.useFakeTimers({ now: jst(2026, 10, 12, 6) });
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('yohou_44132') ? new Response(FORECAST) : new Response('', { status: 404 }),
    ) as unknown as typeof fetch;
    const heat = new HeatService(undefined, fetcher);
    const v = await heat.at(jst(2026, 10, 12, 16, 30), '44132');
    expect(v).toMatchObject({ wbgt: 20, level: 'safe', kind: 'forecast' });
    // Cached: a second question does not fetch again.
    await heat.at(jst(2026, 10, 12, 13), '44132');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the alert issued this morning', async () => {
    vi.useFakeTimers({ now: jst(2026, 7, 22, 9) });
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).endsWith('alert_20260722_05.csv') ? new Response(ALERT) : new Response('', { status: 404 });
    }) as typeof fetch;
    const heat = new HeatService(undefined, fetcher);
    expect(await heat.alerts(jst(2026, 7, 22, 9))).toEqual({ today: 'alert', tomorrow: 'none', issuedFor: '2026-07-22' });
    expect(urls[0]).toContain('alert_20260722_05.csv');
  });

  it('replays a past day by the hour, falling back to Tokyo', () => {
    const heat = new HeatService();
    const replay = { date: '2026-07-22', label: { ja: '', en: '' }, hourly: { '44132': Array.from({ length: 24 }, (_, h) => 20 + h / 2) }, alert: 'alert' as const };
    expect(heat.replayAt(replay, jst(2026, 10, 14, 13, 40), '44071')).toMatchObject({ wbgt: 26.5, level: 'warning', kind: 'replay' });
  });
});

describe('place search', () => {
  it('folds width, case, katakana and punctuation', () => {
    expect(fold('ＳＵＧＡＭＯ')).toBe('sugamo');
    expect(fold('スガモ')).toBe('すがも');
    expect(fold('とげぬき 地蔵・高岩寺')).toBe('とげぬき地蔵高岩寺');
    expect(fold('霞ヶ関')).toBe(fold('霞ケ関'));
  });

  function search() {
    const net = tinyNetwork([{ s: [0, 1, 2, 3], t: times('10:00', '10:02', '10:04', '10:06') }]);
    net.places[0].name = { ja: '巣鴨', en: 'Sugamo' };
    net.stations[0].kana = 'すがも';
    const pois: Poi[] = [
      { kind: 'hospital', name: '東京都健康長寿医療センター', name_en: 'Tokyo Metropolitan Geriatric Hospital', lat: 35.75, lon: 139.7, x: 0, y: 0, src: 'osm' },
      { kind: 'konbini', name: 'コンビニ巣鴨店', lat: 35, lon: 139, x: 0, y: 0, src: 'osm' },
    ];
    return new PlaceSearch(new Transit(net, { hops: {}, railways: {}, patterns: [] }), pois);
  }

  it('finds a station by kanji, kana and romaji', () => {
    const s = search();
    for (const q of ['巣鴨', 'すがも', 'スガモ', 'sugamo', 'Sugamo']) expect(s.search(q)[0]?.name.ja, q).toBe('巣鴨駅');
  });

  it('finds named places by part of the name, but not kinds it does not offer', () => {
    const s = search();
    expect(s.search('健康長寿')[0]).toMatchObject({ kind: 'poi', name: { ja: '東京都健康長寿医療センター' } });
    expect(s.search('コンビニ')).toEqual([]);
    expect(s.search('  ')).toEqual([]);
  });
});

describe('transit', () => {
  const geometry = { hops: {}, railways: {}, patterns: [] };

  it('finds a rail fare through a sibling station of the same operator', () => {
    const net = tinyNetwork([]);
    // A second operator-A station at place 1 (as when two lines of one company meet).
    net.stations.push({ ...net.stations[1], id: 'C1', railway: 2 });
    net.places[1].stations.push(8);
    const t = new Transit(net, geometry);
    expect(t.railFare(0, 0, 3)).toEqual([200, 210]);
    expect(t.railFare(0, 0, 8)).toEqual([150, 160]);
    expect(t.railFare(1, 4, 5)).toBeUndefined();
  });

  it('prefers a bus fare for the pair over the flat fare', () => {
    const net = tinyNetwork([], { busFares: { flat: { 1: [210, 210] }, pairs: [[4, 6, 250, 250]] } } as Partial<NetworkData>);
    const t = new Transit(net, geometry);
    expect(t.busFare(1, 4, 5)).toEqual([210, 210]);
    expect(t.busFare(1, 4, 6)).toEqual([250, 250]);
    expect(t.busFare(0, 0, 1)).toBeUndefined();
  });

  it('runs dated bus calendars inside their range and day types outside it', () => {
    const net = tinyNetwork([{ cal: 1 }, { cal: 1, dc: 0 }], {
      calendars: [{ id: 'c', dates: ['2026-10-14', '2026-10-17'], from: '2026-10-01', to: '2026-10-31', dayBits: 4 }],
    });
    const t = new Transit(net, geometry);
    expect(t.runs(0, '2026-10-14', 1)).toBe(true);
    expect(t.runs(1, '2026-10-14', 1)).toBe(true); // listed
    expect(t.runs(1, '2026-10-15', 1)).toBe(false); // in range, not listed
    expect(t.runs(1, '2026-10-17', 2)).toBe(true); // listed Saturday
    expect(t.runs(1, '2026-11-01', 4)).toBe(true); // outside range: holiday bit
    expect(t.runs(1, '2026-11-02', 1)).toBe(false);
  });

  it('stands in a date with the same kind of timetable for a replay', () => {
    const t = new Transit(tinyNetwork([]), geometry);
    // 22 July 2026 is a Wednesday; 12 October 2026 is a public holiday (in the fixture).
    expect(t.equivalentDate('2026-07-22', '2026-10-12')).toBe('2026-10-13');
    expect(t.equivalentDate('2026-07-25', '2026-10-12')).toBe('2026-10-17');
    expect(t.equivalentDate('2026-07-26', '2026-10-12')).toBe('2026-10-12');
  });

  it('uses holiday timetables at the year end', () => {
    const none = new Set<string>();
    expect(dayTypeOf('2026-12-30', none)).toBe('holiday');
    expect(dayTypeOf('2027-01-04', none)).toBe('weekday');
    expect(dayTypeOf('2026-10-17', none)).toBe('saturday');
  });
});
