// Teaching Whisper the owner's words. Captions are Malay with English mixed in; with the language fixed to Malay,
// Whisper spells English words the Malay way ("onboard" → "ombut"). Three helpers:
//  - a style prompt (Malay sentences with English words) + the user's own word list → Whisper prompt
//  - corrections the user makes in the caption list are learned (old → new) and applied to later transcriptions
//  - a correction is applied across the whole current transcript at once
import type { TimedWord } from './protocol';

/** How the owner talks: Malay with English words in it. Steers Whisper to keep English loanwords as English. */
const STYLE =
  'Okay guys, hari ini kita nak tunjuk kitten baru yang baru onboard dekat cattery kami. Dia sangat cute and playful, ' +
  'suka main dengan toy dia. So jangan lupa follow, like and share, okay?';

const WORDS_KEY = 'pawcut.captionWords';
const FIXES_KEY = 'pawcut.captionFixes';
const MAX_FIXES = 300;

export type Fixes = Record<string, string>;

/** Lowercase letters/digits only — how words are compared. */
export const wordKey = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Puts `replacement` in place of `original`'s letters, keeping its leading/trailing punctuation. */
function keepPunctuation(original: string, replacement: string): string {
  const lead = /^[^\p{L}\p{N}]*/u.exec(original)?.[0] ?? '';
  const trail = /[^\p{L}\p{N}]*$/u.exec(original)?.[0] ?? '';
  return lead + replacement + trail;
}

/** Applies learned corrections to transcribed words (whole-word, case-insensitive, punctuation kept). */
export function applyFixes<W extends Pick<TimedWord, 'text'>>(words: readonly W[], fixes: Fixes): W[] {
  return words.map((w) => {
    const fix = fixes[wordKey(w.text)];
    return fix ? { ...w, text: keepPunctuation(w.text, fix) } : w;
  });
}

/** Word-for-word differences between an old and an edited caption (same word count only). */
export function learnFixes(before: readonly string[], after: readonly string[]): Fixes {
  const out: Fixes = {};
  if (before.length !== after.length) return out;
  before.forEach((b, i) => {
    const a = after[i] as string;
    const bk = wordKey(b);
    const core = a.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    // Only real word changes (not just punctuation or case).
    if (bk && core && bk !== wordKey(a)) out[bk] = core;
  });
  return out;
}

/** Whisper prompt: style sentence + the user's words + words learned from corrections (most recent last). */
export function buildPrompt(userWords: string, fixes: Fixes): string {
  const learned = [...new Set(Object.values(fixes))];
  const words = [...userWords.split(/[,\n]/).map((w) => w.trim()), ...learned].filter(Boolean);
  return words.length ? `${STYLE} ${[...new Set(words)].join(', ')}.` : STYLE;
}

// ---- persisted (per device) ----

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / full: just not remembered.
  }
}

export const savedWords = (): string => read(WORDS_KEY, '');
export const saveWords = (words: string) => write(WORDS_KEY, words);
export const savedFixes = (): Fixes => read(FIXES_KEY, {});

export function rememberFixes(fixes: Fixes): void {
  if (Object.keys(fixes).length === 0) return;
  // Newest last, so the cap drops the oldest.
  const merged = Object.entries({ ...savedFixes(), ...fixes }).slice(-MAX_FIXES);
  write(FIXES_KEY, Object.fromEntries(merged));
}
