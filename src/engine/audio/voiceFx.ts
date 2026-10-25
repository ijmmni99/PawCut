// TikTok-style voice changer. Plain-JS DSP on PCM (works on the main thread and in workers), so preview, export
// and the voiceover mix all use the same code: granular pitch shift (keeps timing), ring modulation, filters,
// drive, delay, reverb and vibrato. Output keeps the input's length and peak level.

export type VoiceFxId =
  | 'chipmunk'
  | 'helium'
  | 'deep'
  | 'monster'
  | 'robot'
  | 'alien'
  | 'echo'
  | 'cave'
  | 'megaphone'
  | 'phone'
  | 'vibrato';

export const VOICE_FX: Array<{ id: VoiceFxId; label: string; icon: string }> = [
  { id: 'chipmunk', label: 'Chipmunk', icon: '🐿️' },
  { id: 'helium', label: 'Helium', icon: '🎈' },
  { id: 'deep', label: 'Deep', icon: '🧔' },
  { id: 'monster', label: 'Monster', icon: '👹' },
  { id: 'robot', label: 'Robot', icon: '🤖' },
  { id: 'alien', label: 'Alien', icon: '👽' },
  { id: 'echo', label: 'Echo', icon: '🔊' },
  { id: 'cave', label: 'Cave', icon: '🕳️' },
  { id: 'megaphone', label: 'Megaphone', icon: '📢' },
  { id: 'phone', label: 'Phone', icon: '📞' },
  { id: 'vibrato', label: 'Vibrato', icon: '〰️' },
];

/**
 * WSOLA time-stretch: Hann frames at a fixed output hop, each taken from near its ideal input position at the offset
 * whose waveform best continues the previous frame (so overlapping frames add in phase, no warble).
 */
export function timeStretch(x: Float32Array, sampleRate: number, factor: number): Float32Array {
  const N = Math.max(64, Math.round(sampleRate * 0.04) & ~1);
  const Ha = N / 2;
  const Hs = Ha / factor;
  const delta = Math.round(sampleRate * 0.012);
  const outLen = Math.ceil(x.length * factor);
  const out = new Float32Array(outLen + N);
  const win = new Float32Array(N);
  for (let k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N);
  const at = (i: number) => (i >= 0 && i < x.length ? (x[i] as number) : 0);
  let prev = 0; // input position of the previous frame
  for (let k = 0; k * Ha < outLen; k++) {
    const ideal = Math.round(k * Hs);
    let pos = ideal;
    if (k > 0) {
      // Match the natural continuation of the previous frame (decimated correlation to keep it fast).
      const target = prev + Ha;
      let best = -Infinity;
      for (let d = -delta; d <= delta; d += 2) {
        const p = ideal + d;
        let c = 0;
        for (let j = 0; j < N; j += 4) c += at(p + j) * at(target + j);
        if (c > best) {
          best = c;
          pos = p;
        }
      }
    }
    const o = k * Ha;
    for (let j = 0; j < N; j++) out[o + j] = (out[o + j] as number) + at(pos + j) * (win[j] as number);
    prev = pos;
  }
  return out.subarray(0, outLen);
}

/** Pitch shift by `semitones` keeping the duration: time-stretch by the ratio, then resample back. */
export function pitchShift(x: Float32Array, sampleRate: number, semitones: number): Float32Array {
  const ratio = 2 ** (semitones / 12);
  const stretched = timeStretch(x, sampleRate, ratio);
  const y = new Float32Array(x.length);
  for (let i = 0; i < y.length; i++) {
    const s = i * ratio;
    const k = Math.floor(s);
    const f = s - k;
    y[i] = ((stretched[k] ?? 0) as number) * (1 - f) + ((stretched[k + 1] ?? 0) as number) * f;
  }
  return y;
}

type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peak';

/** RBJ biquad filter (in place copy). */
export function biquad(x: Float32Array, sampleRate: number, type: BiquadType, freq: number, q = 0.707, gainDb = 0): Float32Array {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const A = 10 ** (gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'lowpass':
      [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'highpass':
      [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    case 'bandpass':
      [b0, b1, b2] = [alpha, 0, -alpha];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
      break;
    default:
      [b0, b1, b2] = [1 + alpha * A, -2 * cos, 1 - alpha * A];
      [a0, a1, a2] = [1 + alpha / A, -2 * cos, 1 - alpha / A];
  }
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    const out = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
}

function ringMod(x: Float32Array, sampleRate: number, freq: number, mix = 1): Float32Array {
  const y = new Float32Array(x.length);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < x.length; i++) y[i] = (x[i] as number) * (1 - mix + mix * Math.sin(w * i));
  return y;
}

function drive(x: Float32Array, amount: number): Float32Array {
  const y = new Float32Array(x.length);
  const k = Math.tanh(amount);
  for (let i = 0; i < x.length; i++) y[i] = Math.tanh((x[i] as number) * amount) / k;
  return y;
}

/** Feedback delay (echo / metallic comb). */
function delay(x: Float32Array, sampleRate: number, sec: number, feedback: number, wet: number): Float32Array {
  const d = Math.max(1, Math.round(sec * sampleRate));
  const line = new Float32Array(x.length);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const delayed = i >= d ? (line[i - d] as number) : 0;
    line[i] = (x[i] as number) + delayed * feedback;
    y[i] = (x[i] as number) + delayed * wet;
  }
  return y;
}

