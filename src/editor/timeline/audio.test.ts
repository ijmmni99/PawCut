import { describe, expect, it } from 'vitest';
import {
  addAudioClip,
  audioClips,
  clipGainAt,
  duckEnvelope,
  envelopeAt,
  fittedMusicClip,
  moveAudioClip,
  refitMusic,
  setMix,
  snapCutsToBeats,
  timelineBeats,
  trimAudioClip,
} from './audio';
import { type AudioClip, type Project, createProject, removeClips } from './model';

function project(...durations: number[]): Project {
  const p = createProject('t', 0);
  p.main = durations.map((d, i) => ({ id: `v${i}`, assetId: `a${i}`, inSec: 0, outSec: d, speed: 1 }));
  return p;
}

const voice = (start: number, len: number): AudioClip => ({
  id: `vo${start}`,
  track: 'voice',
  sourceId: 'rec',
  start,
  inSec: 0,
  outSec: len,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
});

describe('audio clips', () => {
  it('fits music to the video with a fade-out', () => {
    const c = fittedMusicClip('song', 180, 30, 10, () => 'm');
    expect(c).toMatchObject({ track: 'music', start: 0, inSec: 10, outSec: 40, fadeOut: 2 });
    // Short song: uses what there is.
    expect(fittedMusicClip('s', 12, 30).outSec).toBe(12);
  });

  it('moves, trims and clamps', () => {
    let p = addAudioClip(project(10), { ...voice(2, 4), id: 'x' });
    p = moveAudioClip(p, 'x', -5);
    expect(audioClips(p)[0]?.start).toBe(0);
    p = moveAudioClip(p, 'x', 3);
    p = trimAudioClip(p, 'x', 'out', 5, 4); // wants 2s long, ok
    expect(audioClips(p)[0]).toMatchObject({ start: 3, outSec: 2 });
    p = trimAudioClip(p, 'x', 'out', 99, 4); // clamp to source
    expect(audioClips(p)[0]?.outSec).toBe(4);
    p = trimAudioClip(p, 'x', 'in', 4, 4); // move in-edge right by 1s: start & inSec both +1
    expect(audioClips(p)[0]).toMatchObject({ start: 4, inSec: 1, outSec: 4 });
    p = trimAudioClip(p, 'x', 'in', 0, 4); // can't go before source start
    expect(audioClips(p)[0]).toMatchObject({ start: 3, inSec: 0 });
  });

  it('refits music when the video length changes and deletes with clips', () => {
    let p = addAudioClip(project(10, 10), fittedMusicClip('song', 100, 20, 5, () => 'm'));
    p = { ...p, main: p.main.slice(0, 1) };
    p = refitMusic(p, { song: 100 });
    expect(audioClips(p)[0]).toMatchObject({ inSec: 5, outSec: 15 });
    expect(audioClips(removeClips(p, new Set(['m'])))).toHaveLength(0);
  });

  it('applies volume and fades', () => {
    const c = { ...voice(0, 10), volume: 0.5, fadeIn: 2, fadeOut: 4 };
    expect(clipGainAt(c, 1)).toBeCloseTo(0.25);
    expect(clipGainAt(c, 5)).toBeCloseTo(0.5);
    expect(clipGainAt(c, 9)).toBeCloseTo(0.125);
  });
});

describe('ducking', () => {
  it('ducks under voiceover with ramps, and not when disabled', () => {
    const p = addAudioClip(project(10), voice(3, 2));
    const env = duckEnvelope(p, {});
    expect(envelopeAt(env, 1)).toBe(1);
    expect(envelopeAt(env, 4.5)).toBeCloseTo(10 ** (-12 / 20), 2);
    expect(envelopeAt(env, 5.1)).toBeLessThan(1); // releasing
    expect(envelopeAt(env, 7)).toBe(1);
    expect(duckEnvelope(setMix(p, { duck: false }), {}).every((g) => g === 1)).toBe(true);
  });

  it('ducks under loud video sound, honouring clip volume', () => {
    const p = project(4);
    const loud = { a0: { step: 0.5, db: [-60, -60, -10, -10, -60, -60, -60, -60] } };
    expect(envelopeAt(duckEnvelope(p, loud), 1.4)).toBeLessThan(0.5);
    const muted = { ...p, main: p.main.map((c) => ({ ...c, volume: 0 })) };
    expect(envelopeAt(duckEnvelope(muted, loud), 1.4)).toBe(1);
  });
});

describe('beats', () => {
  it('maps source beats onto the timeline', () => {
    const p = addAudioClip(project(10), { ...fittedMusicClip('song', 60, 10, 4, () => 'm'), start: 1 });
    const beats = timelineBeats(p, () => [3.5, 4, 4.5, 5]);
    expect(beats).toEqual([1, 1.5, 2]);
  });

  it('snaps cuts onto beats within half a beat', () => {
    const clips = [
      { inSec: 0, outSec: 1.9, speed: 1 },
      { inSec: 10, outSec: 11.2, speed: 1 },
      { inSec: 20, outSec: 22, speed: 1 },
    ];
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
    const snapped = snapCutsToBeats(clips, beats, () => 999);
    expect(snapped[0]?.outSec).toBeCloseTo(2);
    // Second cut: 2 + 1.2 = 3.2 → 3.0
    expect(snapped[0]!.outSec - snapped[0]!.inSec + snapped[1]!.outSec - snapped[1]!.inSec).toBeCloseTo(3);
    expect(snapped[2]).toEqual(clips[2]);
  });
});
