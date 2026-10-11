import type { HeatLevel } from '../../shared/api.ts';
import type { HeatResponse } from '../api.ts';
import { clock, LEVEL_COLOR } from '../format.ts';
import { useT, type Key } from '../i18n.ts';
import { Icon } from './Icon.tsx';

interface Props {
  heat: HeatResponse | null;
  onReplay: () => void;
}

/** "How hot is it?": the heat index now, what it means, and the day hour by hour. */
export function HeatCard({ heat, onReplay }: Props) {
  const { t, name, level } = useT();
  if (!heat) return <section className="heat card skeleton" aria-busy="true" aria-label={t('heatNow')} />;

  const now = heat.now;
  const peak = heat.hours.reduce<HeatResponse['hours'][number] | null>((a, h) => (!a || h.wbgt > a.wbgt ? h : a), null);
  const alert = heat.alert?.today;

  if (!now && !heat.replay) {
    return (
      <section className="heat card offseason" aria-labelledby="heat-title">
        <h2 id="heat-title" className="heat-title">
          <Icon name="sun" /> {t('heatNow')}
        </h2>
        <p className="lead">{t('heatOffSeason')}</p>
        <p className="muted">{t('replayIntro')}</p>
        <button type="button" className="btn primary big" onClick={onReplay}>
          <Icon name="sun" /> {t('tryReplay')}
        </button>
      </section>
    );
  }

  const lv: HeatLevel = now?.level ?? 'safe';
  const c = LEVEL_COLOR[lv];
  return (
    <section className="heat card" aria-labelledby="heat-title">
      {alert && alert !== 'none' && (
        <div className={`alert-banner ${alert}`} role="alert">
          <Icon name="alert" size={28} />
          <div>
            <strong>{t(alert === 'special' ? 'alertSpecial' : 'alertAlert')}</strong>
            <p>{t('alertAdvice')}</p>
          </div>
        </div>
      )}
      <div className="heat-main">
        <div className="heat-badge" style={{ background: c.bg, color: c.fg }}>
          <span className="heat-value num">{now ? now.wbgt.toFixed(1) : '—'}</span>
          <span className="heat-level">{level(lv)}</span>
        </div>
        <div className="heat-text">
          <h2 id="heat-title" className="heat-title">
            {heat.replay ? `${heat.replay.date.slice(5).replace('-', '/')} ${t('heatUnit')}` : t('heatNow')}
          </h2>
          <p className="lead">{t(`advice_${lv}` as Key)}</p>
          {peak && (
            <p className="muted">
              {t('heatPeak', { time: clock(peak.at), value: peak.wbgt.toFixed(1) })}
            </p>
          )}
        </div>
      </div>
      {heat.hours.length > 0 && (
        <div className="hours" role="img" aria-label={`${t('heatToday')}: ${heat.hours.map((h) => `${clock(h.at)} ${h.wbgt.toFixed(0)}`).join(', ')}`}>
          {heat.hours.map((h) => {
            const hc = LEVEL_COLOR[h.level];
            const height = Math.max(12, Math.min(100, ((h.wbgt - 14) / 22) * 100));
            return (
              <div key={h.at} className="hour" title={`${clock(h.at)} ${h.wbgt.toFixed(1)} ${level(h.level)}`}>
                <div className="hour-bar" style={{ height: `${height}%`, background: hc.bg }} />
                <span className="hour-label num">{Number(clock(h.at).split(':')[0])}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="source">
        {t('heatSource', { point: name(heat.point) })}
        {now && ` · ${t(now.kind === 'actual' ? 'heatActual' : now.kind === 'replay' ? 'heatReplay' : 'heatForecast')}`}
      </p>
    </section>
  );
}
