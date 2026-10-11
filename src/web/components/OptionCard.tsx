import type { Preference, RideLeg, TripOption } from '../../shared/api.ts';
import { clock, LEVEL_COLOR, minutes, yen } from '../format.ts';
import { useT, type Key } from '../i18n.ts';
import { Icon } from './Icon.tsx';
import { TripStrip } from './TripStrip.tsx';

interface Props {
  option: TripOption;
  preference: Preference;
  silverPass: boolean;
  onOpen: () => void;
}

export function LineChip({ leg }: { leg: RideLeg }) {
  const { name } = useT();
  return (
    <span className="line-chip" style={{ borderColor: leg.line.color }}>
      <span className="line-dot" style={{ background: leg.line.color }} aria-hidden />
      <Icon name={leg.mode === 'bus' ? 'bus' : 'train'} size={18} />
      {leg.mode === 'bus' ? `${leg.line.name.ja}` : name(leg.line.name)}
    </span>
  );
}

/** One way to go, summed up: when, how long, and above all how much sun. */
export function OptionCard({ option: o, preference, silverPass, onOpen }: Props) {
  const { t, lang, level } = useT();
  const rides = o.legs.filter((l): l is RideLeg => l.kind === 'ride');
  const exposureLabel = preference === 'warm' ? t('cardShade') : preference === 'rain' ? t('cardOpen') : t('cardSun');
  const exposure = preference === 'warm' ? Math.max(0, o.walkSeconds - o.sunSeconds) : preference === 'rain' ? o.outdoorSeconds : o.sunSeconds;
  const fare = silverPass ? o.fare.withSilverPass : o.fare.ic;
  const compare =
    o.vsFastest && o.vsFastest.lessSunSeconds >= 30 && preference === 'cool'
      ? (Math.abs(o.vsFastest.extraSeconds) < 90
          ? t('vsFastestSameTime', { less: minutes(o.vsFastest.lessSunSeconds, lang) })
          : t('vsFastestCooler', { extra: minutes(o.vsFastest.extraSeconds, lang), less: minutes(o.vsFastest.lessSunSeconds, lang) })) +
        (o.vsFastest.laterSeconds > 120 ? t('vsFastestLater', { later: minutes(o.vsFastest.laterSeconds, lang) }) : '')
      : null;

  return (
    <article className={`option card ${o.labels.includes('coolest') ? 'is-coolest' : ''}`} aria-labelledby={`opt-${o.id}`}>
      <div className="option-labels">
        {o.labels.map((l) => (
          <span key={l} className={`label label-${l}`}>
            {l === 'coolest' && <Icon name="shade" size={18} />}
            {l === 'fastest' && <Icon name="clock" size={18} />}
            {l === 'walk' && <Icon name="walk" size={18} />}
            {t(`label_${l}` as Key)}
          </span>
        ))}
      </div>
      <h3 id={`opt-${o.id}`} className="option-times num">
        <span>{clock(o.leave)}</span>
        <span className="arrow" aria-hidden>
          →
        </span>
        <span>{clock(o.arrive)}</span>
        <span className="sr-only">
          {t('leaveAt', { time: clock(o.leave) })}, {t('arriveAt', { time: clock(o.arrive) })}
        </span>
        <span className="duration">（{minutes(o.seconds, lang)}）</span>
      </h3>
      <div className="exposure">
        <Icon name={preference === 'warm' ? 'shade' : 'sun'} size={32} className="exposure-icon" />
        <div>
          <div className="exposure-label">{exposureLabel}</div>
          <div className="exposure-value num">{minutes(exposure, lang)}</div>
        </div>
        <div className="exposure-side">
          <div>
            {t('walking')} {minutes(o.walkSeconds, lang)}
          </div>
          <div className="muted">
            {t('outdoors')} {minutes(o.outdoorSeconds, lang)}
          </div>
        </div>
      </div>
      <TripStrip option={o} />
      {compare && <p className="compare">{compare}</p>}
      <div className="option-lines">
        {rides.length === 0 ? (
          <span className="line-chip">
            <Icon name="walk" size={18} /> {t('label_walk')}
          </span>
        ) : (
          rides.map((r, i) => <LineChip key={i} leg={r} />)
        )}
      </div>
      <ul className="facts">
        <li>{o.transfers ? t('changes', { n: o.transfers }) : t('noChanges')}</li>
        <li className={o.stairs ? '' : 'good'}>{o.stairs ? t('stairsCount', { n: o.stairs }) : t('noStairs')}</li>
        {rides.length > 0 && (
          <li className={silverPass && fare === 0 ? 'good' : ''}>
            {silverPass && o.fare.withSilverPass === 0 ? t('fareFree') : `${t('fare')} ${yen(fare, lang)}`}
          </li>
        )}
        {o.heatPeak && (
          <li>
            <span className="level-dot" style={{ background: LEVEL_COLOR[o.heatPeak.level].bg }} aria-hidden />
            {t('heatPeakOnWay', { value: o.heatPeak.wbgt.toFixed(1), level: level(o.heatPeak.level) })}
          </li>
        )}
      </ul>
      <button type="button" className="btn primary block" onClick={onOpen} aria-describedby={`opt-${o.id}`}>
        {t('details')} <Icon name="next" />
      </button>
    </article>
  );
}
