import { useCallback, useEffect, useState } from 'react';
import type { Names, PlanQuery } from '../shared/api.ts';
import type { Lang } from './i18n.ts';

/** What a person tells the app once; kept on this device only. */
export interface Settings {
  lang: Lang;
  speed: 'slow' | 'normal' | 'brisk';
  stairs: NonNullable<PlanQuery['stairs']>;
  maxWalkMinutes: number;
  silverPass: boolean;
  priority: NonNullable<PlanQuery['priority']>;
  season: NonNullable<PlanQuery['mode']>;
  textSize: 'normal' | 'large' | 'xlarge';
  contrast: boolean;
}

export interface SavedPlace {
  label: string;
  name: Names;
  lat: number;
  lon: number;
}

export const SPEED_MS: Record<Settings['speed'], number> = { slow: 0.8, normal: 1.0, brisk: 1.2 };

const DEFAULTS: Settings = {
  lang: typeof navigator !== 'undefined' && !navigator.language?.startsWith('ja') ? 'en' : 'ja',
  speed: 'normal',
  stairs: 'avoid',
  maxWalkMinutes: 15,
  silverPass: false,
  priority: 'balanced',
  season: 'auto',
  textSize: 'large',
  contrast: false,
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: settings last for this visit */
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(() => read('natsuroute.settings', DEFAULTS));
  const update = useCallback((patch: Partial<Settings>) => {
    setS((prev) => {
      const next = { ...prev, ...patch };
      write('natsuroute.settings', next);
      return next;
    });
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.lang = s.lang;
    root.dataset.size = s.textSize;
    root.dataset.contrast = s.contrast ? 'high' : 'normal';
  }, [s.lang, s.textSize, s.contrast]);
  return [s, update];
}

export function useSavedPlaces(): [SavedPlace[], (p: SavedPlace) => void, (label: string) => void] {
  const [list, setList] = useState<SavedPlace[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('natsuroute.places') ?? '[]') as SavedPlace[];
    } catch {
      return [];
    }
  });
  const save = useCallback((p: SavedPlace) => {
    setList((prev) => {
      const next = [...prev.filter((x) => x.label !== p.label), p].slice(-8);
      write('natsuroute.places', next);
      return next;
    });
  }, []);
  const remove = useCallback((label: string) => {
    setList((prev) => {
      const next = prev.filter((x) => x.label !== label);
      write('natsuroute.places', next);
      return next;
    });
  }, []);
  return [list, save, remove];
}
