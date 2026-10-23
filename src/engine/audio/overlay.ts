// Schedules the audio tracks (music / SFX / voiceover) into any Web Audio context. The same function drives live
// preview (AudioContext) and export (OfflineAudioContext), so what you hear is exactly what gets rendered.
import { DUCK_STEP, audioClips, audioEnd, clipGainAt, envelopeAt } from '../../editor/timeline/audio';
import type { Project } from '../../editor/timeline/model';

/** Gain automation resolution, seconds. */
const CURVE_STEP = 0.05;

export type OverlayInputs = {
  project: Project;
  /** Decoded audio per library item id; clips whose audio isn't loaded yet are skipped. */
  buffers: ReadonlyMap<string, AudioBuffer>;
  /** Music gain multiplier per DUCK_STEP of timeline time (see duckEnvelope). */
  duck: Float32Array;
};

/**
 * Schedules every audio clip that is still to play after timeline time `from`, with timeline time `from` landing
 * on context time `ctxStart`. `until` (timeline seconds) cuts everything off at the end of the video.
 * Returns the source nodes so playback can stop them.
 */
export function scheduleOverlay(
  ctx: BaseAudioContext,
  destination: AudioNode,
  { project, buffers, duck }: OverlayInputs,
  from: number,
  ctxStart: number,
  until: number,
): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = [];
  for (const clip of audioClips(project)) {
    const buffer = buffers.get(clip.sourceId);
    const begin = Math.max(from, clip.start);
    const end = Math.min(audioEnd(clip), until);
    if (!buffer || end - begin < 0.01) continue;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    // One curve carries volume, fades and (for music) ducking.
    const steps = Math.max(2, Math.ceil((end - begin) / CURVE_STEP) + 1);
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const t = Math.min(end, begin + i * CURVE_STEP);
      const g = clipGainAt(clip, t - clip.start);
      curve[i] = clip.track === 'music' ? g * envelopeAt(duck, t) : g;
    }
    const when = ctxStart + (begin - from);
    // A curve may not overlap other automation events, so the starting value is set directly.
    gain.gain.value = curve[0] ?? 0;
    gain.gain.setValueCurveAtTime(curve, when, end - begin);
    src.connect(gain).connect(destination);
    src.start(when, clip.inSec + (begin - clip.start), end - begin);
    nodes.push(src);
  }
  return nodes;
}

/** Renders the audio tracks for the whole timeline (export): 48 kHz stereo planar. */
export async function renderOverlay(inputs: OverlayInputs, durationSec: number, sampleRate = 48_000): Promise<Float32Array[]> {
  const length = Math.max(1, Math.ceil(durationSec * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  scheduleOverlay(ctx, ctx.destination, inputs, 0, 0, durationSec);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

export { DUCK_STEP };
