import type { HeatLevel } from '../shared/api.ts';

/** Same thresholds as the server (daily-life guideline). */
export function levelOfWbgt(w: number): HeatLevel {
  if (w >= 31) return 'danger';
  if (w >= 28) return 'severe';
  if (w >= 25) return 'warning';
  if (w >= 21) return 'caution';
  return 'safe';
}
