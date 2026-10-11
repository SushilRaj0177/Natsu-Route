import { useEffect, useState } from 'react';
import type { PlanQuery, TimeOfDayPoint } from '../../shared/api.ts';
import { api } from '../api.ts';
import { clock, LEVEL_COLOR, minutes } from '../format.ts';
import { useT } from '../i18n.ts';
import { Icon } from './Icon.tsx';

/**
 * "When should I go?": the same trip at seven times of day, the bar showing
 * minutes in the sun and its colour the heat index, with the best time
 * picked out.
 */
export function BestTime({ query, onPick }: { query: PlanQuery; onPick: (iso: string) => void }) {
  const { t, lang, level } = useT();
  const [points, setPoints] = useState<TimeOfDayPoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setPoints(null);
    setError(false);
    api
      .bestTime(query, ac.signal)
      .then(setPoints)
      .catch(() => !ac.signal.aborted && setError(true));
    return () => ac.abort();
  }, [query]);

  if (error) return <p className="note">{t('error')}</p>;
  if (!points)
    return (
      <div className="best card" aria-busy="true">
        <h3>{t('bestTimeTitle')}</h3>
        <p className="loading">
          <span className="spinner" aria-hidden /> {t('bestTimeLoading')}
        </p>
      </div>
    );

  const max = Math.max(60, ...points.map((p) => p.sunSeconds));
  // Best: least sun, with the heat index as tie-break.
  const score = (p: TimeOfDayPoint) => p.sunSeconds + (p.wbgt ?? 25) * 20;
  const best = points.reduce((a, p) => (score(p) < score(a) ? p : a), points[0]);
  return (
    <div className="best card">
      <h3>{t('bestTimeTitle')}</h3>
      <p className="muted">{t('bestTimeIntro')}</p>
      <ol className="best-bars">
        {points.map((p) => {
          const c = p.level ? LEVEL_COLOR[p.level] : { bg: '#9aa3ad', fg: '#111' };
          const isBest = p === best;
          return (
            <li key={p.leave} className={isBest ? 'best-pick' : undefined}>
              <button type="button" className="best-bar-btn" onClick={() => onPick(p.leave)} aria-label={`${clock(p.leave)}: ${t('inSun')} ${minutes(p.sunSeconds, lang)}${p.wbgt !== null ? `, WBGT ${p.wbgt.toFixed(1)} ${p.level ? level(p.level) : ''}` : ''}`}>
                <span className="best-bar-track">
                  <span className="best-bar" style={{ height: `${Math.max(4, (100 * p.sunSeconds) / max)}%`, background: c.bg }} />
                </span>
                <span className="best-sun num">{minutes(p.sunSeconds, lang)}</span>
                <span className="best-time num">{clock(p.leave)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="recommend">
        <Icon name="star" /> {t('bestTimeRecommend', { time: clock(best.leave), sun: minutes(best.sunSeconds, lang), wbgt: best.wbgt?.toFixed(1) ?? '—' })}
      </p>
      <button type="button" className="btn primary" onClick={() => onPick(best.leave)}>
        {t('pickThisTime')}
      </button>
    </div>
  );
}
