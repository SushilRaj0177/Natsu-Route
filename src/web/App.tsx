import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanQuery, PlanResponse } from '../shared/api.ts';
import { api, type HeatResponse } from './api.ts';
import { dateLabel, tokyoInstant, tokyoParts } from './format.ts';
import { I18nContext, makeI18n, type Key } from './i18n.ts';
import { SPEED_MS, useSavedPlaces, useSettings } from './settings.ts';
import { HeatCard } from './components/HeatCard.tsx';
import { PlaceInput, type Place } from './components/PlaceInput.tsx';
import { OptionCard } from './components/OptionCard.tsx';
import { TripDetail } from './components/TripDetail.tsx';
import { BestTime } from './components/BestTime.tsx';
import { SettingsSheet } from './components/SettingsSheet.tsx';
import { ReplayPicker } from './components/ReplayPicker.tsx';
import { StatusView } from './components/StatusView.tsx';
import { AboutView } from './components/AboutView.tsx';
import { Icon } from './components/Icon.tsx';

const MapView = lazy(() => import('./components/MapView.tsx'));

type Tab = 'plan' | 'status' | 'about';
type WhenMode = 'now' | 'depart' | 'arrive';

interface When {
  mode: WhenMode;
  date: string;
  minute: number;
}

/** State that a link can carry: #f=lat,lon,name&t=…&w=depart|arrive&d=date&m=minute&r=replay */
function readHash(): { from?: Place; to?: Place; when?: When; replay?: string } {
  const h = new URLSearchParams(location.hash.slice(1));
  const place = (v: string | null): Place | undefined => {
    if (!v) return undefined;
    const [lat, lon, ...rest] = v.split(',');
    const nm = decodeURIComponent(rest.join(','));
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return undefined;
    return { lat: Number(lat), lon: Number(lon), name: { ja: nm, en: nm } };
  };
  const w = h.get('w') as WhenMode | null;
  return {
    from: place(h.get('f')),
    to: place(h.get('t')),
    when: w && w !== 'now' && h.get('d') && h.get('m') ? { mode: w, date: h.get('d')!, minute: Number(h.get('m')) } : undefined,
    replay: h.get('r') ?? undefined,
  };
}

function writeHash(from: Place | null, to: Place | null, when: When, replay: string | null, lang: 'ja' | 'en') {
  const h = new URLSearchParams();
  const enc = (p: Place) => `${p.lat},${p.lon},${encodeURIComponent(lang === 'ja' ? p.name.ja : p.name.en)}`;
  if (from) h.set('f', enc(from));
  if (to) h.set('t', enc(to));
  if (when.mode !== 'now') {
    h.set('w', when.mode);
    h.set('d', when.date);
    h.set('m', String(when.minute));
  }
  if (replay) h.set('r', replay);
  const s = h.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname);
}

