import { useEffect, useId, useRef, useState } from 'react';
import type { Names, PlaceHit } from '../../shared/api.ts';
import { api } from '../api.ts';
import { useT, type Key } from '../i18n.ts';
import type { SavedPlace } from '../settings.ts';
import { Icon, type IconName } from './Icon.tsx';

export interface Place {
  name: Names;
  lat: number;
  lon: number;
  /** Chosen as "current location". */
  here?: boolean;
}

interface Props {
  label: string;
  placeholder: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  saved: SavedPlace[];
  onSave?: (p: Place) => void;
  allowHere?: boolean;
  near?: { lat: number; lon: number };
  icon: IconName;
}

const KIND_ICON: Record<PlaceHit['kind'], IconName> = { station: 'train', bus: 'bus', poi: 'building', address: 'pin' };

/**
 * A place box: type a station, bus stop, hospital or address and pick from
 * the list, or tap "current location" or a saved place. Built as an ARIA
 * combobox so screen readers announce the suggestions.
 */
export function PlaceInput({ label, placeholder, value, onChange, saved, allowHere, near, icon }: Props) {
  const { t, name } = useT();
  const id = useId();
  const [text, setText] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!text.trim() || value) {
      setHits([]);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => {
      api
        .places(text.trim(), near, ac.signal)
        .then((h) => {
          setHits(h);
          setActive(h.length ? 0 : -1);
          setOpen(true);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [text, value, near]);

  const pick = (h: PlaceHit) => {
    onChange({ name: h.name, lat: h.lat, lon: h.lon });
    setText('');
    setOpen(false);
  };

  const useHere = () => {
    setError(null);
    if (!navigator.geolocation) {
      setError(t('locationDenied'));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = Math.round(pos.coords.latitude * 1e6) / 1e6;
        const lon = Math.round(pos.coords.longitude * 1e6) / 1e6;
        let place: Names = { ja: t('currentLocation'), en: 'Current location' };
        try {
          const r = await api.reverse(lat, lon);
          if (r.name) place = { ja: `現在地（${r.name}付近）`, en: `Here (near ${r.name})` };
        } catch {
          /* keep the plain name */
        }
        setLocating(false);
        onChange({ name: place, lat, lon, here: true });
      },
      () => {
        setLocating(false);
        setError(t('locationDenied'));
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="place-input">
      <label className="field-label" htmlFor={`${id}-input`}>
        <Icon name={icon} /> {label}
      </label>
      {value ? (
        <div className="chosen">
          <span className="chosen-name">{name(value.name)}</span>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              onChange(null);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            {t('clear')}
          </button>
        </div>
      ) : (
        <div className="combo">
          <input
            ref={inputRef}
            id={`${id}-input`}
            className="text-input"
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder={placeholder}
            value={text}
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => hits.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(hits.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && active >= 0 && hits[active]) {
                e.preventDefault();
                pick(hits[active]);
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <span id={`${id}-hint`} className="sr-only">
            {t('searchHint')}
          </span>
          {open && text.trim() && (
            <ul id={`${id}-list`} className="suggestions" role="listbox" aria-label={label}>
              {hits.length === 0 && <li className="no-hits">{t('noHits')}</li>}
              {hits.map((h, i) => (
                <li
                  key={`${h.kind}-${h.lat}-${h.lon}-${i}`}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(h);
                  }}
                >
                  <Icon name={KIND_ICON[h.kind]} />
                  <span className="hit-text">
                    <span className="hit-name">{name(h.name)}</span>
                    <span className="hit-sub">
                      {h.sub ? name(h.sub) : t(`kind_${h.kind}` as Key)}
                      {h.lines && h.lines.length > 0 && (
                        <span className="hit-lines" aria-hidden>
                          {h.lines.slice(0, 5).map((l, k) => (
                            <span key={k} className="dot" style={{ background: l.color }} title={name(l.name)} />
                          ))}
                        </span>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {!value && (
        <div className="quick" role="group" aria-label={t('savedPlaces')}>
          {allowHere && (
            <button type="button" className="chip" onClick={useHere} disabled={locating}>
              <Icon name="locate" size={20} /> {locating ? t('locating') : t('currentLocation')}
            </button>
          )}
          {saved.map((p) => (
            <button key={p.label} type="button" className="chip" onClick={() => onChange({ name: p.name, lat: p.lat, lon: p.lon })}>
              <Icon name={p.label === '自宅' || p.label === 'Home' ? 'home' : 'star'} size={20} /> {p.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="field-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
