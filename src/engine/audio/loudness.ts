// Loudness of a video's own sound over time (dBFS per LOUDNESS_STEP seconds). Music ducks under the loud parts.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import type { Loudness } from '../../editor/timeline/model';

export const LOUDNESS_STEP = 0.1;

const rmsDb = (sumSq: number, n: number) => {
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  return rms > 1e-5 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100;
};

/** Decodes the audio of `file` (audio only, cheap) and measures it. Null when the file has no sound. */
export async function measureLoudness(file: Blob): Promise<Loudness | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const windowLen = Math.round(track.sampleRate * LOUDNESS_STEP);
    const db: number[] = [];
    let sumSq = 0;
    let filled = 0;
    let plane = new Float32Array(0);
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        const n = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        if (plane.length < n) plane = new Float32Array(n);
        const mono = new Float32Array(n);
        for (let c = 0; c < channels; c++) {
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let k = 0; k < n; k++) mono[k] = (mono[k] as number) + (plane[k] as number) / channels;
        }
        for (let k = 0; k < n; k++) {
          sumSq += (mono[k] as number) ** 2;
          if (++filled === windowLen) {
            db.push(rmsDb(sumSq, filled));
            sumSq = 0;
            filled = 0;
          }
        }
      } finally {
        sample.close();
      }
    }
    if (filled > windowLen / 4) db.push(rmsDb(sumSq, filled));
    return { step: LOUDNESS_STEP, db };
  } finally {
    input.dispose();
  }
}
