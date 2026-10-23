// Captions: word-timed transcript → on-screen chunks. Pure functions; rendering lives in sprites.ts / layout.ts.
import { type CaptionPreset, type CaptionWord, type Captions, type TextStyle, newId } from '../timeline/model';

export type CaptionPresetDef = {
  label: string;
  /** Words per caption (null = fill lines up to maxChars). */
  maxWords: number | null;
  style: TextStyle;
  /** Karaoke: the word being spoken gets this box/text colour. */
  highlight: { box: string; color: string } | null;
  /** Keyword emphasis: important words get this colour and scale. */
  emphasis: { color: string; scale: number } | null;
  anim: 'pop' | 'fade';
};

export const CAPTION_PRESETS: Record<CaptionPreset, CaptionPresetDef> = {
  wordPop: {
    label: 'Word Pop',
    maxWords: 2,
    style: { font: 'montserrat', size: 96, color: '#ffffff', outline: '#000000', shadow: true, box: null, glow: null, uppercase: true },
    highlight: null,
    emphasis: { color: '#FFE14D', scale: 1 },
    anim: 'pop',
  },
  karaoke: {
    label: 'Karaoke',
    maxWords: null,
    style: { font: 'poppins', size: 70, color: '#ffffff', outline: '#000000', shadow: true, box: null, glow: null, uppercase: false },
    highlight: { box: '#FF2D87', color: '#ffffff' },
    emphasis: null,
    anim: 'fade',
  },
  boldOutline: {
    label: 'Bold Outline',
    maxWords: null,
    style: { font: 'anton', size: 92, color: '#ffffff', outline: '#000000', shadow: true, box: null, glow: null, uppercase: true },
    highlight: null,
    emphasis: null,
    anim: 'pop',
  },
  keyword: {
    label: 'Keyword',
    maxWords: null,
    style: { font: 'montserrat', size: 74, color: '#ffffff', outline: '#000000', shadow: true, box: null, glow: null, uppercase: false },
    highlight: null,
    emphasis: { color: '#FFE14D', scale: 1.3 },
    anim: 'pop',
  },
};

export const CAPTION_PRESET_IDS = Object.keys(CAPTION_PRESETS) as CaptionPreset[];

/** Vertical centre of captions, fraction of the frame — inside TikTok's safe zone. */
export const CAPTION_Y: Record<Captions['position'], number> = { top: 0.2, middle: 0.5, bottom: 0.68 };
/** TikTok's right-hand buttons cover ~13% of the width, so captions centre a little left. */
export const CAPTION_X = 0.465;
/** Widest a caption may be, fraction of the frame width. */
export const CAPTION_MAX_W = 0.8;

export function defaultCaptions(words: CaptionWord[], language: string, preset: CaptionPreset = 'wordPop'): Captions {
  return { words, preset, position: 'bottom', maxChars: 16, lines: 2, emoji: true, language };
}

// ---- text helpers ----

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;
export const isCjk = (s: string) => CJK.test(s);

/** Joins words with spaces, except between CJK characters. */
export function joinWords(words: readonly string[]): string {
  let out = '';
  for (const w of words) {
    const prev = out.slice(-1);
    out += out && !(isCjk(prev) && isCjk(w.charAt(0))) ? ` ${w}` : w;
  }
  return out;
}

