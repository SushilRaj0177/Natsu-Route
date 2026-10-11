import { useState } from 'react';
import type { Preference, RestStop, RideLeg, TripOption, WalkLeg } from '../../shared/api.ts';
import { clock, metres, minutes, yen } from '../format.ts';
import { useT, type Key } from '../i18n.ts';
import { segmentText, shadeWord, shareText, tripLines } from '../steps.ts';
import { useSpeech } from '../speech.ts';
import { Icon, type IconName } from './Icon.tsx';
import { LineChip } from './OptionCard.tsx';
import { TripStrip, StripLegend } from './TripStrip.tsx';

interface Props {
  option: TripOption;
  preference: Preference;
  silverPass: boolean;
  fromName: string;
  toName: string;
  onBack: () => void;
  onShowMap?: () => void;
  onFocusPoint?: (lat: number, lon: number) => void;
}

const REST_ICON: Record<RestStop['kind'], IconName> = {
  cooling: 'cool',
  library: 'building',
  konbini: 'store',
  water: 'drop',
  toilet: 'toilet',
  bench: 'bench',
  vending: 'drop',
  shelter: 'shade',
};

const TURN_ICON: Record<string, IconName> = {
  left: 'turnLeft',
  'slight-left': 'turnLeft',
  right: 'turnRight',
  'slight-right': 'turnRight',
  straight: 'arrowUp',
  back: 'back',
};

