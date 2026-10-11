/**
 * Rebuild individual trains from per-station departure lists.
 *
 * Tokyu, Odakyu, Seibu, Keikyu and Yurikamome publish odpt:StationTimetable
 * (every departure at every station) but no odpt:TrainTimetable, and their
 * station timetables carry no train numbers. A departure list still says, for
 * each train, its type and destination, and trains of the same type to the
 * same destination keep their order along the line. So a train leaving
 * station A at 10:00 is the "Express for Odawara" that leaves the next
 * station it stops at roughly one running time later.
 *
 * For each departure we pick, among the trains still travelling with the same
 * type and destination, the one whose expected arrival (last departure plus
 * typical running time) is closest. Running times are learned from the data
 * first (median gap between consecutive departures of a class at adjacent
 * stations), so no speeds are assumed.
 *
 * Accuracy is measured, not asserted: validate-chain.ts runs this on
 * operators that publish both formats and compares against the real trains.
 */

export interface Departure {
  /** Minutes since the start of the service day (after-midnight values are >= 1440). */
  time: number;
  type: string;
  /** Destination key: final station id(s) joined. */
  dest: string;
  isOrigin: boolean;
  platform?: string;
  /** Present only in validation runs: the true train this departure belongs to. */
  truth?: string;
}

export interface ChainInput {
  /** Station ids in travel order for this direction. */
  order: string[];
  /** Departures at each station in `order`, same index. */
  departures: Departure[][];
  /** Straight-line distance in metres between consecutive stations in `order`. */
  hopMetres: number[];
  /**
   * Trains bound for this destination leave the line through its final
   * station (the line connects there to the destination's railway). Used
   * when the operator lists no departures at that station, as Tokyu does at
   * Yokohama for trains continuing onto the Minatomirai Line.
   */
  exitsAt?: (station: string, dest: string) => boolean;
}

export interface ChainedStop {
  station: string;
  /** Departure time; for the final stop of a train that terminates on this line, an estimated arrival. */
  time: number;
  /** True when `time` is an estimate (terminal arrival, never published). */
  estimated?: boolean;
  /** Train type as listed at this station. */
  type?: string;
  platform?: string;
  truth?: string;
}

export interface ChainedTrain {
  type: string;
  dest: string;
  stops: ChainedStop[];
  /** Ended at its destination on this line (vs. ran off the end / onto another operator). */
  terminated: boolean;
}