export function App() {
  const [settings, update] = useSettings();
  const [saved, savePlace] = useSavedPlaces();
  const i18n = useMemo(() => makeI18n(settings.lang), [settings.lang]);
  const { t, name } = i18n;

  const initial = useRef(readHash());
  const [tab, setTab] = useState<Tab>('plan');
  const [from, setFrom] = useState<Place | null>(initial.current.from ?? null);
  const [to, setTo] = useState<Place | null>(initial.current.to ?? null);
  const nowParts = tokyoParts(Date.now());
  const [when, setWhen] = useState<When>(initial.current.when ?? { mode: 'now', date: nowParts.date, minute: Math.ceil(nowParts.minute / 10) * 10 });
  const [replay, setReplay] = useState<string | null>(initial.current.replay ?? null);
  const [heat, setHeat] = useState<HeatResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [query, setQuery] = useState<PlanQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [showBest, setShowBest] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [focus, setFocus] = useState<{ lat: number; lon: number; n: number } | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Heat for where the person starts (or central Tokyo).
  useEffect(() => {
    const p = from ?? { lat: 35.68, lon: 139.76 };
    setHeat(null);
    api.heat(p.lat, p.lon, replay ?? undefined).then(setHeat).catch(() => setHeat({ point: { ja: '東京', en: 'Tokyo' }, inSeason: false, now: null, hours: [], alert: null, replay: null }));
  }, [from?.lat, from?.lon, replay]);

  useEffect(() => writeHash(from, to, when, replay, settings.lang), [from, to, when, replay, settings.lang]);

  const run = useCallback(
    async (overrideAt?: string) => {
      if (!from || !to) return;
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      const at = overrideAt ?? (when.mode === 'now' ? new Date().toISOString() : tokyoInstant(when.date, when.minute));
      const q: PlanQuery = {
        from: { lat: from.lat, lon: from.lon, name: from.name },
        to: { lat: to.lat, lon: to.lon, name: to.name },
        at,
        arriveBy: !overrideAt && when.mode === 'arrive',
        speed: SPEED_MS[settings.speed],
        stairs: settings.stairs,
        maxWalkMinutes: settings.maxWalkMinutes,
        mode: settings.season,
        priority: settings.priority,
        silverPass: settings.silverPass,
        replay: replay ?? undefined,
      };
      setLoading(true);
      setError(null);
      setSelected(null);
      setShowBest(false);
      try {
        const res = await api.plan(q, ac.signal);
        setPlan(res);
        setQuery(q);
        setTimeout(() => resultsRef.current?.focus(), 50);
      } catch (e) {
        if (!ac.signal.aborted) setError((e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [from, to, when, settings, replay],
  );

  // A shared link plans straight away.
  const ranFromLink = useRef(false);
  useEffect(() => {
    if (!ranFromLink.current && initial.current.from && initial.current.to) {
      ranFromLink.current = true;
      void run();
    }
  }, [run]);

  const option = plan?.options.find((o) => o.id === selected) ?? null;
  const mapOption = option ?? plan?.options[0] ?? null;
  const preference = plan?.preference ?? 'cool';
  const replayInfo = heat?.replay;
  const findLabel = (settings.season === 'auto' && (heat?.now || replay)) || settings.season === 'cool' ? t('find') : t('findWarm');

  return (
    <I18nContext.Provider value={i18n}>
      <a className="skip" href="#main">
        {t('skip')}
      </a>
      <header className="top">
        <button type="button" className="brand" onClick={() => { setTab('plan'); setSelected(null); }}>
          <img src="/icon.svg" alt="" width={40} height={40} />
          <span>
            <span className="brand-name">{t('appName')}</span>
            <span className="brand-tag">{t('tagline')}</span>
          </span>
        </button>
        <nav className="tabs" aria-label="menu">
          {(['plan', 'status', 'about'] as const).map((k) => (
            <button key={k} type="button" className={tab === k ? 'on' : undefined} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
              {t(k === 'plan' ? 'tabPlan' : k === 'status' ? 'tabStatus' : 'tabAbout')}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <button type="button" className="btn ghost" onClick={() => update({ lang: settings.lang === 'ja' ? 'en' : 'ja' })} aria-label={t('language')}>
            {settings.lang === 'ja' ? 'EN' : '日本語'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setShowSettings(true)}>
            <Icon name="gear" /> <span className="hide-narrow">{t('settings')}</span>
          </button>
        </div>
      </header>

      {replay && replayInfo && (
        <div className="replay-banner" role="status">
          <Icon name="sun" />
          <span>{t('replayOn', { date: dateLabel(replayInfo.date, settings.lang), label: name(replayInfo.label) })}</span>
          <button type="button" className="btn small" onClick={() => setShowReplay(true)}>
            {t('tryReplay')}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setReplay(null)}>
            {t('replayOff')}
          </button>
        </div>
      )}

      <div className={`layout ${tab === 'plan' ? 'with-map' : ''} ${mapOpen ? 'map-open' : ''}`}>
        <main id="main" className="panel" tabIndex={-1}>
          {tab === 'status' && <StatusView />}
          {tab === 'about' && <AboutView />}
          {tab === 'plan' && option && (
            <TripDetail
              option={option}
              preference={preference}
              silverPass={settings.silverPass}
              fromName={from ? name(from.name) : ''}
              toName={to ? name(to.name) : ''}
              onBack={() => setSelected(null)}
              onShowMap={() => setMapOpen(true)}
              onFocusPoint={(lat, lon) => {
                setFocus({ lat, lon, n: Date.now() });
                setMapOpen(true);
              }}
            />
          )}
          {tab === 'plan' && !option && (
            <>
              <HeatCard heat={heat} onReplay={() => setShowReplay(true)} />
              {!replay && heat && heat.now && (
                <p className="replay-link">
                  <button type="button" className="link" onClick={() => setShowReplay(true)}>
                    <Icon name="sun" size={20} /> {t('tryReplay')}
                  </button>
                </p>
              )}
              <form
                className="plan card"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run();
                }}
              >
                <PlaceInput label={t('from')} placeholder={t('whereFrom')} value={from} onChange={setFrom} saved={saved} allowHere icon="home" near={to ?? undefined} />
                <button
                  type="button"
                  className="btn ghost swap"
                  onClick={() => {
                    setFrom(to);
                    setTo(from);
                  }}
                  aria-label={t('swap')}
                >
                  <Icon name="swap" />
                </button>
                <PlaceInput label={t('to')} placeholder={t('whereTo')} value={to} onChange={setTo} saved={saved} icon="flag" near={from ?? undefined} />
                {to && !saved.some((p) => p.lat === to.lat && p.lon === to.lon) && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      const label = prompt(t('savedAs'), name(to.name));
                      if (label) savePlace({ label, name: to.name, lat: to.lat, lon: to.lon });
                    }}
                  >
                    <Icon name="star" size={18} /> {t('savePlace')}
                  </button>
                )}
                <fieldset className="when">
                  <legend>
                    <Icon name="clock" /> {t('when')}
                  </legend>
                  <div className="segmented">
                    {(['now', 'depart', 'arrive'] as const).map((m) => (
                      <label key={m} className={when.mode === m ? 'on' : undefined}>
                        <input type="radio" name="when" checked={when.mode === m} onChange={() => setWhen({ ...when, mode: m })} />
                        {t(m === 'now' ? 'now' : m === 'depart' ? 'departAt' : 'arriveBy')}
                      </label>
                    ))}
                  </div>
                  {when.mode !== 'now' && (
                    <div className="when-row">
                      <div className="segmented small">
                        {[0, 1].map((d) => {
                          const date = tokyoParts(Date.now() + d * 86_400_000).date;
                          return (
                            <label key={d} className={when.date === date ? 'on' : undefined}>
                              <input type="radio" name="day" checked={when.date === date} onChange={() => setWhen({ ...when, date })} />
                              {t(d === 0 ? 'today' : 'tomorrow')}
                            </label>
                          );
                        })}
                      </div>
                      <input
                        className="time-input"
                        type="time"
                        step={600}
                        value={`${String(Math.floor(when.minute / 60)).padStart(2, '0')}:${String(when.minute % 60).padStart(2, '0')}`}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(':').map(Number);
                          if (Number.isFinite(h)) setWhen({ ...when, minute: h * 60 + (m || 0) });
                        }}
                        aria-label={t(when.mode === 'arrive' ? 'arriveBy' : 'departAt')}
                      />
                      {when.mode === 'arrive' && <span className="muted small">{t('arriveByHint')}</span>}
                    </div>
                  )}
                </fieldset>
                <button type="submit" className="btn primary huge block" disabled={!from || !to || loading}>
                  <Icon name={settings.season === 'warm' ? 'sun' : 'shade'} size={28} /> {loading ? t('searching') : findLabel}
                </button>
                <p className="settings-summary">
                  <button type="button" className="link" onClick={() => setShowSettings(true)}>
                    {t(`speed_${settings.speed}` as Key)}・{t('stairs')}: {t(`stairs_${settings.stairs}` as Key)}・{t('maxWalk')} {t('minutesShort', { n: settings.maxWalkMinutes })}
                    {settings.silverPass ? `・${t('silverPass')}` : ''}
                  </button>
                </p>
              </form>

              {loading && (
                <div className="loading card" role="status">
                  <span className="spinner" aria-hidden />
                  <div>
                    <strong>{t('searching')}</strong>
                    <p className="muted">{t('searchingDetail')}</p>
                  </div>
                </div>
              )}
              {error && !loading && (
                <p className="note error" role="alert">
                  <Icon name="alert" /> {t('error')}
                </p>
              )}
              {plan && !loading && (
                <section className="results" aria-labelledby="results-title">
                  <h2 id="results-title" ref={resultsRef} tabIndex={-1}>
                    {t('results')}
                  </h2>
                  {plan.notes.map((nt, k) => (
                    <p key={k} className="note">
                      <Icon name="info" size={20} /> {name(nt)}
                    </p>
                  ))}
                  {plan.options.length === 0 && <p className="note">{t('noOptions')}</p>}
                  <div className="options" aria-live="polite">
                    {plan.options.map((o) => (
                      <OptionCard key={o.id} option={o} preference={preference} silverPass={settings.silverPass} onOpen={() => { setSelected(o.id); window.scrollTo({ top: 0 }); }} />
                    ))}
                  </div>
                  {plan.options.length > 0 && query && !query.arriveBy && (
                    <div className="best-wrap">
                      {!showBest ? (
                        <button type="button" className="btn big block" onClick={() => setShowBest(true)}>
                          <Icon name="clock" /> {t('bestTime')}
                        </button>
                      ) : (
                        <BestTime
                          query={query}
                          onPick={(iso) => {
                            const p = tokyoParts(Date.parse(iso));
                            setWhen({ mode: 'depart', date: tokyoParts(Date.now()).date, minute: p.minute });
                            void run(iso);
                          }}
                        />
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
        {tab === 'plan' && (
          <aside className="map-side" aria-label={t('showMap')}>
            {mapOpen && (
              <button type="button" className="btn primary map-close" onClick={() => setMapOpen(false)}>
                <Icon name="list" /> {t('showList')}
              </button>
            )}
            <Suspense fallback={<div className="map-loading" />}>
              <MapView option={mapOption} sunDate={replay} theme={theme} focus={focus} />
            </Suspense>
          </aside>
        )}
      </div>

      {showSettings && <SettingsSheet settings={settings} update={update} onClose={() => setShowSettings(false)} />}
      {showReplay && <ReplayPicker current={replay} onPick={setReplay} onClose={() => setShowReplay(false)} />}
    </I18nContext.Provider>
  );
}
