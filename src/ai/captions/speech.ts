// Pure helpers around Whisper: which source ranges to transcribe, where the speech is (simple energy VAD — Whisper
// invents "thanks for watching" on silence and noise), cleaning its output (known hallucinations, loops), and
// placing words from source time onto every clip that uses them.
import type { SpeechSource, TimedWord } from './protocol';

export type Range = { from: number; to: number };

/** Context kept around each used stretch of a file, and the gap below which stretches are transcribed together. */
const CONTEXT_SEC = 1;
const JOIN_GAP_SEC = 2;

/** Merged source ranges of one file to transcribe (so many short clips share context instead of failing alone). */
export function sourceRanges(clips: readonly Pick<SpeechSource, 'inSec' | 'outSec'>[]): Range[] {
  const sorted = clips
    .map((c) => ({ from: Math.max(0, c.inSec - CONTEXT_SEC), to: c.outSec + CONTEXT_SEC }))
    .sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + JOIN_GAP_SEC) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

const FRAME_SEC = 0.03;

/**
 * Speech regions (seconds) in 16 kHz mono audio: frames well above the noise floor, smoothed with a hangover,
 * short blips dropped, close regions merged, a little padding added.
 */
export function speechRegions(samples: Float32Array, sampleRate: number): Range[] {
  const frame = Math.max(1, Math.round(FRAME_SEC * sampleRate));
  const n = Math.floor(samples.length / frame);
  if (n === 0) return [];
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * frame; k < (i + 1) * frame; k++) sum += (samples[k] as number) ** 2;
    db[i] = 10 * Math.log10(sum / frame + 1e-10);
  }
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.2)] as number;
  const loud = sorted[Math.floor(n * 0.95)] as number;
  // Speech must stand out from the floor, and be louder than near-silence. With almost no dynamic range (all
  // noise, or all speech) fall back to "everything above −45 dBFS".
  const threshold = loud - floor < 10 ? -45 : Math.max(-50, floor + Math.min(12, (loud - floor) * 0.35));

  const regions: Range[] = [];
  const hang = Math.round(0.3 / FRAME_SEC);
  let start = -1;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    if ((db[i] as number) > threshold) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > hang) {
      regions.push({ from: start * FRAME_SEC, to: (i - quiet + 1) * FRAME_SEC });
      start = -1;
      quiet = 0;
    }
  }
  if (start >= 0) regions.push({ from: start * FRAME_SEC, to: n * FRAME_SEC });

  const total = samples.length / sampleRate;
  const merged: Range[] = [];
  for (const r of regions) {
    if (r.to - r.from < 0.2) continue;
    const padded = { from: Math.max(0, r.from - 0.25), to: Math.min(total, r.to + 0.25) };
    const last = merged[merged.length - 1];
    if (last && padded.from - last.to < 0.6) last.to = padded.to;
    else merged.push(padded);
  }
  return merged;
}

/** Phrases Whisper is known to invent on silence / noise / music (YouTube outros, subtitle credits). */
const HALLUCINATIONS = [
  'thank you for watching',
  'thanks for watching',
  'thank you so much for watching',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'see you in the next video',
  'see you next time',
  'terima kasih kerana menonton',
  'terima kasih kerana menonton video ini',
  'terima kasih telah menonton',
  'terima kasih sudah menonton',
  'jangan lupa subscribe',
  'jangan lupa like dan subscribe',
  'sampai jumpa',
  'sampai jumpa lagi',
  'subtitles by the amara.org community',
];

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const PHRASES = [...new Set(HALLUCINATIONS.map(norm))].sort((a, b) => b.length - a.length);
const MAX_PHRASE_WORDS = 14;

/** Drops hallucinated phrases and collapses loops (the same 1–5 words repeated back to back). */
export function cleanWords(words: readonly TimedWord[]): TimedWord[] {
  const keys = words.map((w) => norm(w.text));
  const drop = new Uint8Array(words.length);
  // Hallucinated phrases, matched on letters only so spacing and punctuation (and CJK per-character words) don't matter.
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(words.length, i + MAX_PHRASE_WORDS); j++) {
      joined += keys[j];
      if (PHRASES.includes(joined)) {
        for (let k = i; k <= j; k++) drop[k] = 1;
        break;
      }
    }
  }
  const kept = words.filter((_, i) => !drop[i]);
  const keptKeys = kept.map((w) => norm(w.text));
  // Loops: a run of n words immediately repeated → keep the first.
  const out: TimedWord[] = [];
  const outKeys: string[] = [];
  for (let i = 0; i < kept.length; ) {
    let skipped = false;
    for (let n = 5; n >= 1; n--) {
      if (outKeys.length < n || i + n > kept.length) continue;
      const prev = outKeys.slice(-n).join(' ');
      const next = keptKeys.slice(i, i + n).join(' ');
      if (prev === next && (n > 1 || next.length > 2)) {
        i += n;
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    out.push(kept[i] as TimedWord);
    outKeys.push(keptKeys[i] as string);
    i++;
  }
  return out;
}

/** Places words (in a file's source time) onto every clip that shows that moment, in timeline time. */
export function placeWords(words: readonly TimedWord[], clips: readonly SpeechSource[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const c of clips) {
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.inSec || mid >= c.outSec) continue;
      const s = Math.max(w.start, c.inSec);
      const e = Math.min(w.end, c.outSec);
      out.push({ text: w.text, start: c.timelineStart + (s - c.inSec) / c.speed, end: c.timelineStart + (e - c.inSec) / c.speed });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