export interface ChainStats {
  departures: number;
  /** Departures that started a new train although not marked as an origin. */
  unmatchedNonOrigin: number;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Typical minutes from departing station i-1 to departing station i. */
function learnHopTimes(input: ChainInput): number[] {
  const { order, departures, hopMetres } = input;
  const hop: number[] = new Array(order.length).fill(NaN);
  for (let i = 1; i < order.length; i++) {
    const diffs: number[] = [];
    const byClass = new Map<string, number[]>();
    for (const d of departures[i - 1]) {
      const k = `${d.type}|${d.dest}`;
      (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(d.time);
    }
    for (const d of departures[i]) {
      if (d.isOrigin) continue;
      const prev = byClass.get(`${d.type}|${d.dest}`);
      if (!prev) continue;
      // Latest departure from i-1 that is strictly earlier.
      let best = -Infinity;
      for (const t of prev) if (t < d.time && t > best) best = t;
      if (best > -Infinity && d.time - best <= 30) diffs.push(d.time - best);
    }
    const m = median(diffs);
    // Fall back to distance at 40 km/h plus a 30 s stop when nothing stops at both.
    hop[i] = Number.isFinite(m) ? m : Math.max(1, Math.round(hopMetres[i - 1] / 667 + 0.5));
  }
  return hop;
}

/**
 * Typical minutes for a train type between two consecutive stations it
 * stops at. Expresses skip stops and run much faster than the sum of local
 * hops, so each type gets its own running times. Key: `${type}|${j}|${i}`.
 */
function learnTypeHops(input: ChainInput): Map<string, number> {
  const { departures } = input;
  const out = new Map<string, number>();
  const lastSeen = new Map<string, number>(); // type -> last station index with that type
  for (let i = 0; i < departures.length; i++) {
    const types = new Set(departures[i].map((d) => d.type));
    for (const type of types) {
      const j = lastSeen.get(type);
      if (j !== undefined) {
        const prev = new Map<string, number[]>();
        for (const d of departures[j]) {
          if (d.type !== type) continue;
          (prev.get(d.dest) ?? prev.set(d.dest, []).get(d.dest)!).push(d.time);
        }
        const diffs: number[] = [];
        for (const d of departures[i]) {
          if (d.type !== type || d.isOrigin) continue;
          let best = -Infinity;
          for (const t of prev.get(d.dest) ?? []) if (t < d.time && t > best) best = t;
          if (best > -Infinity && d.time - best <= 40) diffs.push(d.time - best);
        }
        if (diffs.length >= 3) out.set(`${type}|${j}|${i}`, median(diffs));
      }
      lastSeen.set(type, i);
    }
  }
  return out;
}

export function chainDepartures(input: ChainInput): { trains: ChainedTrain[]; stats: ChainStats } {
  const { order, departures } = input;
  const hop = learnHopTimes(input);
  const typeHop = learnTypeHops(input);
  // cum[i]: typical minutes from station 0 to station i when stopping everywhere.
  const cum: number[] = [0];
  for (let i = 1; i < order.length; i++) cum[i] = cum[i - 1] + hop[i];
  const destIndex = new Map(order.map((s, i) => [s, i]));

  interface Active {
    train: ChainedTrain;
    lastIdx: number;
    lastTime: number;
    destIdx: number;
    /** Type as currently shown; some trains change type part-way (e.g. at Shinagawa onto the Asakusa Line). */
    curType: string;
  }
  const trains: ChainedTrain[] = [];
  const active: Active[] = [];
  const stats: ChainStats = { departures: 0, unmatchedNonOrigin: 0 };

  const close = (a: Active, idx: number) => {
    // Terminal arrival is not published; estimate it from the learned running
    // time, minus the ~30 s a departing train would have spent standing.
    const t = a.lastTime + Math.max(1, Math.round(cum[idx] - cum[a.lastIdx] - 0.5));
    a.train.stops.push({ station: order[idx], time: t, estimated: true });
    a.train.terminated = true;
  };

  /** Deviation of departure d from where active train a is expected to be, or null if implausible. */
  const deviation = (a: Active, d: Departure, i: number, sameType: boolean): number | null => {
    const skipped = i - a.lastIdx - 1;
    const learned = sameType ? typeHop.get(`${d.type}|${a.lastIdx}|${i}`) : undefined;
    const expected = a.lastTime + (learned ?? cum[i] - cum[a.lastIdx] - 0.5 * skipped);
    const dev = d.time - expected;
    if (sameType) {
      // Early by a few minutes (faster running); late by up to 12
      // (waiting to be overtaken, longer dwell).
      const early = learned !== undefined ? 3 : 3 + 1.2 * skipped;
      return dev < -early || dev > 12 ? null : dev;
    }
    // A type change is only accepted when the timing fits closely.
    return dev < -2 - 1.2 * skipped || dev > 4 ? null : dev;
  };

  for (let i = 0; i < order.length; i++) {
    // Trains whose destination is this station end here.
    for (let k = active.length - 1; k >= 0; k--) {
      if (active[k].destIdx === i) {
        close(active[k], i);
        active.splice(k, 1);
      }
    }
    const deps = [...departures[i]].sort((a, b) => a.time - b.time);
    stats.departures += deps.length;
    const taken = new Set<Active>();
    const matched = new Map<Departure, Active>();
    // Pass 1: same type and destination. Pass 2: same destination, type changed.
    for (const sameType of [true, false]) {
      for (const d of deps) {
        if (d.isOrigin || matched.has(d)) continue;
        let best: Active | null = null;
        let bestScore = Infinity;
        for (const a of active) {
          if (taken.has(a) || a.lastIdx >= i || a.train.dest !== d.dest) continue;
          if (sameType !== (a.curType === d.type)) continue;
          const dev = deviation(a, d, i, sameType);
          if (dev === null) continue;
          const score = Math.abs(dev) + 0.01 * (a.lastTime - d.time);
          if (score < bestScore) {
            bestScore = score;
            best = a;
          }
        }
        if (best) {
          matched.set(d, best);
          taken.add(best);
        }
      }
    }
    for (const d of deps) {
      const stop: ChainedStop = { station: order[i], time: d.time, type: d.type, platform: d.platform, truth: d.truth };
      const a = matched.get(d);
      if (a) {
        a.train.stops.push(stop);
        a.lastIdx = i;
        a.lastTime = d.time;
        a.curType = d.type;
        continue;
      }
      if (!d.isOrigin && i > 0) stats.unmatchedNonOrigin++;
      const firstDest = d.dest.split(',')[0];
      const train: ChainedTrain = { type: d.type, dest: d.dest, stops: [stop], terminated: false };
      trains.push(train);
      const fresh: Active = { train, lastIdx: i, lastTime: d.time, destIdx: destIndex.get(firstDest) ?? -1, curType: d.type };
      if (fresh.destIdx <= i) fresh.destIdx = -1;
      active.push(fresh);
    }
  }
  // Trains still running at the end leave the line through its final station.
  const last = order.length - 1;
  for (const a of active) {
    if (a.lastIdx < last && a.destIdx < 0 && input.exitsAt?.(order[last], a.train.dest)) {
      const skipped = last - a.lastIdx - 1;
      const t = a.lastTime + Math.max(1, Math.round(cum[last] - cum[a.lastIdx] - 0.6 * skipped - 0.5));
      a.train.stops.push({ station: order[last], time: t, estimated: true });
    }
  }
  return { trains, stats };
}

/**
 * ODPT's "ascending direction" does not always match a railway's station
 * order (the Tokyu Shin-Yokohama Line is published the other way round), so
 * chain both ways and keep the direction that leaves fewer trains appearing
 * from nowhere mid-line.
 */
export function chainBestDirection(input: ChainInput): { trains: ChainedTrain[]; stats: ChainStats; reversed: boolean } {
  const forward = chainDepartures(input);
  const reversedInput: ChainInput = {
    ...input,
    order: [...input.order].reverse(),
    departures: [...input.departures].reverse(),
    hopMetres: [...input.hopMetres].reverse(),
  };
  const backward = chainDepartures(reversedInput);
  const worse = (r: { stats: ChainStats }) => r.stats.unmatchedNonOrigin;
  return worse(backward) < worse(forward) ? { ...backward, reversed: true } : { ...forward, reversed: false };
}
