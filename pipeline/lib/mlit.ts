import yauzl from 'yauzl';

/**
 * 国土数値情報 鉄道データ (MLIT N02). Used for two things ODPT does not give us:
 * coordinates for the stations ODPT publishes without them, and the actual
 * track alignment between stations, so the map draws real lines instead of
 * straight chords.
 */
export interface MlitStation {
  operator: string;
  line: string;
  name: string;
  lat: number;
  lon: number;
}

export interface MlitSection {
  operator: string;
  line: string;
  /** [lat, lon] */
  coords: [number, number][];
}

/** Greater Tokyo plus the lines that run out of it (Nikko, Odawara, Narita). */
const BBOX = { minLat: 34.5, maxLat: 38.0, minLon: 138.0, maxLon: 141.2 };
const inBox = (lat: number, lon: number) =>
  lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

function readEntries(zipPath: string, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, string>();
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!wanted(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
    });
  });
}

interface Feature {
  properties: Record<string, string>;
  geometry: { type: string; coordinates: number[][] | number[][][] };
}

function lines(f: Feature): number[][][] {
  return f.geometry.type === 'MultiLineString'
    ? (f.geometry.coordinates as number[][][])
    : [f.geometry.coordinates as number[][]];
}

export async function loadMlit(zipPath: string): Promise<{ stations: MlitStation[]; sections: MlitSection[] }> {
  const files = await readEntries(zipPath, (n) => n.startsWith('UTF-8/') && n.endsWith('.geojson'));
  const stationFile = [...files.keys()].find((k) => k.endsWith('_Station.geojson'));
  const sectionFile = [...files.keys()].find((k) => k.endsWith('_RailroadSection.geojson'));
  if (!stationFile || !sectionFile) throw new Error(`N02 zip is missing GeoJSON files: ${[...files.keys()]}`);

  const stations: MlitStation[] = [];
  for (const f of JSON.parse(files.get(stationFile)!).features as Feature[]) {
    // A station feature is the platform's line segment; its midpoint is the station.
    const pts = lines(f).flat();
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    if (!inBox(lat, lon)) continue;
    stations.push({ operator: f.properties.N02_004, line: f.properties.N02_003, name: f.properties.N02_005, lat, lon });
  }

  const sections: MlitSection[] = [];
  for (const f of JSON.parse(files.get(sectionFile)!).features as Feature[]) {
    for (const part of lines(f)) {
      if (!part.some(([lon, lat]) => inBox(lat, lon))) continue;
      sections.push({
        operator: f.properties.N02_004,
        line: f.properties.N02_003,
        coords: part.map(([lon, lat]) => [lat, lon] as [number, number]),
      });
    }
  }
  return { stations, sections };
}

/** ODPT operator id -> N02 operator name (N02_004). */
export const MLIT_OPERATOR: Record<string, string[]> = {
  'JR-East': ['東日本旅客鉄道'],
  'JR-Central': ['東海旅客鉄道'],
  TokyoMetro: ['東京地下鉄'],
  Toei: ['東京都'],
  Tokyu: ['東急電鉄'],
  Odakyu: ['小田急電鉄'],
  Keio: ['京王電鉄'],
  Seibu: ['西武鉄道'],
  Tobu: ['東武鉄道'],
  Keisei: ['京成電鉄'],
  Keikyu: ['京浜急行電鉄'],
  Sotetsu: ['相模鉄道'],
  MIR: ['首都圏新都市鉄道'],
  TWR: ['東京臨海高速鉄道'],
  Yurikamome: ['ゆりかもめ'],
  TokyoMonorail: ['東京モノレール'],
  YokohamaMunicipal: ['横浜市'],
  Minatomirai: ['横浜高速鉄道'],
  SaitamaRailway: ['埼玉高速鉄道'],
  Hokuso: ['北総鉄道'],
  TamaMonorail: ['多摩都市モノレール'],
  ToyoRapid: ['東葉高速鉄道'],
  Shibayama: ['芝山鉄道'],
};
