// Compresses rendered audio to AAC in an .m4a (≈1 MB per minute) when the device has an AAC encoder (iPhone does).
import { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output, Quality, canEncodeAudio } from 'mediabunny';
import { encodeWav } from './analysis';

export async function encodeCompressed(channels: Float32Array[], sampleRate: number): Promise<{ blob: Blob; ext: string }> {
  const numberOfChannels = channels.length;
  if (await canEncodeAudio('aac', { sampleRate, numberOfChannels }).catch(() => false)) {
    try {
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat(), target });
      const source = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 160_000 }) });
      output.addAudioTrack(source);
      await output.start();
      const frames = channels[0]?.length ?? 0;
      for (let off = 0; off < frames; off += sampleRate) {
        const n = Math.min(sampleRate, frames - off);
        const data = new Float32Array(n * numberOfChannels);
        channels.forEach((ch, c) => data.set(ch.subarray(off, off + n), c * n));
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels, sampleRate, timestamp: off / sampleRate });
        await source.add(sample);
        sample.close();
      }
      source.close();
      await output.finalize();
      if (target.buffer) return { blob: new Blob([target.buffer], { type: 'audio/mp4' }), ext: 'm4a' };
    } catch (err) {
      console.warn('AAC encode failed, storing WAV', err);
    }
  }
  return { blob: new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' }), ext: 'wav' };
}
