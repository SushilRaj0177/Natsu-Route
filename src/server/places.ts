import type { PlaceHit } from '../shared/api.ts';
import type { Names } from '../shared/network.ts';
import { romaji } from '../shared/romaji.ts';
import type { Poi } from './access.ts';
import type { Transit } from './transit.ts';

/**
 * Search for where to go: stations, bus stops and named places (hospitals,
 * clinics, supermarkets, libraries, ward offices, parks, cooling shelters),
 * by Japanese name, kana or romaji ("すがも", "sugamo" and "巣鴨" all find
 * Sugamo). Addresses fall through to the Geospatial Information Authority's
 * address search.
 */
interface Entry {
  hit: PlaceHit;
  keys: string[];
  rank: number;
}

const POI_KINDS: Record<string, { ja: string; en: string; rank: number }> = {
  hospital: { ja: '病院・医院', en: 'Hospital / clinic', rank: 2 },
  supermarket: { ja: 'スーパー・商業施設', en: 'Shop', rank: 3 },
  library: { ja: '図書館', en: 'Library', rank: 3 },
  public: { ja: '公共施設', en: 'Public facility', rank: 3 },
  park: { ja: '公園', en: 'Park', rank: 4 },
  cooling: { ja: 'クーリングシェルター', en: 'Cooling shelter', rank: 3 },
  pharmacy: { ja: '薬局', en: 'Pharmacy', rank: 4 },
};

/** Lower-case, full-width folded, katakana as hiragana, no spaces or punctuation. */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    // Before the kana shift, which would turn ヶ and ヵ into small hiragana: 霞ヶ関 = 霞ケ関.
    .replace(/[ヶヵ]/g, 'け')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・\-‐ー'’.,()（）]/g, '');
}

/** Romaji key: "Shin-Okubo" and "しんおおくぼ" both become "shinokubo". */
function roman(s: string): string {
  const r = /[぀-ヿ]/.test(s) ? romaji(s) : s;
  return r.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u');
}

export class PlaceSearch {
  private entries: Entry[] = [];

  constructor(transit: Transit, pois: Poi[]) {
    const d = transit.data;
    const served = new Set<number>();
    for (const t of d.trips) for (const s of t.s) served.add(d.stations[s].place);
    d.places.forEach((p, i) => {
      if (!served.has(i)) return;
      const stations = p.stations.map((s) => d.stations[s]);
      const bus = stations.every((s) => s.pole);
      const lines = [...new Set(stations.map((s) => s.railway))].slice(0, 6).map((r) => ({
        color: d.railways[r].color,
        name: d.railways[r].name,
        mode: (d.railways[r].mode === 'bus' ? 'bus' : 'rail') as 'bus' | 'rail',
      }));
      const kana = stations.find((s) => s.kana)?.kana;
      const name: Names = bus ? p.name : { ja: `${p.name.ja}駅`, en: `${p.name.en} Sta.` };
      this.entries.push({
        hit: { kind: bus ? 'bus' : 'station', name, sub: bus ? { ja: 'バス停', en: 'Bus stop' } : undefined, lat: p.lat, lon: p.lon, lines },
        keys: [fold(p.name.ja), fold(p.name.en), roman(p.name.en), ...(kana ? [fold(kana), roman(kana)] : [])],
        rank: bus ? 1 : 0,
      });
    });
    for (const p of pois) {
      const kind = POI_KINDS[p.kind];
      if (!kind || !p.name || p.lat === undefined || p.lon === undefined) continue;
      const name = String(p.name);
      const en = String(p.name_en ?? name);
      this.entries.push({
        hit: { kind: 'poi', name: { ja: name, en }, sub: { ja: p.ward ? `${kind.ja}・${p.ward}` : kind.ja, en: kind.en }, lat: p.lat, lon: p.lon },
        keys: [fold(name), fold(en), roman(en)],
        rank: kind.rank,
      });
    }
  }

  search(q: string, near?: { lat: number; lon: number }, limit = 10): PlaceHit[] {
    const f = fold(q);
    const r = roman(q);
    if (!f) return [];
    const scored: { e: Entry; score: number }[] = [];
    for (const e of this.entries) {
      let best = Infinity;
      for (const k of e.keys) {
        if (!k) continue;
        let s = Infinity;
        if (k === f || (r && k === r)) s = 0;
        else if (k.startsWith(f) || (r.length >= 3 && k.startsWith(r))) s = 1;
        else if (f.length >= 2 && k.includes(f)) s = 2;
        else if (r.length >= 4 && k.includes(r)) s = 3;
        if (s < best) best = s;
      }
      if (best === Infinity) continue;
      let score = best * 10 + e.rank;
      if (near) {
        const dKm = Math.hypot((e.hit.lat - near.lat) * 111, (e.hit.lon - near.lon) * 90);
        score += Math.min(5, dKm / 4);
      }
      scored.push({ e, score });
    }
    scored.sort((a, b) => a.score - b.score);
    const out: PlaceHit[] = [];
    const seen = new Set<string>();
    for (const { e } of scored) {
      const k = `${e.hit.kind}|${e.hit.name.ja}|${e.hit.lat.toFixed(3)}|${e.hit.lon.toFixed(3)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e.hit);
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** Address search via GSI (Japanese addresses, Tokyo only). */
export async function searchAddress(q: string, fetcher: typeof fetch = fetch): Promise<PlaceHit[]> {
  try {
    const res = await fetcher(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const list = (await res.json()) as { geometry: { coordinates: [number, number] }; properties: { title: string } }[];
    return list
      .filter((x) => x.properties.title.startsWith('東京都'))
      .slice(0, 5)
      .map((x) => ({
        kind: 'address' as const,
        name: { ja: x.properties.title, en: x.properties.title },
        sub: { ja: '住所', en: 'Address' },
        lat: x.geometry.coordinates[1],
        lon: x.geometry.coordinates[0],
      }));
  } catch {
    return [];
  }
}

/** "巣鴨三丁目" for a point, via GSI's reverse geocoder. */
export async function nameOfPoint(lat: number, lon: number, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: { lv01Nm?: string } };
    return j.results?.lv01Nm && j.results.lv01Nm !== '－' ? j.results.lv01Nm : null;
  } catch {
    return null;
  }
}
