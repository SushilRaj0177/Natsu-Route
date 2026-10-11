import { useEffect, useState } from 'react';
import type { StatusResponse } from '../../shared/api.ts';
import { api } from '../api.ts';
import { clock } from '../format.ts';
import { useT } from '../i18n.ts';
import { Icon } from './Icon.tsx';

/** Line status from ODPT, disrupted lines first, each with the operator's own timestamp. */
export function StatusView() {
  const { t, name, lang } = useT();
  const [s, setS] = useState<StatusResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.status().then(setS).catch(() => setFailed(true));
  }, []);
  if (failed) return <p className="note">{t('statusEmpty')}</p>;
  if (!s) return <div className="card skeleton" aria-busy="true" />;
  const lines = [...s.lines].sort((a, b) => Number(b.disrupted) - Number(a.disrupted));
  return (
    <section className="status" aria-labelledby="status-title">
      <h2 id="status-title">{t('statusTitle')}</h2>
      {lines.length === 0 && <p className="note">{t('statusEmpty')}</p>}
      <ul className="status-list">
        {lines.map((l, i) => (
          <li key={i} className={`status-item ${l.disrupted ? 'bad' : ''}`}>
            <span className="line-dot big" style={{ background: l.line.color }} aria-hidden />
            <div>
              <strong>{name(l.line.name)}</strong> <span className="muted small">{name(l.line.operator)}</span>
              <p>
                {l.disrupted && <Icon name="alert" size={18} />} {lang === 'ja' ? l.text.ja : l.text.en || l.text.ja}
              </p>
              {lang === 'en' && l.text.ja !== l.text.en && (
                <p className="small muted" lang="ja">
                  {t('operatorText')}: {l.text.ja}
                </p>
              )}
              {l.asOf && <p className="small muted">{t('statusAsOf', { time: clock(l.asOf) })}</p>}
            </div>
          </li>
        ))}
      </ul>
      {s.silentOperators.length > 0 && (
        <p className="small muted">
          {t('statusNoFeed')}: {s.silentOperators.map(name).join('・')}
        </p>
      )}
    </section>
  );
}
