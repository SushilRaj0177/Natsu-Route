import { useEffect, useRef } from 'react';
import { useT, type Key } from '../i18n.ts';
import type { Settings } from '../settings.ts';
import { Icon } from './Icon.tsx';

interface Props {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  onClose: () => void;
}

function Choice<V extends string | number | boolean>({
  legend,
  value,
  options,
  onChange,
  help,
}: {
  legend: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  help?: string;
}) {
  return (
    <fieldset className="choice">
      <legend>{legend}</legend>
      {help && <p className="muted small">{help}</p>}
      <div className="segmented">
        {options.map((o) => (
          <label key={String(o.value)} className={o.value === value ? 'on' : undefined}>
            <input type="radio" name={legend} checked={o.value === value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Everything that tailors the route to the person, in one sheet. */
export function SettingsSheet({ settings: s, update, onClose }: Props) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby="settings-title" onClose={onClose} onCancel={onClose}>
      <div className="sheet-head">
        <h2 id="settings-title">
          <Icon name="gear" /> {t('settings')}
        </h2>
        <button type="button" className="btn primary" onClick={() => ref.current?.close()}>
          {t('done')}
        </button>
      </div>
      <p className="muted">{t('settingsIntro')}</p>
      <Choice
        legend={t('speed')}
        value={s.speed}
        onChange={(speed) => update({ speed })}
        options={(['slow', 'normal', 'brisk'] as const).map((v) => ({ value: v, label: t(`speed_${v}` as Key) }))}
      />
      <Choice
        legend={t('stairs')}
        value={s.stairs}
        onChange={(stairs) => update({ stairs })}
        options={(['ok', 'avoid', 'never'] as const).map((v) => ({ value: v, label: t(`stairs_${v}` as Key) }))}
      />
      <Choice
        legend={t('maxWalk')}
        value={s.maxWalkMinutes}
        onChange={(maxWalkMinutes) => update({ maxWalkMinutes })}
        options={[5, 10, 15, 20].map((v) => ({ value: v, label: t('minutesShort', { n: v }) }))}
      />
      <Choice legend={t('silverPass')} help={t('silverPassHelp')} value={s.silverPass} onChange={(silverPass) => update({ silverPass })} options={[{ value: true, label: t('have') }, { value: false, label: t('haveNot') }]} />
      <Choice
        legend={t('priority')}
        value={s.priority}
        onChange={(priority) => update({ priority })}
        options={(['cool', 'balanced', 'fast'] as const).map((v) => ({ value: v, label: t(`priority_${v}` as Key) }))}
      />
      <Choice
        legend={t('season')}
        help={t('seasonHelp')}
        value={s.season}
        onChange={(season) => update({ season })}
        options={(['auto', 'cool', 'warm', 'rain'] as const).map((v) => ({ value: v, label: t(`season_${v}` as Key) }))}
      />
      <Choice
        legend={t('textSize')}
        value={s.textSize}
        onChange={(textSize) => update({ textSize })}
        options={(['normal', 'large', 'xlarge'] as const).map((v) => ({ value: v, label: t(`size_${v}` as Key) }))}
      />
      <Choice legend={t('contrast')} value={s.contrast} onChange={(contrast) => update({ contrast })} options={[{ value: false, label: t('size_normal') }, { value: true, label: t('contrast') }]} />
      <Choice legend={t('language')} value={s.lang} onChange={(lang) => update({ lang })} options={[{ value: 'ja', label: '日本語' }, { value: 'en', label: 'English' }]} />
    </dialog>
  );
}