/** Small Schroeder reverb (parallel combs → series all-passes). */
function reverb(x: Float32Array, sampleRate: number, size: number, wet: number): Float32Array {
  const scale = (sampleRate / 44_100) * size;
  const wetSig = new Float32Array(x.length);
  for (const len of [1557, 1617, 1491, 1422, 1277, 1356]) {
    const n = Math.round(len * scale);
    const buf = new Float32Array(n);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < x.length; i++) {
      const out = buf[idx] as number;
      store = out * 0.7 + store * 0.3;
      buf[idx] = (x[i] as number) + store * 0.84;
      wetSig[i] = (wetSig[i] as number) + out / 6;
      if (++idx === n) idx = 0;
    }
  }
  for (const len of [225, 556, 441]) {
    const n = Math.round(len * scale);
    const buf = new Float32Array(n);
    let idx = 0;
    for (let i = 0; i < x.length; i++) {
      const b = buf[idx] as number;
      const v = wetSig[i] as number;
      buf[idx] = v + b * 0.5;
      wetSig[i] = b - v;
      if (++idx === n) idx = 0;
    }
  }
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = (x[i] as number) * (1 - wet * 0.5) + (wetSig[i] as number) * wet;
  return y;
}

/** Pitch wobble via a modulated delay line. */
function vibrato(x: Float32Array, sampleRate: number, rateHz: number, depthSec: number): Float32Array {
  const y = new Float32Array(x.length);
  const base = depthSec * 1.5 * sampleRate;
  const depth = depthSec * sampleRate;
  const w = (2 * Math.PI * rateHz) / sampleRate;
  for (let i = 0; i < x.length; i++) {
    const s = i - (base + depth * Math.sin(w * i));
    if (s < 0) continue;
    const k = Math.floor(s);
    const f = s - k;
    y[i] = (x[k] as number) * (1 - f) + ((x[k + 1] ?? 0) as number) * f;
  }
  return y;
}

function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i] as number));
  return p;
}

/** Processes one mono signal. */
export function voiceFxMono(x: Float32Array, sr: number, fx: VoiceFxId): Float32Array {
  switch (fx) {
    case 'chipmunk':
      return pitchShift(x, sr, 8);
    case 'helium':
      return biquad(pitchShift(x, sr, 5), sr, 'highpass', 250);
    case 'deep':
      return pitchShift(x, sr, -4);
    case 'monster':
      return biquad(drive(pitchShift(x, sr, -8), 2.5), sr, 'lowpass', 3500);
    case 'robot':
      return delay(ringMod(x, sr, 55), sr, 0.008, 0.55, 0.6);
    case 'alien':
      return ringMod(vibrato(pitchShift(x, sr, 4), sr, 9, 0.0012), sr, 380, 0.35);
    case 'echo':
      return delay(x, sr, 0.28, 0.45, 0.55);
    case 'cave':
      return reverb(x, sr, 1.6, 0.8);
    case 'megaphone':
      return drive(biquad(biquad(x, sr, 'highpass', 600, 0.9), sr, 'lowpass', 3200, 0.9), 4);
    case 'phone':
      return biquad(biquad(drive(x, 1.5), sr, 'highpass', 400, 0.7), sr, 'lowpass', 3000, 0.7);
    case 'vibrato':
      return vibrato(x, sr, 6, 0.0025);
  }
}

/** Applies a voice effect to planar audio (mixed to mono — it's a voice — then copied to every channel). */
export function applyVoiceFx(channels: readonly Float32Array[], sampleRate: number, fx: VoiceFxId): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return channels.map((c) => c.slice());
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (ch[i] as number) / channels.length;
  const before = peak(mono);
  const y = voiceFxMono(mono, sampleRate, fx);
  // Keep the original peak level so effects don't jump in volume (or clip).
  const after = peak(y);
  if (after > 0 && before > 0) {
    const k = Math.min(before / after, 4);
    for (let i = 0; i < n; i++) y[i] = (y[i] as number) * k;
  }
  return channels.map(() => y.slice());
}