/** The trip step by step, in large print, with the shade on every stretch. */
export function TripDetail({ option: o, preference, silverPass, fromName, toName, onBack, onShowMap, onFocusPoint }: Props) {
  const i18n = useT();
  const { t, lang, name } = i18n;
  const speech = useSpeech(lang);
  const [copied, setCopied] = useState(false);
  const url = typeof location !== 'undefined' ? location.href : '';
  const text = shareText(o, i18n, preference, fromName, toName, url);
  const fare = silverPass ? o.fare.withSilverPass : o.fare.ic;

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: t('shareTitle', { from: fromName, to: toName }), text, url });
        return;
      } catch {
        /* cancelled: fall through to copy */
      }
    }
    await copy();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="detail" aria-labelledby="detail-title">
      <div className="detail-head">
        <button type="button" className="btn ghost back" onClick={onBack}>
          <Icon name="back" /> {t('back')}
        </button>
        <h2 id="detail-title" className="detail-times num">
          {clock(o.leave)} <span aria-hidden>→</span> {clock(o.arrive)}
          <span className="duration">（{minutes(o.seconds, lang)}）</span>
        </h2>
        <dl className="detail-metrics">
          <div className="metric sun">
            <dt>
              <Icon name="sun" size={20} /> {preference === 'warm' ? t('inShade') : t('inSun')}
            </dt>
            <dd className="num">{minutes(preference === 'warm' ? Math.max(0, o.walkSeconds - o.sunSeconds) : o.sunSeconds, lang)}</dd>
          </div>
          <div className="metric">
            <dt>
              <Icon name="walk" size={20} /> {t('walking')}
            </dt>
            <dd className="num">
              {minutes(o.walkSeconds, lang)}・{metres(o.walkMetres, lang)}
            </dd>
          </div>
          {o.legs.some((l) => l.kind === 'ride') && (
            <div className="metric">
              <dt>{t('fare')}</dt>
              <dd className="num">{silverPass && o.fare.withSilverPass === 0 ? t('fareFree') : yen(fare, lang)}</dd>
            </div>
          )}
        </dl>
        <TripStrip option={o} />
        <StripLegend />
        {o.fare.missing.length > 0 && <p className="muted small">{t('fareMissing', { ops: o.fare.missing.map(name).join('・') })}</p>}
        {o.partialShade && (
          <p className="note">
            <Icon name="info" size={20} /> {t('partialShade')}
          </p>
        )}
        <div className="actions" role="group">
          {speech.supported && (
            <button type="button" className="btn big" onClick={() => (speech.speaking ? speech.stop() : speech.speak(tripLines(o, i18n, preference)))}>
              <Icon name={speech.speaking ? 'stop' : 'speaker'} /> {speech.speaking ? t('stopReading') : t('readAloud')}
            </button>
          )}
          <button type="button" className="btn big" onClick={share}>
            <Icon name="share" /> {t('share')}
          </button>
          <a className="btn big line" href={`https://line.me/R/msg/text/?${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
            <Icon name="line" /> {t('shareLine')}
          </a>
          <button type="button" className="btn big" onClick={() => window.print()}>
            <Icon name="print" /> {t('print')}
          </button>
          {onShowMap && (
            <button type="button" className="btn big map-toggle" onClick={onShowMap}>
              <Icon name="map" /> {t('showMap')}
            </button>
          )}
          <span className="sr-only" role="status">
            {copied ? t('copied') : ''}
          </span>
        </div>
        {copied && <p className="toast">{t('copied')}</p>}
      </div>

      <ol className="timeline">
        <li className="tl-item endpoint">
          <span className="tl-time num">{clock(o.leave)}</span>
          <span className="tl-icon">
            <Icon name="home" />
          </span>
          <div className="tl-body">
            <strong>
              {t('leaveHome')}: {fromName}
            </strong>
            <p className="muted">{preference === 'warm' ? t('leaveAdviceWarm') : t('leaveAdvice')}</p>
          </div>
        </li>
        {o.legs.map((l, k) =>
          l.kind === 'walk' ? (
            <WalkItem key={k} leg={l} preference={preference} onFocusPoint={onFocusPoint} />
          ) : (
            <RideItem key={k} leg={l} />
          ),
        )}
        <li className="tl-item endpoint">
          <span className="tl-time num">{clock(o.arrive)}</span>
          <span className="tl-icon">
            <Icon name="flag" />
          </span>
          <div className="tl-body">
            <strong>
              {t('arrive')}: {toName}
            </strong>
          </div>
        </li>
      </ol>
    </section>
  );
}

function WalkItem({ leg: l, preference, onFocusPoint }: { leg: WalkLeg; preference: Preference; onFocusPoint?: (lat: number, lon: number) => void }) {
  const i18n = useT();
  const { t, lang, name } = i18n;
  if (l.inStation) {
    return (
      <li className="tl-item walk in-station">
        <span className="tl-time num">{clock(l.dep)}</span>
        <span className="tl-icon">
          <Icon name="walk" />
        </span>
        <div className="tl-body">
          <p>{t('inStation', { min: minutes(l.seconds, lang) })}</p>
        </div>
      </li>
    );
  }
  return (
    <li className="tl-item walk">
      <span className="tl-time num">{clock(l.dep)}</span>
      <span className="tl-icon">
        <Icon name="walk" />
      </span>
      <div className="tl-body">
        <strong>{t('walkTo', { place: name(l.to) })}</strong>
        {onFocusPoint && l.segments.length > 0 && (
          <button
            type="button"
            className="link small walk-map"
            onClick={() => {
              const pts = l.segments.flatMap((s) => s.line);
              const mid = pts[Math.floor(pts.length / 2)];
              onFocusPoint(mid[1], mid[0]);
            }}
          >
            <Icon name="map" size={18} /> {t('walkOnMap')}
          </button>
        )}
        <p className="walk-sum">
          {t('walkMinutes', { min: minutes(l.seconds, lang), m: metres(l.metres, lang) })}
          {preference === 'cool' && (
            <span className={`pill ${l.sunSeconds < 30 ? 'shade' : 'sun'}`}>
              <Icon name={l.sunSeconds < 30 ? 'shade' : 'sun'} size={18} />
              {l.sunSeconds < 30 ? t('allShade') : t('sunOnWalk', { min: minutes(l.sunSeconds, lang) })}
            </span>
          )}
        </p>
        {l.entrance && (
          <p className={`entrance ${l.entrance.stepFree === false ? 'warn' : ''}`}>
            <Icon name={l.entrance.stepFree ? 'elevator' : 'stairs'} size={20} />
            {l.entrance.exit ? t('exit', { exit: l.entrance.exit }) : ''}
            {l.entrance.stepFree === true && ` · ${t('exitStepFree')}`}
            {l.entrance.stepFree === false && ` · ${t('exitStairsOnly')}`}
          </p>
        )}
        <ol className="segments">
          {l.segments.map((s, k) => (
            <li key={k} className={`segment ${s.shelter ? 'covered' : s.sun === null ? 'unknown' : s.sun < 0.25 ? 'shade' : s.sun < 0.65 ? 'partly' : 'sun'}`}>
              <span className="seg-icon">
                <Icon name={s.stairs ? 'stairs' : s.elevator ? 'elevator' : k > 0 && s.turn ? TURN_ICON[s.turn] ?? 'arrowUp' : 'arrowUp'} size={22} />
              </span>
              <span className="seg-text">{segmentText(s, i18n, preference, k === 0, false)}</span>
              <span className="seg-shade" aria-hidden>
                {s.shelter ? t(s.shelter as Key) : shadeWord(s, i18n)}
              </span>
            </li>
          ))}
        </ol>
        {l.rest.length > 0 && (
          <div className="rest">
            <h4>{t('restOnWay')}</h4>
            <ul>
              {l.rest.map((r, k) => (
                <li key={k}>
                  <button type="button" className="rest-item" onClick={() => onFocusPoint?.(r.lat, r.lon)}>
                    <Icon name={REST_ICON[r.kind]} size={22} />
                    <span>
                      <span className="rest-kind">{t(r.kind === 'cooling' ? (r.designated ? 'rest_cooling' : 'rest_coolingSpot') : (`rest_${r.kind}` as Key))}</span>
                      {r.name && <span className="rest-name"> {name(r.name)}</span>}
                      <span className="rest-meta">
                        {' '}
                        · {t('restAt', { min: minutes(r.atMinute * 60, lang) })}
                        {r.off > 15 ? ` · ${t('restOff', { m: metres(r.off, lang) })}` : ''}
                        {r.hours ? ` · ${r.hours}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

function RideItem({ leg: r }: { leg: RideLeg }) {
  const { t, lang, name } = useT();
  const w = r.wait;
  return (
    <>
      {w.seconds >= 30 && (
        <li className={`tl-item wait ${w.outdoor && w.sun > 0.5 ? 'hot' : ''}`}>
          <span className="tl-time num" />
          <span className="tl-icon">
            <Icon name="clock" />
          </span>
          <div className="tl-body">
            <p>
              {t(w.outdoor ? 'waitStop' : 'waitPlatform', { min: minutes(w.seconds, lang) })}
              {w.outdoor && (
                <span className="wait-facts">
                  {' '}
                  （{w.sheltered === true ? t('waitRoof') : w.sheltered === false ? t('waitNoRoof') : ''}
                  {w.sheltered !== true ? `${w.sheltered === false ? '・' : ''}${w.sun > 0.5 ? t('waitSun') : t('waitShade')}` : ''}
                  {w.bench ? `・${t('waitBench')}` : ''}）
                </span>
              )}
            </p>
            {w.outdoor && w.sun > 0.5 && <p className="tip">{t('waitTip')}</p>}
          </div>
        </li>
      )}
      <li className="tl-item ride" style={{ ['--line' as string]: r.line.color }}>
        <span className="tl-time num">{clock(r.dep)}</span>
        <span className="tl-icon ride-icon" style={{ background: r.line.color }}>
          <Icon name={r.mode === 'bus' ? 'bus' : 'train'} />
        </span>
        <div className="tl-body">
          <p className="ride-from">
            <strong>{name(r.from.name)}</strong>
            {r.from.code && <span className="code">{r.from.code}</span>}
            {r.platform && <span className="muted"> {t('platform', { n: r.platform })}</span>}
            {r.from.pole && <span className="muted"> {r.from.pole}番のりば</span>}
          </p>
          <div className="ride-line">
            <LineChip leg={r} />
            <span>
              {name(r.service)} {t('ride', { line: '', dest: name(r.destination) }).trim()}
            </span>
          </div>
          <ul className="ride-facts">
            <li>{t(r.mode === 'bus' ? 'rideStopsBus' : 'rideStops', { n: r.stops })}</li>
            {r.nonStep && <li className="good">{t('nonStep')}</li>}
            {r.silverPass && <li className="good">{t('silverOk')}</li>}
            {r.live && r.live.delayMinutes > 0 && <li className="warn">{t('delay', { n: r.live.delayMinutes, time: clock(r.live.asOf) })}</li>}
          </ul>
          <p className="ride-to">
            <span className="num">{clock(r.arr)}</span> {t('getOff', { stop: name(r.to.name) })}
          </p>
        </div>
      </li>
    </>
  );
}
