// Turns raw per-bin features into an "interest score" and picks segments. Pure functions, unit-tested.
import { percentile } from './features';

/** Analysis resolution: one bin per 0.25s of source. */
export const BIN_SEC = 0.25;
export const ANALYSIS_VERSION = 1;

/** Raw features for one asset, one value per bin. Stored in IndexedDB so re-opening Auto-Cut is instant. */
export type AssetAnalysis = {
  assetId: string;
  version: number;
  binSec: number;
  durationSec: number;
  hasAudio: boolean;
  detector: 'ok' | 'unavailable';
  motionLocal: number[];
  motionGlobal: number[];
  brightness: number[];
  sharpness: number[];
  /** 0..1: cat/dog/person present and moving. */
  subject: number[];
  audioDb: number[];
  /** Positive energy jumps (meows, toy hits, laughs). */
  onset: number[];
  createdAt: number;
};

export type Scored = {
  binSec: number;
  /** 0..1 interest per bin. */
  score: number[];
  /** Low motion and quiet: removable by "Remove dead air". */
  dead: boolean[];
  /** Quiet relative to the clip's speech level: removable by "Cut silences". */
  silent: boolean[];
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function smooth(values: number[], passes = 2): number[] {
  let cur = values;
  for (let p = 0; p < passes; p++) {
    cur = cur.map((v, i) => 0.25 * (cur[i - 1] ?? v) + 0.5 * v + 0.25 * (cur[i + 1] ?? v));
  }
  return cur;
}

export function scoreAnalysis(a: AssetAnalysis): Scored {
  const n = a.motionLocal.length;
  const motionRef = Math.max(percentile(a.motionLocal, 0.9), 2);
  const sharpMedian = Math.max(percentile(a.sharpness, 0.5), 1e-3);
  const dbFloor = percentile(a.audioDb, 0.2);
  const dbPeak = Math.max(percentile(a.audioDb, 0.95), dbFloor + 6);
  const onsetRef = Math.max(percentile(a.onset, 0.95), 1e-3);
  const speechLevel = percentile(a.audioDb, 0.9);

  const raw: number[] = [];
  const motionN: number[] = [];
  const loudN: number[] = [];
  for (let i = 0; i < n; i++) {
    const local = a.motionLocal[i] ?? 0;
    const global = a.motionGlobal[i] ?? 0;
    // Subtract camera movement so panning doesn't look like action.
    const motion = clamp01(Math.max(0, local - 0.6 * global) / motionRef);
    const shake = clamp01(global / motionRef - 0.3);
    const loud = a.hasAudio ? clamp01(((a.audioDb[i] ?? -100) - dbFloor) / (dbPeak - dbFloor)) : 0;
    const onset = a.hasAudio ? clamp01((a.onset[i] ?? 0) / onsetRef) : 0;
    const dark = clamp01((50 - (a.brightness[i] ?? 128)) / 30);
    const blur = clamp01((0.5 * sharpMedian - (a.sharpness[i] ?? sharpMedian)) / (0.5 * sharpMedian));
    const subject = a.subject[i] ?? 0;
    // Without a detector, motion carries the subject weight.
    const wMotion = a.detector === 'ok' ? 0.4 : 0.65;
    const wSubject = a.detector === 'ok' ? 0.3 : 0;
    const wAudio = a.hasAudio ? 1 : 0;
    raw.push(
      wMotion * motion +
        wSubject * subject +
        wAudio * (0.15 * loud + 0.15 * onset) -
        0.35 * Math.max(dark, blur) -
        0.25 * shake,
    );
    motionN.push(motion);
    loudN.push(loud);
  }
  const smoothed = smooth(raw);
  const top = Math.max(percentile(smoothed, 0.95), 1e-3);
  const score = smoothed.map((v) => clamp01(v / top));
  const motionS = smooth(motionN, 1);
  const dead = score.map((_, i) => (motionS[i] ?? 0) < 0.12 && (loudN[i] ?? 0) < 0.25 && (a.subject[i] ?? 0) < 0.5);
  const silent = a.audioDb.map((db) => db < Math.max(speechLevel - 25, -55));
  return { binSec: a.binSec, score, dead, silent };
}

// ---- segment selection ----

export type Style = 'chill' | 'hype';

/** A clip on the timeline the analysis covers (its own in/out window into the asset). */
export type SourceRange = { assetId: string; inSec: number; outSec: number; scored: Scored };

export type Segment = { source: number; start: number; end: number; score: number };

export const STYLE_LENGTHS: Record<Style, { min: number; max: number }> = {
  chill: { min: 2, max: 4 },
  hype: { min: 0.8, max: 1.8 },
};

const GAP = 0.25;
const MIN_PEAK = 0.3;
const MIN_PROMINENCE = 0.1;
const PEAK_RADIUS = 2;

function binRange(src: SourceRange): [number, number] {
  const b = src.scored.binSec;
  return [Math.floor(src.inSec / b), Math.min(src.scored.score.length, Math.ceil(src.outSec / b))];
}

function overlaps(seg: Segment, taken: readonly Segment[]): boolean {
  return taken.some((t) => t.source === seg.source && seg.start < t.end + GAP && seg.end > t.start - GAP);
}

/** Grows a segment around bin `peak` while the score stays near the peak, within the style's length limits. */
function grow(src: SourceRange, source: number, peak: number, style: Style, taken: readonly Segment[]): Segment | null {
  const { min, max } = STYLE_LENGTHS[style];
  const b = src.scored.binSec;
  const s = src.scored.score;
  const [lo, hi] = binRange(src);
  const blocked = (bin: number) =>
    taken.some((t) => t.source === source && bin * b < t.end + GAP && (bin + 1) * b > t.start - GAP);
  if (blocked(peak)) return null;
  const peakScore = s[peak] ?? 0;
  const floor = peakScore * 0.6;
  let a = peak;
  let z = peak + 1;
  const maxBins = Math.round(max / b);
  const minBins = Math.round(min / b);
  while (z - a < maxBins) {
    const left = a - 1 >= lo && !blocked(a - 1) ? (s[a - 1] ?? 0) : -1;
    const right = z < hi && !blocked(z) ? (s[z] ?? 0) : -1;
    const best = Math.max(left, right);
    if (best < 0 || (best < floor && z - a >= minBins)) break;
    if (right >= left) z++;
    else a--;
  }
  if (z - a < minBins) return null;
  const start = Math.max(src.inSec, a * b);
  const end = Math.min(src.outSec, z * b);
  let sum = 0;
  for (let i = a; i < z; i++) sum += s[i] ?? 0;
  return { source, start, end, score: sum / (z - a) };
}

/** Picks the most interesting moments across all sources, up to ~targetSec, in original order. */
export function pickHighlights(sources: readonly SourceRange[], targetSec: number, style: Style): Segment[] {
  const peaks: Array<{ source: number; bin: number; score: number }> = [];
  sources.forEach((src, source) => {
    const [lo, hi] = binRange(src);
    const s = src.scored.score;
    for (let i = lo; i < hi; i++) {
      const v = s[i] ?? 0;
      if (v < MIN_PEAK) continue;
      // A peak is the local maximum within ±0.5s AND stands out from its surroundings (flat stretches aren't peaks).
      let isMax = true;
      let lowest = v;
      for (let j = Math.max(lo, i - PEAK_RADIUS); j <= Math.min(hi - 1, i + PEAK_RADIUS); j++) {
        if ((s[j] ?? 0) > v) isMax = false;
      }
      for (let j = Math.max(lo, i - 4 * PEAK_RADIUS); j <= Math.min(hi - 1, i + 4 * PEAK_RADIUS); j++) {
        lowest = Math.min(lowest, s[j] ?? 0);
      }
      if (isMax && v - lowest >= MIN_PROMINENCE) peaks.push({ source, bin: i, score: v });
    }
  });
  peaks.sort((x, y) => y.score - x.score);

  const chosen: Segment[] = [];
  let total = 0;
  const addFrom = (list: typeof peaks) => {
    for (const p of list) {
      if (total >= targetSec) break;
      const src = sources[p.source];
      if (!src) continue;
      const seg = grow(src, p.source, p.bin, style, chosen);
      if (!seg || overlaps(seg, chosen)) continue;
      chosen.push(seg);
      total += seg.end - seg.start;
    }
  };
  addFrom(peaks);
  if (total < targetSec) total = extendForContext(sources, chosen, targetSec, style, total);
  if (total < targetSec) {
    // Still short: every bin, best first; ties go to footage nearest the moments already chosen.
    const distance = (source: number, sec: number) =>
      Math.min(Infinity, ...chosen.filter((c) => c.source === source).map((c) => Math.max(c.start - sec, sec - c.end, 0)));
    const all = sources.flatMap((src, source) => {
      const [lo, hi] = binRange(src);
      return Array.from({ length: Math.max(0, hi - lo) }, (_, k) => {
        const bin = lo + k;
        return { source, bin, score: src.scored.score[bin] ?? 0, near: distance(source, bin * src.scored.binSec) };
      });
    });
    addFrom(all.sort((x, y) => y.score - x.score || x.near - y.near));
  }

  // Overshoot: trim the weakest segment's tail, never below the style minimum.
  let excess = total - targetSec;
  const byWeakest = [...chosen].sort((x, y) => x.score - y.score);
  for (const seg of byWeakest) {
    if (excess <= 0.05) break;
    const cut = Math.min(excess, seg.end - seg.start - STYLE_LENGTHS[style].min);
    if (cut > 0) {
      seg.end -= cut;
      excess -= cut;
    }
  }
  return chosen.sort((x, y) => x.source - y.source || x.start - y.start);
}

/**
 * Short of material: give the chosen moments lead-in/lead-out (up to 2× the style's max length) before falling back
 * to unrelated footage, so padding is context around the action rather than random filler.
 */
function extendForContext(
  sources: readonly SourceRange[],
  chosen: Segment[],
  targetSec: number,
  style: Style,
  total: number,
): number {
  // Hype keeps its cuts short: it pads with extra short cuts near the action instead (see pickHighlights).
  const cap = style === 'hype' ? STYLE_LENGTHS.hype.max : STYLE_LENGTHS.chill.max * 2;
  const added = new Map<Segment, { left: number; right: number }>(chosen.map((c) => [c, { left: 0, right: 0 }]));
  let grew = true;
  while (total < targetSec - 1e-6 && grew) {
    grew = false;
    for (const seg of [...chosen].sort((a, b) => b.score - a.score)) {
      if (total >= targetSec - 1e-6) break;
      const src = sources[seg.source];
      const room = cap - (seg.end - seg.start);
      if (!src || room <= 1e-6) continue;
      const b = src.scored.binSec;
      const step = Math.min(b, targetSec - total, room);
      const others = chosen.filter((o) => o !== seg);
      const canLeft = seg.start - step >= src.inSec && !overlaps({ ...seg, start: seg.start - step }, others);
      const canRight = seg.end + step <= src.outSec && !overlaps({ ...seg, end: seg.end + step }, others);
      const scoreAt = (t: number) => src.scored.score[Math.floor(t / b)] ?? 0;
      const pad = added.get(seg) ?? { left: 0, right: 0 };
      // Prefer the more interesting side; on a tie, balance lead-in against lead-out.
      const rightScore = scoreAt(seg.end);
      const leftScore = scoreAt(seg.start - step);
      const goRight = canRight && (!canLeft || rightScore > leftScore || (rightScore === leftScore && pad.right <= pad.left));
      if (goRight) {
        seg.end += step;
        pad.right += step;
      } else if (canLeft) {
        seg.start -= step;
        pad.left += step;
      } else continue;
      added.set(seg, pad);
      total += step;
      grew = true;
    }
  }
  return total;
}

/** Manually adds the best segment around `atSec` of a source (heatmap tap). */
export function segmentAt(
  sources: readonly SourceRange[],
  source: number,
  atSec: number,
  style: Style,
  taken: readonly Segment[],
): Segment | null {
  const src = sources[source];
  if (!src) return null;
  const bin = Math.floor(atSec / src.scored.binSec);
  // Seed from the best bin within ±0.5s so a tap near a peak snaps onto it.
  let best = bin;
  for (let i = bin - 2; i <= bin + 2; i++) if ((src.scored.score[i] ?? -1) > (src.scored.score[best] ?? -1)) best = i;
  const [lo, hi] = binRange(src);
  return grow(src, source, Math.min(Math.max(best, lo), hi - 1), style, taken);
}

/**
 * Keeps everything except runs flagged by `mask` ("dead" air or "silent" pauses), in order.
 * Runs shorter than `minCutSec` are kept; kept pieces get `padSec` of breathing room on each side.
 */
export function keepRegions(
  sources: readonly SourceRange[],
  mask: 'dead' | 'silent',
  minCutSec: number,
  padSec: number,
): Segment[] {
  const out: Segment[] = [];
  sources.forEach((src, source) => {
    const b = src.scored.binSec;
    const flags = src.scored[mask];
    const [lo, hi] = binRange(src);
    const cuts: Array<[number, number]> = [];
    let runStart = -1;
    for (let i = lo; i <= hi; i++) {
      const flagged = i < hi && (flags[i] ?? false);
      if (flagged && runStart < 0) runStart = i;
      if (!flagged && runStart >= 0) {
        if ((i - runStart) * b >= minCutSec) cuts.push([runStart * b + padSec, i * b - padSec]);
        runStart = -1;
      }
    }
    let cursor = src.inSec;
    for (const [a, z] of cuts) {
      const cutStart = Math.max(a, src.inSec);
      const cutEnd = Math.min(z, src.outSec);
      if (cutEnd <= cutStart) continue;
      if (cutStart - cursor >= 0.3) out.push({ source, start: cursor, end: cutStart, score: 1 });
      cursor = cutEnd;
    }
    if (src.outSec - cursor >= 0.3) out.push({ source, start: cursor, end: src.outSec, score: 1 });
  });
  return out;
}

export type ClipSpec = { assetId: string; inSec: number; outSec: number; speed: number };

/**
 * Converts segments into timeline clips. Hype turns the strongest segments into a stepped speed ramp:
 * fast run-in, slow-motion on the peak, fast run-out.
 */
export function segmentsToClips(sources: readonly SourceRange[], segments: readonly Segment[], style: Style): ClipSpec[] {
  const rampIds = new Set(
    style === 'hype'
      ? [...segments]
          .filter((s) => s.end - s.start >= 1.2)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2)
      : [],
  );
  const clips: ClipSpec[] = [];
  for (const seg of segments) {
    const src = sources[seg.source];
    if (!src) continue;
    if (!rampIds.has(seg)) {
      clips.push({ assetId: src.assetId, inSec: seg.start, outSec: seg.end, speed: 1 });
      continue;
    }
    const s = src.scored.score;
    const b = src.scored.binSec;
    let peak = Math.floor(seg.start / b);
    for (let i = peak; i < Math.ceil(seg.end / b); i++) if ((s[i] ?? 0) > (s[peak] ?? 0)) peak = i;
    const mid = Math.min(Math.max((peak + 0.5) * b, seg.start + 0.5), seg.end - 0.5);
    const slowA = Math.max(seg.start, mid - 0.3);
    const slowZ = Math.min(seg.end, mid + 0.3);
    if (slowA - seg.start > 0.1) clips.push({ assetId: src.assetId, inSec: seg.start, outSec: slowA, speed: 1.5 });
    clips.push({ assetId: src.assetId, inSec: slowA, outSec: slowZ, speed: 0.5 });
    if (seg.end - slowZ > 0.1) clips.push({ assetId: src.assetId, inSec: slowZ, outSec: seg.end, speed: 1.5 });
  }
  return clips;
}

export const clipsDuration = (clips: readonly ClipSpec[]) =>
  clips.reduce((sum, c) => sum + (c.outSec - c.inSec) / c.speed, 0);