/** Splits CJK text into characters, keeping punctuation on the preceding character. */
function splitCjk(t: string): string[] {
  const out: string[] = [];
  for (const ch of t) {
    if (/\p{P}/u.test(ch) && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** Splits typed text into words (CJK text without spaces goes character by character). */
export function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => (isCjk(t) && t.length > 1 ? splitCjk(t) : [t]));
}

const SENTENCE_END = /[.?!。！？…]$/;
const GAP_SEC = 0.7;

export type CaptionChunk = {
  /** Indices into captions.words. */
  first: number;
  last: number;
  start: number;
  /** When it leaves the screen. */
  end: number;
  /** Word indices per line. */
  lines: number[][];
};

function wordLen(w: string): number {
  // CJK glyphs are about twice as wide as Latin letters.
  return isCjk(w) ? w.length * 2 : w.length;
}

/** Groups words into on-screen captions, honouring manual splits/joins, pauses, sentence ends and the length limits. */
export function captionChunks(c: Captions): CaptionChunk[] {
  const preset = CAPTION_PRESETS[c.preset];
  const limit = c.maxChars * c.lines;
  const groups: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  c.words.forEach((w, i) => {
    const prev = cur.length ? c.words[cur[cur.length - 1] as number] : undefined;
    let split = cur.length > 0;
    if (prev) {
      if (w.brk === 'split') split = true;
      else if (w.brk === 'join') split = false;
      else
        split =
          w.start - prev.end > GAP_SEC ||
          SENTENCE_END.test(prev.text) ||
          (preset.maxWords !== null && cur.length >= preset.maxWords) ||
          chars + 1 + wordLen(w.text) > limit;
    }
    if (split) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += (cur.length > 1 ? 1 : 0) + wordLen(w.text);
  });
  if (cur.length) groups.push(cur);

  const chunks = groups.map((g) => {
    const first = g[0] as number;
    const last = g[g.length - 1] as number;
    return {
      first,
      last,
      start: (c.words[first] as CaptionWord).start,
      end: (c.words[last] as CaptionWord).end,
      lines: wrapLines(c, g),
    };
  });
  // Stay up through short pauses, but never overlap the next caption.
  chunks.forEach((ch, k) => {
    const next = chunks[k + 1];
    const hold = Math.max(ch.end + 0.35, ch.start + 0.5);
    ch.end = next ? Math.min(Math.max(hold, ch.end), next.start) : hold;
  });
  return chunks;
}

/** Greedy line wrap at maxChars (a manual join can make more lines than `c.lines`; that's the user's call). */
function wrapLines(c: Captions, idx: number[]): number[][] {
  const lines: number[][] = [[]];
  let len = 0;
  for (const i of idx) {
    const w = (c.words[i] as CaptionWord).text;
    const line = lines[lines.length - 1] as number[];
    if (line.length > 0 && len + 1 + wordLen(w) > c.maxChars) {
      lines.push([i]);
      len = wordLen(w);
    } else {
      line.push(i);
      len += (line.length > 1 ? 1 : 0) + wordLen(w);
    }
  }
  return lines;
}

/** Index of the caption on screen at `t`, or -1. */
export function chunkAt(chunks: readonly CaptionChunk[], t: number): number {
  return chunks.findIndex((ch) => t >= ch.start && t < ch.end);
}

/** The word being spoken at `t` within a chunk (the last one that has started). */
export function activeWord(c: Captions, ch: CaptionChunk, t: number): number {
  let active = ch.first;
  for (let i = ch.first; i <= ch.last; i++) if ((c.words[i] as CaptionWord).start <= t) active = i;
  return active;
}

// ---- emphasis & emoji ----

const STOP = new Set(
  'the and that this with have from your just about what when they there their will would could should because really which while where these those than then them very into over been being were here'.split(
    ' ',
  ),
);
const KEYWORDS = new Set(
  'free new sale best wow omg love cute funny crazy amazing win winner cat cats kitten kitty dog puppy promo deal today now percuma baru comel sayang kucing murah 免费 新 爱 猫 狗'.split(
    ' ',
  ),
);

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}$%]/gu, '');

/** Important words for the Keyword preset: numbers, prices, shouted words, a keyword list, long content words. */
export function isKeyword(word: string): boolean {
  const b = bare(word);
  if (!b) return false;
  if (/\d/.test(b) || /^rm\d/.test(b) || b.includes('$') || b.includes('%')) return true;
  if (word.length >= 2 && word === word.toUpperCase() && /\p{Lu}/u.test(word)) return true;
  if (KEYWORDS.has(b)) return true;
  return !isCjk(b) && b.length >= 7 && !STOP.has(b);
}

const EMOJI: Array<[RegExp, string]> = [
  [/^(cat|cats|kitten|kittens|kitty|meow|kucing|猫|猫咪)$/, '😺'],
  [/^(dog|dogs|puppy|puppies|anjing|狗|小狗)$/, '🐶'],
  [/^(love|loves|loved|sayang|爱|喜欢)$/, '❤️'],
  [/^(funny|haha|hahaha|lol|lucu|好笑|哈哈)$/, '😂'],
  [/^(wow|amazing|awesome|omg|哇)$/, '🤩'],
  [/^(food|eat|eating|hungry|makan|吃)$/, '🍽️'],
  [/^(sleep|sleeping|sleepy|nap|tidur|睡|睡觉)$/, '😴'],
  [/^(happy|gembira|开心)$/, '😊'],
  [/^(cute|adorable|comel|可爱)$/, '🥰'],
  [/^(new|baru|新)$/, '✨'],
  [/^(free|percuma|免费)$/, '🎁'],
  [/^(sale|promo|hot|deal)$/, '🔥'],
  [/^(money|price|harga|cheap|murah|钱)$/, '💰'],
  [/^(play|playing|toy|main|玩)$/, '🧶'],
];

