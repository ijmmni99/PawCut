// Audio tracks (music, sound effects, voiceover): pure operations on Project.audio, plus the timing helpers shared by
// the preview mixer and export (ducking envelope, fades, beat snapping). No Web Audio here — unit-testable.
import {
  type AudioClip,
  type AudioTrackKind,
  type Clip,
  DEFAULT_MIX,
  type Loudness,
  type MixSettings,
  type Project,
  clipDuration,
  clipStarts,
  newId,
  projectDuration,
} from './model';

export const AUDIO_TRACKS: AudioTrackKind[] = ['music', 'sfx', 'voice'];
/** Shortest audio clip, seconds. */
export const MIN_AUDIO_SEC = 0.1;
/** Fade-out given to music that's fitted to the video. */
export const MUSIC_FADE_OUT = 2;

export const audioClips = (p: Project): AudioClip[] => p.audio ?? [];
export const mixOf = (p: Project): MixSettings => ({ ...DEFAULT_MIX, ...p.mix });
export const audioDuration = (c: AudioClip) => c.outSec - c.inSec;
export const audioEnd = (c: AudioClip) => c.start + audioDuration(c);

function withAudio(p: Project, audio: AudioClip[]): Project {
  return { ...p, audio };
}

export function addAudioClip(p: Project, clip: AudioClip): Project {
  return withAudio(p, [...audioClips(p), clip]);
}

export function updateAudioClip(p: Project, id: string, patch: Partial<Omit<AudioClip, 'id'>>): Project {
  return withAudio(
    p,
    audioClips(p).map((c) => (c.id === id ? { ...c, ...patch } : c)),
  );
}

export function moveAudioClip(p: Project, id: string, start: number): Project {
  return updateAudioClip(p, id, { start: Math.max(0, start) });
}

/**
 * Moves one edge of an audio clip to timeline time `t`. The opposite edge stays put on the timeline.
 * Clamped to the source bounds [0, sourceDuration] and the minimum length.
 */
export function trimAudioClip(p: Project, id: string, edge: 'in' | 'out', t: number, sourceDuration: number): Project {
  const clip = audioClips(p).find((c) => c.id === id);
  if (!clip) return p;
  if (edge === 'out') {
    const outSec = Math.min(Math.max(clip.inSec + (t - clip.start), clip.inSec + MIN_AUDIO_SEC), sourceDuration);
    return updateAudioClip(p, id, { outSec });
  }
  // Moving the in-edge shifts both the source in-point and the timeline start by the same amount.
  const delta = Math.min(Math.max(t - clip.start, -clip.inSec, -clip.start), audioDuration(clip) - MIN_AUDIO_SEC);
  return updateAudioClip(p, id, { start: clip.start + delta, inSec: clip.inSec + delta });
}

export function setMix(p: Project, patch: Partial<MixSettings>): Project {
  return { ...p, mix: { ...mixOf(p), ...patch } };
}

/** A music clip placed at 0, cut to the video's length (from `inSec`) with a fade-out. */
export function fittedMusicClip(
  sourceId: string,
  sourceDuration: number,
  videoDuration: number,
  inSec = 0,
  makeId: () => string = newId,
): AudioClip {
  const length = videoDuration > 0 ? Math.min(videoDuration, sourceDuration - inSec) : sourceDuration - inSec;
  return {
    id: makeId(),
    track: 'music',
    sourceId,
    start: 0,
    inSec,
    outSec: inSec + Math.max(MIN_AUDIO_SEC, length),
    volume: 1,
    fadeIn: 0,
    fadeOut: Math.min(MUSIC_FADE_OUT, length / 3),
  };
}

/** Re-fits every music clip that starts at 0 to the current video length (keeps start offset and fades). */
export function refitMusic(p: Project, sourceDurations: Record<string, number>): Project {
  const total = projectDuration(p);
  return withAudio(
    p,
    audioClips(p).map((c) => {
      if (c.track !== 'music' || c.start !== 0) return c;
      const max = sourceDurations[c.sourceId] ?? c.outSec;
      const outSec = Math.min(max, c.inSec + Math.max(MIN_AUDIO_SEC, total));
      return { ...c, outSec, fadeOut: Math.min(c.fadeOut, (outSec - c.inSec) / 3) };
    }),
  );
}

/** Gain of a clip (volume × fades) at clip-local time `local` seconds. */
export function clipGainAt(c: AudioClip, local: number): number {
  const d = audioDuration(c);
  let g = c.volume;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && local > d - c.fadeOut) g *= Math.max(0, (d - local) / c.fadeOut);
  return g;
}

// ---- ducking ----

