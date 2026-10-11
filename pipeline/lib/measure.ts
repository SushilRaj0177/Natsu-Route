import { local, type OdptRailway, type OdptStationTimetable } from './odpt.ts';
import { buildChainGroups } from './chain-input.ts';
import { chainBestDirection } from './chain.ts';
import type { LatLon } from './geo.ts';

export interface RebuildScore {
  operator: string;
  links: number;
  correct: number;
  trains: number;
  trainsFullyCorrect: number;
}

/**
 * Rebuild trains for operators whose station timetables carry train numbers
 * (the chainer never sees them) and count how many "this departure continues
 * that one" decisions match the real trains.
 */
export function measureRebuild(
  records: OdptStationTimetable[],
  railways: Map<string, OdptRailway>,
  coords: Map<string, LatLon>,
  operators: string[],
): RebuildScore[] {
  return operators.map((operator) => {
    const recs = records.filter((r) => local(r['odpt:operator']) === operator);
    const { groups } = buildChainGroups(recs, railways, coords, { withTruth: true });
    const score: RebuildScore = { operator, links: 0, correct: 0, trains: 0, trainsFullyCorrect: 0 };
    for (const g of groups) {
      for (const t of chainBestDirection(g.input).trains) {
        score.trains++;
        const real = t.stops.filter((s) => !s.estimated);
        let ok = true;
        for (let i = 1; i < real.length; i++) {
          score.links++;
          if (real[i].truth && real[i].truth === real[i - 1].truth) score.correct++;
          else ok = false;
        }
        if (ok) score.trainsFullyCorrect++;
      }
    }
    return score;
  });
}