export function emojiFor(word: string): string | null {
  const b = bare(word);
  for (const [re, e] of EMOJI) if (re.test(b)) return e;
  return null;
}

/** Display text of each word in a chunk (case per preset, one emoji per caption when enabled). */
export function chunkWordTexts(c: Captions, ch: CaptionChunk): string[] {
  const preset = CAPTION_PRESETS[c.preset];
  const out: string[] = [];
  let emojiUsed = false;
  for (let i = ch.first; i <= ch.last; i++) {
    const raw = (c.words[i] as CaptionWord).text;
    let text = preset.style.uppercase ? raw.toUpperCase() : raw;
    const e = c.emoji && !emojiUsed ? emojiFor(raw) : null;
    if (e) {
      text += ` ${e}`;
      emojiUsed = true;
    }
    out.push(text);
  }
  return out;
}

// ---- editing (keeps timings) ----

/** Builds word timings for typed text spread over [start, end], weighted by word length. */
export function spreadWords(tokens: readonly string[], start: number, end: number, makeId: () => string = newId): CaptionWord[] {
  const weights = tokens.map((t) => wordLen(t) + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return tokens.map((text, i) => {
    const d = ((end - start) * (weights[i] as number)) / total;
    const w: CaptionWord = { id: makeId(), text, start: t, end: t + d };
    t += d;
    return w;
  });
}

/** Replaces the text of one caption. Same word count keeps each word's timing; otherwise timings are re-spread. */
export function setChunkText(c: Captions, ch: CaptionChunk, text: string, makeId: () => string = newId): Captions {
  const old = c.words.slice(ch.first, ch.last + 1);
  const tokens = tokenize(text);
  let replaced: CaptionWord[];
  if (tokens.length === old.length) {
    replaced = old.map((w, i) => ({ ...w, text: tokens[i] as string }));
  } else {
    replaced = spreadWords(tokens, ch.start, (c.words[ch.last] as CaptionWord).end, makeId).map((w, i) => ({
      ...w,
      brk: i === 0 ? 'split' : 'join',
    }));
  }
  const words = [...c.words.slice(0, ch.first), ...replaced, ...c.words.slice(ch.last + 1)];
  const after = words[ch.first + replaced.length];
  if (after && replaced.length !== old.length) words[ch.first + replaced.length] = { ...after, brk: 'split' };
  return { ...c, words };
}

/** Starts a new caption at word `index`. */
export function splitBefore(c: Captions, index: number): Captions {
  return { ...c, words: c.words.map((w, i) => (i === index ? { ...w, brk: 'split' } : w)) };
}

/** Merges a caption with the next one. */
export function mergeWithNext(c: Captions, chunks: readonly CaptionChunk[], k: number): Captions {
  const ch = chunks[k];
  const next = chunks[k + 1];
  if (!ch || !next) return c;
  return {
    ...c,
    words: c.words.map((w, i) => (i > ch.first && i <= next.last ? { ...w, brk: 'join' } : w)),
  };
}

export function removeChunk(c: Captions, ch: CaptionChunk): Captions {
  return { ...c, words: [...c.words.slice(0, ch.first), ...c.words.slice(ch.last + 1)] };
}

/** Captions typed by hand (no speech): spread over [start, end], one line of text per caption. */
export function manualCaptions(text: string, start: number, end: number, language = 'manual'): Captions {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tokens = lines.flatMap((l) => tokenize(l));
  const words = spreadWords(tokens, start, end);
  // Each typed line becomes its own caption.
  let k = 0;
  for (const l of lines) {
    const n = tokenize(l).length;
    words.forEach((w, i) => {
      if (i === k) w.brk = 'split';
      else if (i > k && i < k + n) w.brk = 'join';
    });
    k += n;
  }
  return { ...defaultCaptions(words, language, 'boldOutline'), emoji: false };
}
