/**
 * Kana to Hepburn romaji, for bus stops that ODPT publishes with a Japanese
 * name and a kana reading but no English name. Long vowels are written
 * without macrons (as on most Tokyo signs: "Toei", "Shinjuku").
 */
const BASE: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
};
const YOON: Record<string, string> = { ゃ: 'a', ゅ: 'u', ょ: 'o' };

function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function romaji(kana: string): string {
  const s = toHiragana(kana.normalize('NFKC'));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (c === 'っ') {
      const r = BASE[next] ?? '';
      out += r.startsWith('ch') ? 't' : r[0] ?? '';
      continue;
    }
    if (c === 'ー') continue;
    if (next && YOON[next]) {
      const r = BASE[c];
      if (r) {
        const v = YOON[next];
        if (r === 'shi') out += 'sh' + v;
        else if (r === 'chi') out += 'ch' + v;
        else if (r === 'ji') out += 'j' + v;
        else out += r.slice(0, -1) + 'y' + v;
        i++;
        continue;
      }
    }
    if (c === 'ん') {
      out += /[aiueoy]/.test(BASE[next]?.[0] ?? '') ? "n'" : 'n';
      continue;
    }
    out += BASE[c] ?? c;
  }
  // Collapse doubled long vowels the way signs do: "ou" → "o", "uu" → "u".
  out = out.replace(/ou/g, 'o').replace(/uu/g, 'u').replace(/oo/g, 'o');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
