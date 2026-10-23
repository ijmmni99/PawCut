import { describe, expect, it } from 'vitest';
import { detectTempo, encodeWav, mixToMono, waveformPeaks } from './analysis';

const SR = 22050;

/** Click track: short decaying noise-ish bursts every 60/bpm seconds starting at `offset`. */
function clicks(bpm: number, seconds: number, offset = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const period = 60 / bpm;
  let seed = 1;
  for (let t = offset; t < seconds; t += period) {
    const start = Math.round(t * SR);
    for (let i = 0; i < 600 && start + i < out.length; i++) {
      seed = (seed * 16807) % 2147483647;
      out[start + i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-i / 120);
    }
  }
  return out;
}

describe('detectTempo', () => {
  for (const bpm of [90, 120, 128, 150]) {
    it(`finds ${bpm} BPM`, () => {
      const { bpm: found } = detectTempo(clicks(bpm, 20), SR);
      expect(found).not.toBeNull();
      expect(Math.abs((found as number) - bpm)).toBeLessThan(2);
    });
  }

  it('places beats on the clicks', () => {
    const { beats } = detectTempo(clicks(120, 20, 0.3), SR);
    // Every detected beat should be within 30 ms of a click at 0.3 + k*0.5.
    for (const b of beats.slice(1, -1)) {
      const k = Math.round((b - 0.3) / 0.5);
      expect(Math.abs(b - (0.3 + k * 0.5))).toBeLessThan(0.03);
    }
  });

  it('returns null for silence', () => {
    expect(detectTempo(new Float32Array(SR * 5), SR).bpm).toBeNull();
  });
});

describe('waveform + wav', () => {
  it('computes peaks per bucket', () => {
    const ch = new Float32Array(100);
    ch[10] = 0.5;
    ch[90] = -1;
    expect(waveformPeaks([ch], 4)).toEqual([0.5, 0, 0, 1]);
    expect(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])).toEqual(new Float32Array([0.5, 0.5]));
  });

  it('writes a valid 16-bit WAV header', () => {
    const wav = encodeWav([new Float32Array([0, 1, -1])], 48000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
  });
});
