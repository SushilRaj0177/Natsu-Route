/**
 * Live data from ODPT: line status (odpt:TrainInformation) and running trains
 * (odpt:Train), polled server-side so the API keys never reach the browser.
 * Each item keeps the operator's own timestamp; ODPT's terms require showing
 * when dynamic data was generated.
 */
import type { LineStatus, LiveTrain, Names } from '../shared/api.ts';
import type { Transit } from './transit.ts';
import { serviceTime } from './time.ts';

interface Endpoint {
  base: string;
  key: string;
}

type Multi = Partial<Record<'en' | 'ja', string>>;

interface OdptTrainInformation {
  'dc:date'?: string;
  'odpt:railway'?: string;
  'odpt:operator': string;
  'odpt:trainInformationText'?: Multi;
  'odpt:trainInformationStatus'?: Multi;
}

interface OdptTrain {
  'dc:date'?: string;
  'odpt:railway': string;
  'odpt:trainNumber': string;
  'odpt:delay'?: number;
  'odpt:fromStation'?: string | null;
  'odpt:toStation'?: string | null;
}

const POLL_MS = 60_000;
const local = (id: string) => id.slice(id.indexOf(':') + 1);

/** Statuses some operators send in Japanese only. */
const STATUS_EN: Record<string, string> = {
  遅延: 'Delays',
  運転見合わせ: 'Service suspended',
  運転再開: 'Service resumed',
  運休: 'Cancellations',
  ダイヤ乱れ: 'Schedule disrupted',
  直通運転中止: 'Through service suspended',
  お知らせ: 'Notice',
  運転変更: 'Service changes',
};

/** Texts that mean normal service, for operators that send no status field. */
const NORMAL = /平常|遅延はありません|Normal|on schedule/i;

export class LiveData {
  private trains = new Map<string, LiveTrain>();
  private statuses: LineStatus[] = [];
  private reporting = new Set<number>();
  fetchedAt: string | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private net: Transit,
    private endpoints: Endpoint[],
  ) {}

  start() {
    if (!this.endpoints.length) return;
    const tick = () => this.poll().catch((e) => console.warn('live poll failed:', e.message));
    tick();
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async get<T>(ep: Endpoint, type: string): Promise<T[]> {
    const res = await fetch(`${ep.base}odpt:${type}?acl:consumerKey=${encodeURIComponent(ep.key)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${type} HTTP ${res.status}`);
    return (await res.json()) as T[];
  }

  async poll() {
    const railwayIndex = new Map(this.net.data.railways.map((r, i) => [r.id, i]));
    const stationName = new Map(this.net.data.stations.map((s) => [s.id, s.name]));
    const infos = (await Promise.allSettled(this.endpoints.map((ep) => this.get<OdptTrainInformation>(ep, 'TrainInformation'))))
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const trains = (await Promise.allSettled(this.endpoints.map((ep) => this.get<OdptTrain>(ep, 'Train'))))
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    const statuses: LineStatus[] = [];
    const reporting = new Set<number>();
    const operatorRailways = (op: string) =>
      this.net.data.railways.flatMap((r, i) => (this.net.data.operators[r.operator].id === op && r.timetable !== 'none' ? [i] : []));
    for (const info of infos) {
      // Some operators (Seibu, Keikyu) publish one notice for the whole network.
      const targets = info['odpt:railway']
        ? [railwayIndex.get(local(info['odpt:railway']))].filter((x): x is number => x !== undefined)
        : operatorRailways(local(info['odpt:operator']));
      const text = info['odpt:trainInformationText'] ?? {};
      const statusJa = info['odpt:trainInformationStatus']?.ja;
      const disrupted = statusJa ? statusJa !== 'お知らせ' && statusJa !== '平常' : !NORMAL.test(text.ja ?? text.en ?? '');
      const en = text.en ?? (statusJa ? STATUS_EN[statusJa] ?? statusJa : NORMAL.test(text.ja ?? '') ? 'Normal service' : '');
      for (const ri of targets) {
        reporting.add(ri);
        statuses.push({ railway: ri, text: { en, ja: text.ja ?? en }, disrupted, asOf: info['dc:date'] ?? '' });
      }
    }
    this.statuses = statuses;
    this.reporting = reporting;

    const map = new Map<string, LiveTrain>();
    for (const t of trains) {
      const from = t['odpt:fromStation'] ? stationName.get(local(t['odpt:fromStation'])) : undefined;
      const to = t['odpt:toStation'] ? stationName.get(local(t['odpt:toStation'])) : undefined;
      map.set(`${local(t['odpt:railway'])}|${t['odpt:trainNumber']}`, {
        delay: t['odpt:delay'],
        fromStation: from,
        toStation: to,
        asOf: t['dc:date'] ?? '',
      });
    }
    this.trains = map;
    this.fetchedAt = new Date().toISOString();
  }

  /**
   * Live position/delay of a timetabled trip, matched by railway and train
   * number. Train numbers repeat every day, so a match only counts for a
   * train of today's service day that is due within the next two hours or
   * left in the last three.
   */
  forTrip(trip: number, serviceDate: string, depMinute: number, at = new Date()): LiveTrain | undefined {
    const t = this.net.data.trips[trip];
    if (!t.n) return undefined;
    const now = serviceTime(at);
    if (now.date !== serviceDate || depMinute > now.minute + 120 || depMinute < now.minute - 180) return undefined;
    const railways = new Set(t.s.map((s) => this.net.data.railways[this.net.data.stations[s].railway].id));
    for (const num of t.n.split('/')) {
      for (const r of railways) {
        const hit = this.trains.get(`${r}|${num}`);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  lineStatuses(): LineStatus[] {
    return this.statuses;
  }

  /** Operators in the network with no live status feed at all. */
  silentOperators(): Names[] {
    const ops = new Set<number>();
    this.net.data.railways.forEach((r, i) => {
      if (r.timetable !== 'none' && !this.reporting.has(i)) ops.add(r.operator);
    });
    return [...ops].map((o) => this.net.data.operators[o].name);
  }
}
