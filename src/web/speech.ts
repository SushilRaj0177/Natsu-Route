import { useCallback, useEffect, useState } from 'react';
import type { Lang } from './i18n.ts';

/**
 * Reads lines aloud with the browser's own voice (no data leaves the
 * device). Japanese uses a ja-JP voice when one is installed.
 */
export function useSpeech(lang: Lang) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  const speak = useCallback(
    (lines: string[]) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const tag = lang === 'ja' ? 'ja-JP' : 'en-GB';
      const voice = synth.getVoices().find((v) => v.lang.replace('_', '-').startsWith(lang === 'ja' ? 'ja' : 'en'));
      lines.forEach((text, i) => {
        // Times read more naturally as "13時5分".
        const spoken = lang === 'ja' ? text.replace(/(\d{1,2}):(\d{2})/g, (_, h, m) => `${Number(h)}時${Number(m) ? `${Number(m)}分` : ''}`) : text;
        const u = new SpeechSynthesisUtterance(spoken);
        u.lang = tag;
        if (voice) u.voice = voice;
        u.rate = 0.9;
        if (i === 0) u.onstart = () => setSpeaking(true);
        if (i === lines.length - 1) u.onend = () => setSpeaking(false);
        u.onerror = () => setSpeaking(false);
        synth.speak(u);
      });
    },
    [lang, supported],
  );

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  return { supported, speaking, speak, stop };
}
