import { describe, expect, it } from 'vitest';
import { VOICE_FX, applyVoiceFx, pitchShift } from './voiceFx';

const SR = 16_000;

function tone(freq: number, sec = 1): Float32Array {
  const x = new Float32Array(SR * sec);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** Dominant frequency (DFT peak, 50–1000 Hz) of the middle half of the signal. */
function freqOf(x: Float32Array): number {
  const a = Math.floor(x.length * 0.25);
  const n = Math.floor(x.length * 0.5);
  let best = 0;
  let bf = 0;
  for (let f = 50; f <= 1000; f += 2) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = x[a + i] as number;
      re += v * Math.cos((2 * Math.PI * f * i) / SR);
      im += v * Math.sin((2 * Math.PI * f * i) / SR);
    }
    if (re * re + im * im > best) {
      best = re * re + im * im;
      bf = f;
    }
  }
  return bf;
}

describe('voice changer', () => {
  it('shifts pitch without changing length', () => {
    const x = tone(220);
    const up = pitchShift(x, SR, 12);
    const down = pitchShift(x, SR, -12);
    expect(up.length).toBe(x.length);
    expect(Math.abs(freqOf(up) - 440)).toBeLessThanOrEqual(4);
    expect(Math.abs(freqOf(down) - 110)).toBeLessThanOrEqual(4);
    expect(Math.abs(freqOf(pitchShift(x, SR, 8)) - 349)).toBeLessThanOrEqual(4);
  });

  it('is fast enough for a 30 s clip at 48 kHz', () => {
    const x = new Float32Array(48_000 * 30).map((_, i) => Math.sin(i / 20) * 0.3);
    const t0 = performance.now();
    applyVoiceFx([x, x], 48_000, 'chipmunk');
    expect(performance.now() - t0).toBeLessThan(4000);
  });

  it('every effect keeps length and peak level, with no NaNs', () => {
    const x = tone(200, 2);
    for (const { id } of VOICE_FX) {
      const [y] = applyVoiceFx([x, x], SR, id);
      expect(y!.length).toBe(x.length);
      let p = 0;
      let bad = 0;
      for (const v of y!) {
        if (!Number.isFinite(v)) bad++;
        p = Math.max(p, Math.abs(v));
      }
      expect(bad, id).toBe(0);
      expect(p, id).toBeGreaterThan(0.3);
      expect(p, id).toBeLessThan(0.51);
    }
  });
});