/** Resolution of the ducking envelope, seconds. */
export const DUCK_STEP = 0.1;
const DUCK_ATTACK = 0.15;
const DUCK_RELEASE = 0.5;
/** Video sound louder than this (dBFS, after clip volume) counts as "someone talking". */
const LOUD_DB = -30;


/**
 * Music gain multiplier per DUCK_STEP of timeline time: 1 normally, dropping to duckDb while a voiceover plays or
 * the video's own sound is loud. Attack/release ramps keep it from pumping. Used by both preview and export.
 */
export function duckEnvelope(p: Project, loudness: Record<string, Loudness | undefined>): Float32Array {
  const total = Math.max(projectDuration(p), ...audioClips(p).map(audioEnd), 0);
  const n = Math.ceil(total / DUCK_STEP) + 1;
  const env = new Float32Array(n).fill(1);
  const mix = mixOf(p);
  if (!mix.duck) return env;
  const active = new Uint8Array(n);
  for (const c of audioClips(p)) {
    if (c.track !== 'voice') continue;
    for (let i = Math.floor(c.start / DUCK_STEP); i < Math.min(n, Math.ceil(audioEnd(c) / DUCK_STEP)); i++) active[i] = 1;
  }
  const starts = clipStarts(p);
  p.main.forEach((clip: Clip, k) => {
    const loud = loudness[clip.assetId];
    const vol = clip.volume ?? 1;
    if (!loud || vol <= 0) return;
    const start = starts[k] ?? 0;
    const volDb = 20 * Math.log10(vol);
    for (let i = Math.floor(start / DUCK_STEP); i < Math.min(n, Math.ceil((start + clipDuration(clip)) / DUCK_STEP)); i++) {
      const src = clip.inSec + (i * DUCK_STEP - start) * clip.speed;
      const db = loud.db[Math.floor(src / loud.step)];
      if (db !== undefined && db + volDb > LOUD_DB) active[i] = 1;
    }
  });
  const low = 10 ** (mix.duckDb / 20);
  const down = (1 - low) * (DUCK_STEP / DUCK_ATTACK);
  const up = (1 - low) * (DUCK_STEP / DUCK_RELEASE);
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = active[i] ? Math.max(low, g - down) : Math.min(1, g + up);
    env[i] = g;
  }
  return env;
}

export function envelopeAt(env: Float32Array, t: number): number {
  const x = t / DUCK_STEP;
  const i = Math.floor(x);
  const a = env[Math.max(0, Math.min(env.length - 1, i))] ?? 1;
  const b = env[Math.max(0, Math.min(env.length - 1, i + 1))] ?? 1;
  return a + (b - a) * (x - i);
}

// ---- beats ----

/** Timeline times of every beat of every music clip (sorted). `beatsOf` gives a source's beat times. */
export function timelineBeats(p: Project, beatsOf: (sourceId: string) => readonly number[] | undefined): number[] {
  const out: number[] = [];
  for (const c of audioClips(p)) {
    if (c.track !== 'music') continue;
    for (const b of beatsOf(c.sourceId) ?? []) {
      if (b >= c.inSec && b <= c.outSec) out.push(c.start + (b - c.inSec));
    }
  }
  return out.sort((a, b) => a - b);
}

/** Nearest value in sorted `points` within `tolerance` of `t`, else null. */
export function nearest(points: readonly number[], t: number, tolerance: number): number | null {
  let best: number | null = null;
  for (const x of points) {
    if (Math.abs(x - t) <= tolerance && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x;
  }
  return best;
}

type CutClip = { inSec: number; outSec: number; speed: number };

/**
 * Nudges each cut so it lands on a beat: clip i's out-point moves so the cumulative cut time hits the nearest beat
 * (within half a beat), keeping every clip ≥ minSec and inside its source (`maxOut`). The last cut is left alone.
 */
export function snapCutsToBeats<T extends CutClip>(
  clips: readonly T[],
  beats: readonly number[],
  maxOut: (clip: T) => number,
  minSec = 0.3,
): T[] {
  if (beats.length < 2) return [...clips];
  const interval = ((beats[beats.length - 1] as number) - (beats[0] as number)) / (beats.length - 1);
  const out: T[] = [];
  let t = 0;
  clips.forEach((clip, i) => {
    let c = clip;
    const end = t + (c.outSec - c.inSec) / c.speed;
    if (i < clips.length - 1) {
      const target = nearest(beats, end, interval / 2);
      if (target !== null && target - t >= minSec) {
        const outSec = Math.min(c.inSec + (target - t) * c.speed, maxOut(c));
        if ((outSec - c.inSec) / c.speed >= minSec) c = { ...c, outSec };
      }
    }
    out.push(c);
    t += (c.outSec - c.inSec) / c.speed;
  });
  return out;
}
