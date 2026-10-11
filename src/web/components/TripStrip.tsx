import type { TripOption } from '../../shared/api.ts';
import { minutes } from '../format.ts';
import { useT } from '../i18n.ts';

type Piece = { kind: 'sun' | 'shade' | 'covered' | 'wait-sun' | 'wait' | 'ride'; seconds: number; color?: string };

/**
 * The whole trip as one bar, to scale: walking in sun (orange), in shade
 * (teal), under roofs or underground (grey), waiting at a stop, and riding
 * (the line's colour). The point of the app in one picture.
 */
export function pieces(o: TripOption): Piece[] {
  const out: Piece[] = [];
  for (const l of o.legs) {
    if (l.kind === 'walk') {
      if (l.inStation) {
        out.push({ kind: 'covered', seconds: l.seconds });
        continue;
      }
      for (const s of l.segments) {
        if (s.shelter) out.push({ kind: 'covered', seconds: s.seconds });
        else {
          const sun = Math.min(s.seconds, s.sunSeconds);
          if (sun > 0) out.push({ kind: 'sun', seconds: sun });
          if (s.seconds - sun > 0) out.push({ kind: 'shade', seconds: s.seconds - sun });
        }
      }
      const listed = l.segments.reduce((a, s) => a + s.seconds, 0);
      if (l.seconds - listed > 20) out.push({ kind: 'covered', seconds: l.seconds - listed });
    } else {
      if (l.wait.seconds > 0) {
        if (l.wait.outdoor) {
          const sun = l.wait.seconds * l.wait.sun;
          if (sun > 0) out.push({ kind: 'wait-sun', seconds: sun });
          if (l.wait.seconds - sun > 0) out.push({ kind: 'wait', seconds: l.wait.seconds - sun });
        } else out.push({ kind: 'wait', seconds: l.wait.seconds });
      }
      out.push({ kind: 'ride', seconds: Math.max(60, (Date.parse(l.arr) - Date.parse(l.dep)) / 1000), color: l.line.color });
    }
  }
  return out;
}

export function TripStrip({ option }: { option: TripOption }) {
  const { t, lang } = useT();
  const ps = pieces(option);
  const total = ps.reduce((a, p) => a + p.seconds, 0) || 1;
  return (
    <div
      className="strip"
      role="img"
      aria-label={`${t('inSun')} ${minutes(option.sunSeconds, lang)}, ${t('outdoors')} ${minutes(option.outdoorSeconds, lang)}`}
    >
      {ps.map((p, i) => (
        <span
          key={i}
          className={`strip-piece ${p.kind}`}
          style={{ width: `${(100 * p.seconds) / total}%`, ...(p.color ? { background: p.color } : {}) }}
        />
      ))}
    </div>
  );
}

export function StripLegend() {
  const { t } = useT();
  return (
    <ul className="legend" aria-label="凡例">
      <li>
        <span className="swatch sun" /> {t('mapLegendSun')}
      </li>
      <li>
        <span className="swatch shade" /> {t('mapLegendShade')}
      </li>
      <li>
        <span className="swatch covered" /> {t('mapLegendCovered')}
      </li>
    </ul>
  );
}
