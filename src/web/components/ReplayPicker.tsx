import { useEffect, useRef, useState } from 'react';
import { api, type ReplayDay } from '../api.ts';
import { dateLabel, LEVEL_COLOR } from '../format.ts';
import { useT } from '../i18n.ts';
import { levelOfWbgt } from '../heat.ts';
import { Icon } from './Icon.tsx';

/**
 * Pick a real day from the past summer. The heat index and the sun's path
 * come from that day; trains and buses are today's.
 */
export function ReplayPicker({ current, onPick, onClose }: { current: string | null; onPick: (date: string | null) => void; onClose: () => void }) {
  const { t, lang, name, level } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [days, setDays] = useState<ReplayDay[] | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    api.replays().then(setDays).catch(() => setDays([]));
  }, []);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby="replay-title" onClose={onClose} onCancel={onClose}>
      <div className="sheet-head">
        <h2 id="replay-title">
          <Icon name="sun" /> {t('tryReplay')}
        </h2>
        <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>
          <Icon name="close" /> {t('done')}
        </button>
      </div>
      <p>{t('replayIntro')}</p>
      <ul className="replays">
        {(days ?? []).map((d) => {
          const lv = levelOfWbgt(d.peak);
          return (
            <li key={d.date}>
              <button
                type="button"
                className={`replay-day ${current === d.date ? 'on' : ''}`}
                onClick={() => {
                  onPick(d.date);
                  ref.current?.close();
                }}
              >
                <span className="replay-peak" style={{ background: LEVEL_COLOR[lv].bg, color: LEVEL_COLOR[lv].fg }}>
                  <span className="num">{d.peak.toFixed(1)}</span>
                  <span className="small">{level(lv)}</span>
                </span>
                <span>
                  <strong>{dateLabel(d.date, lang)}</strong>
                  <span className="block">{name(d.label)}</span>
                  {d.alert !== 'none' && <span className="block warn small">{t('replayAlert')}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {current && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onPick(null);
            ref.current?.close();
          }}
        >
          {t('replayOff')}
        </button>
      )}
    </dialog>
  );
}
