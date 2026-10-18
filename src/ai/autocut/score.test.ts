import { describe, expect, it } from 'vitest';
import { boxMovement, gridMotion, laplacianVariance, percentile, rmsDb } from './features';
import {
  type AssetAnalysis,
  type Scored,
  type SourceRange,
  BIN_SEC,
  clipsDuration,
  keepRegions,
  pickHighlights,
  scoreAnalysis,
  segmentAt,
  segmentsToClips,
} from './score';

function scored(score: number[], extra: Partial<Scored> = {}): Scored {
  return { binSec: BIN_SEC, score, dead: score.map(() => false), silent: score.map(() => false), ...extra };
}

function source(score: number[], extra: Partial<Scored> = {}): SourceRange {
  return { assetId: 'a', inSec: 0, outSec: score.length * BIN_SEC, scored: scored(score, extra) };
}

/** 60s of low interest with two bursts of action. */
function boringWithBursts(): number[] {
  const s = Array.from({ length: 240 }, () => 0.1);
  for (let i = 40; i < 52; i++) s[i] = 0.9; // 10–13s
  for (let i = 160; i < 168; i++) s[i] = 0.7; // 40–42s
  return s;
}

describe('features', () => {
  it('measures local vs camera motion', () => {
    const w = 8;
    const h = 12;
    const a = new Float32Array(w * h);
    const b = new Float32Array(w * h);
    b[0] = 255; // one corner changes
    const m = gridMotion(a, b, w, h);
    expect(m.local).toBeGreaterThan(0);
    expect(m.global).toBe(0);
    const all = new Float32Array(w * h).fill(50);
    expect(gridMotion(a, all, w, h).global).toBe(50);
  });

  it('detects blur, loudness and subject movement', () => {
    const flat = new Float32Array(100).fill(10);
    const checker = Float32Array.from({ length: 100 }, (_, i) => ((i + Math.floor(i / 10)) % 2) * 255);
    expect(laplacianVariance(checker, 10, 10)).toBeGreaterThan(laplacianVariance(flat, 10, 10));
    expect(rmsDb(new Float32Array(10).fill(1))).toBeCloseTo(0);
    expect(rmsDb(new Float32Array(10))).toBe(-100);
    expect(boxMovement({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 })).toBe(0);
    expect(boxMovement({ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 })).toBeCloseTo(1);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
  });
});

describe('scoreAnalysis', () => {
  it('scores action high, dark/still footage low, and flags dead air', () => {
    const n = 40;
    const a: AssetAnalysis = {
      assetId: 'a',
      version: 1,
      binSec: BIN_SEC,
      durationSec: n * BIN_SEC,
      hasAudio: true,
      detector: 'ok',
      motionLocal: Array.from({ length: n }, (_, i) => (i >= 20 && i < 30 ? 40 : 1)),
      motionGlobal: Array.from({ length: n }, () => 0.5),
      brightness: Array.from({ length: n }, (_, i) => (i < 5 ? 10 : 120)),
      sharpness: Array.from({ length: n }, () => 100),
      subject: Array.from({ length: n }, (_, i) => (i >= 20 && i < 30 ? 0.9 : 0)),
      audioDb: Array.from({ length: n }, (_, i) => (i >= 20 && i < 30 ? -12 : -60)),
      onset: Array.from({ length: n }, () => 0),
      createdAt: 0,
    };
    const s = scoreAnalysis(a);
    expect(s.score[25]).toBeGreaterThan(0.8);
    expect(s.score[2]).toBeLessThan(0.1);
    expect(s.dead[10]).toBe(true);
    expect(s.dead[25]).toBe(false);
    expect(s.silent[10]).toBe(true);
    expect(s.silent[25]).toBe(false);
  });
});

describe('pickHighlights', () => {
  it('lands on the action, respects target length and keeps order', () => {
    // 5s of action exists (10–13s and 40–42s): a 5s target should take exactly those.
    const segs = pickHighlights([source(boringWithBursts())], 5, 'chill');
    const total = segs.reduce((t, s) => t + s.end - s.start, 0);
    expect(total).toBeCloseTo(5, 1);
    expect(segs).toHaveLength(2);
    expect(segs[0]?.start).toBeGreaterThanOrEqual(9.5);
    expect(segs[0]?.end).toBeLessThanOrEqual(13.5);
    expect(segs[1]?.start).toBeGreaterThanOrEqual(39.5);
    expect(segs[1]?.end).toBeLessThanOrEqual(42.5);
    // A longer target pads with the next best material and still stays near the target.
    const padded = pickHighlights([source(boringWithBursts())], 8, 'chill');
    expect(padded.reduce((t, s) => t + s.end - s.start, 0)).toBeLessThanOrEqual(8.05);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBeGreaterThan(segs[i - 1]!.start);
  });

  it('uses short cuts for hype and never overlaps', () => {
    const segs = pickHighlights([source(boringWithBursts())], 15, 'hype');
    for (const s of segs) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(0.79);
      expect(s.end - s.start).toBeLessThanOrEqual(1.81);
    }
    const sorted = [...segs].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    expect(segs.reduce((t, s) => t + s.end - s.start, 0)).toBeGreaterThan(14);
  });

  it('only picks inside each clip window', () => {
    const src = { ...source(boringWithBursts()), inSec: 20, outSec: 50 };
    for (const s of pickHighlights([src], 10, 'chill')) {
      expect(s.start).toBeGreaterThanOrEqual(20);
      expect(s.end).toBeLessThanOrEqual(50);
    }
  });

  it('adds a manual segment around a tap', () => {
    const seg = segmentAt([source(boringWithBursts())], 0, 11, 'chill', []);
    expect(seg && seg.start <= 11 && seg.end >= 11).toBe(true);
  });
});

describe('keepRegions', () => {
  it('cuts long dead runs and keeps short ones, in order', () => {
    const dead = Array.from({ length: 40 }, (_, i) => (i >= 8 && i < 24) || i === 30);
    const segs = keepRegions([source(Array(40).fill(0.5), { dead })], 'dead', 1, 0.1);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 2.1],
      [5.9, 10],
    ]);
  });
});

describe('segmentsToClips', () => {
  it('turns the best hype segments into a fast-slow-fast ramp', () => {
    const src = source(boringWithBursts());
    const clips = segmentsToClips([src], [{ source: 0, start: 10, end: 11.8, score: 0.9 }], 'hype');
    expect(clips.map((c) => c.speed)).toEqual([1.5, 0.5, 1.5]);
    expect(clips[0]?.inSec).toBe(10);
    expect(clips[2]?.outSec).toBe(11.8);
    expect(clipsDuration(clips)).toBeGreaterThan(1.8);
    expect(segmentsToClips([src], [{ source: 0, start: 10, end: 11.8, score: 0.9 }], 'chill')[0]?.speed).toBe(1);
  });
});
