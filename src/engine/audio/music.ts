// Built-in music, composed by PawCut: a tiny sequencer + synth voices (drums, bass, keys, pads, plucks, bells, lead)
// rendered with plain-JS DSP (oscillators, state-variable filters, envelopes, a Freeverb-style reverb) straight into
// sample buffers — ~100× faster than thousands of Web Audio nodes, and runs anywhere (tests render it in Node).
// No samples, so no licensing — every track is free to use anywhere. Tempo is fixed per song, so the beat grid is exact.

export const MUSIC_SAMPLE_RATE = 44_100;
/** Bump when songs or voices change so stored renders are regenerated. */
export const MUSIC_VERSION = 1;

/** Reverb / release tail after the last bar, seconds. */
const TAIL_SEC = 2.5;

export type Song = {
  id: string;
  title: string;
  bpm: number;
  bars: number;
  mood: string;
  tags: string[];
  compose(s: Studio): void;
};

/** [beat within bar, midi note, length in beats] */
type Note = [number, number, number];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Deterministic random (same song every render). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ---- DSP voice ----

type Wave = 'sine' | 'tri' | 'saw' | 'square' | 'noise';

type Osc = {
  wave: Wave;
  amp: number;
  /** Frequency multiplier (partials). */
  ratio?: number;
  detune?: number;
  /** This oscillator fades to −60 dB over `decay` seconds (bell partials, key "tine"). */
  decay?: number;
};

type Env = {
  /** Linear attack, seconds. */
  a: number;
  /** Exponential decay to `s` (−60 dB time), seconds. */
  d: number;
  /** Sustain level, 0..1. */
  s: number;
  /** Note length before release, seconds (0 = percussive, ends after decay). */
  hold?: number;
  /** Linear release, seconds. */
  r?: number;
};

type Filter = { type: 'lp' | 'hp' | 'bp'; from: number; to?: number; sweep?: number; q?: number };

type Voice = {
  /** Start, seconds. */
  t: number;
  freq: number;
  /** Exponential pitch glide to `freqEnd` over `glide` seconds. */
  freqEnd?: number;
  glide?: number;
  oscs: Osc[];
  env: Env;
  filter?: Filter;
  level: number;
  pan?: number;
  send?: number;
  /** Route to the pumped (sidechained) bus. */
  pump?: boolean;
};

const LN1000 = Math.log(1000);
/** Mixdown loudness target (≈ −15 dBFS RMS) and the most the peaks may be driven into saturation. */
const TARGET_RMS = 0.18;
const MAX_DRIVE = 2.2;

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Freeverb-style reverb: parallel damped combs into series all-passes, one set per channel. */
function reverb(input: Float32Array, sr: number, seedOffset: number): Float32Array {
  const scale = sr / 44_100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((n) => Math.round((n + seedOffset) * scale));
  const allpasses = [556, 441, 341].map((n) => Math.round((n + seedOffset) * scale));
  const out = new Float32Array(input.length);
  const feedback = 0.8;
  const damp = 0.3;
  for (const len of combs) {
    const buf = new Float32Array(len);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < input.length; i++) {
      const y = buf[idx] as number;
      store = y * (1 - damp) + store * damp;
      buf[idx] = (input[i] as number) + store * feedback;
      out[i] = (out[i] as number) + y;
      if (++idx === len) idx = 0;
    }
  }
  for (const len of allpasses) {
    const buf = new Float32Array(len);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const b = buf[idx] as number;
      const x = out[i] as number;
      buf[idx] = x + b * 0.5;
      out[i] = b - x;
      if (++idx === len) idx = 0;
    }
  }
  return out;
}

export class Studio {
  readonly sr: number;
  readonly bpm: number;
  private readonly L: Float32Array;
  private readonly R: Float32Array;
  private readonly pumpL: Float32Array;
  private readonly pumpR: Float32Array;
  private readonly rev: Float32Array;
  private readonly pumps: Array<[number, number, number]> = [];
  private readonly rand = rng(7);
  private noiseState = 0x12345678;

  constructor(frames: number, sampleRate: number, bpm: number) {
    this.sr = sampleRate;
    this.bpm = bpm;
    this.L = new Float32Array(frames);
    this.R = new Float32Array(frames);
    this.pumpL = new Float32Array(frames);
    this.pumpR = new Float32Array(frames);
    this.rev = new Float32Array(frames);
  }

  /** Seconds at beat `b` (quarter notes from the start). */
  t(b: number): number {
    return (b * 60) / this.bpm;
  }

  private noise(): number {
    // xorshift32
    let x = this.noiseState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noiseState = x >>> 0;
    return (this.noiseState / 0x8000_0000) - 1;
  }

  /** Renders one note into the buffers. */
  private voice(v: Voice): void {
    const { sr } = this;
    const env = v.env;
    const hold = env.hold ?? 0;
    const release = env.r ?? 0.01;
    const percussive = hold <= 0 && env.s <= 0;
    const length = percussive ? env.a + env.d : Math.max(env.a, hold) + release;
    const i0 = Math.max(0, Math.round(v.t * sr));
    const i1 = Math.min(this.L.length, i0 + Math.ceil(length * sr));
    if (i1 <= i0) return;

    const pan = v.pan ?? 0;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * v.level;
    const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * v.level;
    const send = v.send ?? 0;
    const outL = v.pump ? this.pumpL : this.L;
    const outR = v.pump ? this.pumpR : this.R;

    const oscs = v.oscs.map((o) => ({
      ...o,
      phase: this.rand(),
      mult: (o.ratio ?? 1) * 2 ** ((o.detune ?? 0) / 1200),
      gain: o.amp,
      fade: o.decay ? Math.exp(-LN1000 / (o.decay * sr)) : 1,
    }));
    const glideK =
      v.freqEnd && v.glide ? Math.exp(Math.log(v.freqEnd / v.freq) / (v.glide * sr)) : 1;
    const glideEnd = v.glide ? Math.round(v.glide * sr) : 0;
    let freq = v.freq;

    // Envelope.
    const aN = Math.max(1, Math.round(env.a * sr));
    const decayK = Math.exp(-LN1000 / (Math.max(env.d, 0.001) * sr));
    const holdN = Math.round(hold * sr);
    const relN = Math.max(1, Math.round(release * sr));
    const relStart = Math.max(holdN, aN);
    let decayX = 1;
    let level = 0;

    // State-variable filter (TPT), coefficients refreshed every 16 samples while sweeping.
    const f = v.filter;
    let ic1 = 0;
    let ic2 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    const k = f ? 1 / (f.q ?? 0.707) : 0;
    const sweepN = f?.to && f.sweep ? Math.round(f.sweep * sr) : 0;
    const fK = f?.to && f.sweep ? Math.exp(Math.log(f.to / f.from) / (f.sweep * sr)) : 1;
    let fc = f?.from ?? 0;
    const setCoeffs = () => {
      const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    };
    if (f) setCoeffs();

    for (let i = i0, n = 0; i < i1; i++, n++) {
      // Oscillators.
      let x = 0;
      for (const o of oscs) {
        let s: number;
        if (o.wave === 'noise') s = this.noise();
        else {
          const dt = (freq * o.mult) / sr;
          o.phase += dt;
          if (o.phase >= 1) o.phase -= 1;
          const p = o.phase;
          switch (o.wave) {
            case 'sine':
              s = Math.sin(2 * Math.PI * p);
              break;
            case 'tri':
              s = 1 - 4 * Math.abs(p - 0.5);
              break;
            case 'saw':
              s = 2 * p - 1 - polyBlep(p, dt);
              break;
            default: {
              s = (p < 0.5 ? 1 : -1) + polyBlep(p, dt) - polyBlep((p + 0.5) % 1, dt);
            }
          }
        }
        x += s * o.gain;
        o.gain *= o.fade;
      }
      if (n < glideEnd) freq *= glideK;

      // Filter.
      if (f) {
        if (n < sweepN && (n & 15) === 0) {
          fc = f.from * fK ** n;
          setCoeffs();
        }
        const v3 = x - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        x = f.type === 'lp' ? v2 : f.type === 'bp' ? v1 : x - k * v1 - v2;
      }

      // Envelope.
      if (n < aN) level = n / aN;
      else {
        decayX *= decayK;
        level = env.s + (1 - env.s) * decayX;
      }
      if (!percussive && n >= relStart) {
        const r = 1 - (n - relStart) / relN;
        if (r <= 0) break;
        level *= r;
      }
      const y = x * level;
      outL[i] = (outL[i] as number) + y * gl;
      outR[i] = (outR[i] as number) + y * gr;
      if (send) this.rev[i] = (this.rev[i] as number) + y * send * v.level;
    }
  }

  // ---- drums ----

  kick(b: number, level = 1): void {
    const t = this.t(b);
    this.voice({ t, freq: 160, freqEnd: 48, glide: 0.13, oscs: [{ wave: 'sine', amp: 1 }], env: { a: 0.001, d: 0.42, s: 0 }, level });
    // A click so the kick reads on phone speakers.
    this.voice({ t, freq: 900, oscs: [{ wave: 'tri', amp: 1 }], env: { a: 0.0005, d: 0.02, s: 0 }, level: level * 0.25 });
  }

  snare(b: number, level = 0.6): void {
    const t = this.t(b);
    this.voice({ t, freq: 1, oscs: [{ wave: 'noise', amp: 1 }], env: { a: 0.001, d: 0.2, s: 0 }, filter: { type: 'hp', from: 1600 }, level, send: 0.15 });
    this.voice({ t, freq: 190, oscs: [{ wave: 'tri', amp: 1 }], env: { a: 0.001, d: 0.1, s: 0 }, level: level * 0.7 });
  }

  clap(b: number, level = 0.5): void {
    const t = this.t(b);
    const filter: Filter = { type: 'bp', from: 1400, q: 0.9 };
    for (const k of [0, 0.011, 0.022]) {
      this.voice({ t: t + k, freq: 1, oscs: [{ wave: 'noise', amp: 1 }], env: { a: 0.0005, d: 0.012, s: 0 }, filter, level: level * 1.5, send: 0.3 });
    }
    this.voice({ t: t + 0.033, freq: 1, oscs: [{ wave: 'noise', amp: 1 }], env: { a: 0.001, d: 0.22, s: 0 }, filter, level: level * 1.2, send: 0.3 });
  }

  hat(b: number, level = 0.18, open = false, pan = 0.15): void {
    this.voice({
      t: this.t(b),
      freq: 1,
      oscs: [{ wave: 'noise', amp: 1 }],
      env: { a: 0.0005, d: open ? 0.28 : 0.045, s: 0 },
      filter: { type: 'hp', from: 7500 },
      level,
      pan,
      send: 0.05,
    });
  }

  shaker(b: number, level = 0.1, pan = -0.25): void {
    this.voice({
      t: this.t(b),
      freq: 1,
      oscs: [{ wave: 'noise', amp: 1 }],
      env: { a: 0.02, d: 0.07, s: 0 },
      filter: { type: 'bp', from: 6000, q: 1.2 },
      level: level * 1.6,
      pan,
      send: 0.1,
    });
  }

  woodblock(b: number, midi = 79, level = 0.35, pan = 0.3): void {
    this.voice({ t: this.t(b), freq: hz(midi), oscs: [{ wave: 'sine', amp: 1 }], env: { a: 0.0005, d: 0.07, s: 0 }, level, pan, send: 0.15 });
  }

  crash(b: number, level = 0.25): void {
    this.voice({
      t: this.t(b),
      freq: 1,
      oscs: [{ wave: 'noise', amp: 1 }],
      env: { a: 0.001, d: 1.9, s: 0 },
      filter: { type: 'hp', from: 4500 },
      level,
      send: 0.3,
    });
  }

  riser(b: number, beats: number, level = 0.3): void {
    const len = this.t(beats);
    this.voice({
      t: this.t(b),
      freq: 1,
      oscs: [{ wave: 'noise', amp: 1 }],
      env: { a: len, d: 0.02, s: 0 },
      filter: { type: 'bp', from: 400, to: 7000, sweep: len, q: 2 },
      level: level * 2,
      send: 0.3,
    });
  }

  /** Vinyl hiss + crackle from beat `from` to `to`. */
  vinyl(from: number, to: number, level = 0.012): void {
    const t = this.t(from);
    const end = this.t(to);
    this.voice({
      t,
      freq: 1,
      oscs: [{ wave: 'noise', amp: 1 }],
      env: { a: 0.5, d: 0.1, s: 1, hold: end - t, r: 0.5 },
      filter: { type: 'lp', from: 3000 },
      level,
    });
    for (let x = t; x < end; x += 0.08 + this.rand() * 0.35) {
      this.voice({
        t: x,
        freq: 1,
        oscs: [{ wave: 'noise', amp: 1 }],
        env: { a: 0.0002, d: 0.006, s: 0 },
        filter: { type: 'hp', from: 2000 },
        level: level * (2 + this.rand() * 4),
        pan: this.rand() - 0.5,
      });
    }
  }

  // ---- pitched ----

  bass(b: number, midi: number, beats: number, level = 0.4): void {
    const t = this.t(b);
    const hold = this.t(beats) * 0.9;
    this.voice({
      t,
      freq: hz(midi),
      oscs: [{ wave: 'saw', amp: 1 }],
      env: { a: 0.005, d: 0.25, s: 0.6, hold, r: 0.06 },
      filter: { type: 'lp', from: 1600, to: 500, sweep: 0.25, q: 3 },
      level,
    });
    this.voice({ t, freq: hz(midi - 12), oscs: [{ wave: 'sine', amp: 1 }], env: { a: 0.005, d: 0.3, s: 0.7, hold, r: 0.06 }, level: level * 0.8 });
  }

  pizz(b: number, midi: number, level = 0.35, pan = 0): void {
    this.voice({
      t: this.t(b),
      freq: hz(midi),
      oscs: [
        { wave: 'tri', amp: 1 },
        { wave: 'square', amp: 0.25, decay: 0.12 },
      ],
      env: { a: 0.004, d: 0.28, s: 0 },
      filter: { type: 'lp', from: 2000 },
      level,
      pan,
      send: 0.15,
    });
  }

  pluck(b: number, midi: number, beats: number, level = 0.22, pan = 0, bright = 4000): void {
    this.voice({
      t: this.t(b),
      freq: hz(midi),
      oscs: [
        { wave: 'tri', amp: 1 },
        { wave: 'square', amp: 0.5, detune: 6 },
      ],
      env: { a: 0.003, d: Math.min(this.t(beats), 1.2) + 0.05, s: 0 },
      filter: { type: 'lp', from: bright, to: 700, sweep: 0.35 },
      level,
      pan,
      send: 0.25,
    });
  }

  bell(b: number, midi: number, beats: number, level = 0.18, pan = 0.1): void {
    const dur = Math.max(0.6, Math.min(this.t(beats) * 1.5, 2.2));
    this.voice({
      t: this.t(b),
      freq: hz(midi),
      oscs: [
        { wave: 'sine', amp: 1 },
        { wave: 'sine', amp: 0.25, ratio: 2, decay: dur / 1.4 },
        { wave: 'sine', amp: 0.12, ratio: 3.01, decay: dur / 1.7 },
        { wave: 'sine', amp: 0.06, ratio: 4.2, decay: dur / 2 },
      ],
      env: { a: 0.004, d: dur, s: 0 },
      level,
      pan,
      send: 0.35,
    });
  }

  /** Electric-piano-ish chord. */
  keys(b: number, notes: number[], beats: number, level = 0.09): void {
    const hold = this.t(beats);
    notes.forEach((m, i) => {
      this.voice({
        t: this.t(b),
        freq: hz(m),
        oscs: [
          { wave: 'sine', amp: 1 },
          { wave: 'tri', amp: 0.25, ratio: 2, detune: 3, decay: 0.5 },
        ],
        env: { a: 0.006, d: 1.4, s: 0.35, hold, r: 0.35 },
        filter: { type: 'lp', from: 2200 },
        level,
        pan: (i / Math.max(1, notes.length - 1) - 0.5) * 0.5,
        send: 0.3,
      });
    });
  }

  pad(b: number, notes: number[], beats: number, level = 0.05, bright = 1400): void {
    const hold = this.t(beats);
    notes.forEach((m, i) => {
      this.voice({
        t: this.t(b),
        freq: hz(m),
        oscs: [
          { wave: 'saw', amp: 1, detune: -9 },
          { wave: 'saw', amp: 1, detune: 9 },
        ],
        env: { a: Math.min(0.5, hold / 3), d: 0.3, s: 0.85, hold, r: 0.7 },
        filter: { type: 'lp', from: bright },
        level,
        pan: i % 2 ? 0.35 : -0.35,
        send: 0.4,
        pump: true,
      });
    });
  }

  lead(b: number, midi: number, beats: number, level = 0.1, pan = 0): void {
    this.voice({
      t: this.t(b),
      freq: hz(midi),
      oscs: [
        { wave: 'saw', amp: 1, detune: -7 },
        { wave: 'saw', amp: 1, detune: 7 },
      ],
      env: { a: 0.01, d: 0.15, s: 0.7, hold: this.t(beats) * 0.92, r: 0.08 },
      filter: { type: 'lp', from: 2800, q: 2 },
      level,
      pan,
      send: 0.3,
    });
  }

  /** Comedy slide whistle. */
  slide(b: number, from: number, to: number, beats: number, level = 0.15): void {
    const len = this.t(beats);
    this.voice({
      t: this.t(b),
      freq: hz(from),
      freqEnd: hz(to),
      glide: len,
      oscs: [{ wave: 'sine', amp: 1 }],
      env: { a: 0.03, d: 0.1, s: 0.9, hold: len - 0.05, r: 0.05 },
      level,
      send: 0.3,
    });
  }

  /** Ducks the pad bus on every beat in [from, to) — the classic "breathing" dance pad. */
  pump(from: number, to: number, depth = 0.75): void {
    this.pumps.push([from, to, depth]);
  }

  /** Plays a bar of notes with `voice` at bar `bar` (4/4). */
  phrase(bar: number, notes: readonly Note[], voice: (b: number, midi: number, beats: number) => void): void {
    for (const [beat, midi, len] of notes) voice(bar * 4 + beat, midi, len);
  }

  /** Mixes buses + reverb, levels loudness with gentle saturation and peak-normalises to −1 dBFS. */
  mixdown(): Float32Array[] {
    const { L, R, pumpL, pumpR, sr } = this;
    const beatN = (60 / this.bpm) * sr;
    for (let i = 0; i < L.length; i++) {
      let g = 1;
      const beat = i / beatN;
      for (const [from, to, depth] of this.pumps) {
        if (beat >= from && beat < to) g = 1 - depth * Math.max(0, 1 - (beat % 1) / 0.6);
      }
      L[i] = (L[i] as number) + (pumpL[i] as number) * g;
      R[i] = (R[i] as number) + (pumpR[i] as number) * g;
    }
    const wetL = reverb(this.rev, sr, 0);
    const wetR = reverb(this.rev, sr, 23);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < L.length; i++) {
      const l = (L[i] as number) + (wetL[i] as number) * 0.12;
      const r = (R[i] as number) + (wetR[i] as number) * 0.12;
      L[i] = l;
      R[i] = r;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSq += l * l + r * r;
    }
    // Level every song to about the same loudness: gain towards TARGET_RMS, soft-saturating the drum peaks that
    // pushes over full scale (at most DRIVE× into the curve), then peak-normalise.
    const rms = Math.sqrt(sumSq / (2 * L.length)) || 1e-9;
    const gain = Math.min(TARGET_RMS / rms, MAX_DRIVE / (peak || 1));
    let peak2 = 0;
    for (const ch of [L, R]) {
      for (let i = 0; i < ch.length; i++) {
        const y = Math.tanh((ch[i] as number) * gain);
        ch[i] = y;
        peak2 = Math.max(peak2, Math.abs(y));
      }
    }
    const k = 0.89 / (peak2 || 1);
    for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] as number) * k;
    return [L, R];
  }
}

// ---- harmony helpers ----

const CHORDS: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min9: [0, 3, 7, 10, 14],
};

const chord = (root: number, kind: keyof typeof CHORDS) => (CHORDS[kind] ?? []).map((i) => root + i);

// MIDI numbers: C4 = 60.
const C3 = 48;
const D3 = 50;
const E3 = 52;
const F3 = 53;
const G3 = 55;
const A3 = 57;
const Bb3 = 58;

// ---- songs ----

const sunnyPaws: Song = {
  id: 'sunny-paws',
  title: 'Sunny Paws',
  bpm: 118,
  bars: 30,
  mood: 'Happy',
  tags: ['cute'],
  compose(s) {
    const prog = [chord(C3 + 12, 'maj'), chord(G3, 'maj'), chord(A3, 'min'), chord(F3, 'maj')];
    const roots = [C3, G3 - 12, A3 - 12, F3];
    const melody: Note[][] = [
      [[0, 76, 1], [1, 79, 1], [2, 84, 1.5], [3.5, 79, 0.5]],
      [[0, 74, 1], [1, 79, 1], [2, 83, 1], [3, 81, 1]],
      [[0, 81, 1.5], [1.5, 79, 0.5], [2, 76, 1], [3, 72, 1]],
      [[0, 77, 1], [1, 76, 1], [2, 74, 1.5], [3.5, 72, 0.5]],
    ];
    const ending: Note[] = [[0, 77, 1], [1, 81, 1], [2, 79, 2]];
    for (let bar = 0; bar < 29; bar++) {
      const k = bar % 4;
      const ch = prog[k] as number[];
      const b0 = bar * 4;
      // Ukulele-ish arpeggio throughout.
      const arp = [ch[0], ch[1], ch[2], (ch[0] as number) + 12, ch[2], ch[1], (ch[0] as number) + 12, ch[2]];
      arp.forEach((m, i) => s.pluck(b0 + i / 2, (m as number) + 12, 0.5, 0.13, i % 2 ? 0.3 : -0.3, 3500));
      for (let i = 0; i < 8; i++) s.shaker(b0 + i / 2 + 0.02, i % 2 ? 0.08 : 0.05);
      const full = bar >= 4 && !(bar >= 20 && bar < 24);
      if (full) {
        s.kick(b0, 0.9);
        s.kick(b0 + 2, 0.8);
        s.clap(b0 + 1, 0.4);
        s.clap(b0 + 3, 0.4);
        for (let i = 0; i < 4; i++) s.bass(b0 + i, roots[k] as number, i === 3 ? 0.5 : 1, 0.32);
      }
      const chorus = bar >= 12;
      if (chorus) {
        const notes = bar % 8 === 7 ? ending : (melody[k] as Note[]);
        s.phrase(bar, notes, (b, m, l) => s.bell(b, m, l, bar >= 20 && bar < 24 ? 0.12 : 0.16));
        if (bar < 20 || bar >= 24) s.pad(b0, ch.map((m) => m + 12), 4, 0.025, 2000);
      }
      if (bar === 11 || bar === 23) s.riser(b0 + 2, 2, 0.15);
      if (bar === 12 || bar === 24) s.crash(b0, 0.15);
    }
    // Final bar: C chord + bell.
    const end = 29 * 4;
    s.kick(end, 0.9);
    s.crash(end, 0.15);
    s.keys(end, [60, 64, 67, 72], 4, 0.09);
    s.bell(end, 84, 4, 0.16);
    s.bass(end, C3, 3, 0.3);
  },
};

const lazyAfternoon: Song = {
  id: 'lazy-afternoon',
  title: 'Lazy Afternoon',
  bpm: 82,
  bars: 20,
  mood: 'Calm',
  tags: ['chill'],
  compose(s) {
    const voicings = [
      [53, 57, 60, 64],
      [53, 57, 59, 64],
      [52, 55, 59, 62],
      [52, 55, 60, 64],
    ];
    const roots = [D3, G3 - 12, C3, A3 - 12];
    const pent = [62, 65, 67, 69, 72, 74, 77];
    const r = rng(42);
    const swing = 0.16;
    s.vinyl(0, 20 * 4 + 4);
    for (let bar = 0; bar < 20; bar++) {
      const k = bar % 4;
      const b0 = bar * 4;
      const v = voicings[k] as number[];
      s.keys(b0, v, 2.4, 0.075);
      s.keys(b0 + 2.5 + swing / 2, v, 1.4, 0.05);
      const drums = bar >= 2 && bar < 18 && !(bar >= 10 && bar < 12);
      if (drums) {
        s.kick(b0, 0.75);
        s.kick(b0 + 2.5 + swing, 0.55);
        s.snare(b0 + 1, 0.32);
        s.snare(b0 + 3, 0.32);
        for (let i = 0; i < 8; i++) s.hat(b0 + i / 2 + (i % 2 ? swing : 0), i % 2 ? 0.07 : 0.1, false, 0.25);
      }
      if (bar >= 2 && bar < 18) {
        s.bass(b0, roots[k] as number, 1.5, 0.3);
        s.bass(b0 + 2.5 + swing, roots[k] as number, 1, 0.22);
      }
      // A lazy, sparse melody in the middle section.
      if (bar >= 4 && bar < 16 && !(bar >= 10 && bar < 12)) {
        for (let beat = 0; beat < 4; beat += 0.5) {
          if (r() < 0.32) {
            const m = pent[Math.floor(r() * pent.length)] as number;
            s.bell(b0 + beat + (beat % 1 ? swing : 0), m, 1, 0.07, 0.25);
          }
        }
      }
    }
    s.keys(80, [50, 57, 60, 64, 69], 4, 0.07);
  },
};

const zoomies: Song = {
  id: 'zoomies',
  title: 'Zoomies',
  bpm: 140,
  bars: 36,
  mood: 'Energetic',
  tags: ['hype'],
  compose(s) {
    const prog = [chord(A3, 'min'), chord(F3, 'maj'), chord(C3 + 12, 'maj'), chord(G3, 'maj')];
    const roots = [A3 - 12, F3 - 12, C3, G3 - 12];
    const lead: Note[][] = [
      [[0, 76, 0.5], [0.5, 76, 0.5], [1, 79, 0.5], [1.5, 76, 0.5], [2.5, 74, 0.5], [3, 72, 1]],
      [[0, 72, 0.5], [0.5, 74, 0.5], [1, 76, 1], [2.5, 72, 0.5], [3, 69, 1]],
      [[0, 76, 0.5], [0.5, 76, 0.5], [1, 79, 0.5], [1.5, 81, 0.5], [2.5, 79, 0.5], [3, 76, 1]],
      [[0, 74, 0.5], [0.5, 76, 0.5], [1, 74, 0.5], [1.5, 71, 0.5], [2, 74, 2]],
    ];
    const isDrop = (bar: number) => (bar >= 12 && bar < 24) || (bar >= 28 && bar < 35);
    for (let bar = 0; bar < 35; bar++) {
      const k = bar % 4;
      const ch = prog[k] as number[];
      const b0 = bar * 4;
      const drop = isDrop(bar);
      const brk = bar >= 24 && bar < 28;
      // 16th arpeggio, opening up over the intro.
      const bright = bar < 4 ? 1200 + bar * 500 : brk ? 2000 : 3200;
      for (let i = 0; i < 16; i++) {
        const m = (ch[i % 3] as number) + 12 + (i % 8 >= 6 ? 12 : 0);
        s.pluck(b0 + i / 4, m, 0.25, drop ? 0.07 : 0.09, i % 2 ? 0.4 : -0.4, bright);
      }
      if (bar >= 4 && !brk) {
        for (let i = 0; i < 4; i++) s.kick(b0 + i, 0.95);
        s.clap(b0 + 1, 0.45);
        s.clap(b0 + 3, 0.45);
        for (let i = 0; i < 4; i++) s.bass(b0 + i + 0.5, roots[k] as number, 0.45, 0.34);
      }
      for (let i = 0; i < (drop ? 16 : 8); i++) s.hat(b0 + i / (drop ? 4 : 2), i % 2 ? 0.08 : 0.12, !drop && i % 2 === 1);
      if (drop || brk) s.pad(b0, ch.map((m) => m + 12), 4, brk ? 0.04 : 0.035, brk ? 1000 : 2400);
      if (drop) s.phrase(bar, lead[k] as Note[], (b, m, l) => s.lead(b, m, l, 0.085));
      if (bar === 10 || bar === 26) s.riser(b0, 8, 0.28);
      if (bar === 12 || bar === 28) s.crash(b0, 0.25);
    }
    s.pump(12 * 4, 24 * 4);
    s.pump(28 * 4, 35 * 4);
    const end = 35 * 4;
    s.kick(end, 1);
    s.crash(end, 0.3);
    s.pad(end, [69, 72, 76, 81], 3, 0.05, 2000);
    s.bass(end, A3 - 12, 2, 0.35);
  },
};

const tinyDetective: Song = {
  id: 'tiny-detective',
  title: 'Tiny Detective',
  bpm: 100,
  bars: 24,
  mood: 'Playful',
  tags: ['funny'],
  compose(s) {
    const walkUp = [E3, G3, A3, Bb3];
    const walkDown = [E3 + 7, Bb3, A3, G3];
    const m1: Note[] = [[0.5, 64, 0.25], [1, 67, 0.25], [1.5, 69, 0.25], [2, 70, 0.5], [3, 71, 0.5]];
    const m2: Note[] = [[0.5, 71, 0.25], [1, 70, 0.25], [1.5, 69, 0.25], [2, 67, 0.5], [3, 64, 0.5]];
    const m3: Note[] = [[0, 76, 0.25], [0.5, 75, 0.25], [1, 74, 0.25], [1.5, 73, 0.25], [2, 72, 0.5], [3, 71, 0.5]];
    const m4: Note[] = [[0, 64, 0.25], [0.75, 64, 0.25], [1.5, 71, 0.25], [2, 64, 1]];
    const tune = [m1, m2, m1, m3, m1, m2, m3, m4];
    for (let bar = 0; bar < 23; bar++) {
      const b0 = bar * 4;
      const walk = bar % 2 ? walkDown : walkUp;
      const tiptoe = bar >= 10 && bar < 12;
      walk.forEach((m, i) => s.pizz(b0 + i, m, tiptoe ? 0.22 : 0.32, -0.1));
      if (bar >= 2) {
        s.woodblock(b0 + 1.5, 79, 0.22);
        s.woodblock(b0 + 3.5, 74, 0.22);
      }
      if (bar >= 2 && !tiptoe) {
        s.clap(b0 + 1, 0.22);
        s.clap(b0 + 3, 0.22);
        for (let i = 0; i < 8; i++) s.hat(b0 + i / 2, i % 2 ? 0.05 : 0.08, false, 0.3);
        s.kick(b0, 0.6);
      }
      if ((bar >= 2 && bar < 10) || (bar >= 12 && bar < 22)) {
        const notes = tune[(bar - (bar >= 12 ? 12 : 2)) % 8] as Note[];
        s.phrase(bar, notes, (b, m) => s.pizz(b, m + 12, 0.24, 0.2));
        if (bar >= 12) s.phrase(bar, notes, (b, m, l) => s.bell(b, m + 12, l, 0.06, 0.3));
      }
      if (bar === 9 || bar === 21) s.slide(b0 + 3, 72, 86, 0.9, 0.1);
    }
    // "Ta-da": E minor stab, then a sneaky last note.
    const end = 23 * 4;
    s.keys(end, [52, 55, 59, 64], 1, 0.12);
    s.pizz(end, E3, 0.35);
    s.kick(end, 0.7);
    s.pizz(end + 2, 76, 0.25);
    s.woodblock(end + 2, 84, 0.25);
  },
};

const goldenHour: Song = {
  id: 'golden-hour',
  title: 'Golden Hour',
  bpm: 72,
  bars: 18,
  mood: 'Emotional',
  tags: ['chill'],
  compose(s) {
    // F – C/E – Dm – Bb
    const roots = [F3, E3, D3, Bb3 - 12];
    const chords = [chord(F3 + 12, 'maj'), [64, 67, 72], chord(D3 + 12, 'min'), chord(Bb3, 'maj')];
    const arps = [
      [F3, C3 + 12, F3 + 12, 69],
      [E3, G3, C3 + 12, 67],
      [D3, A3, D3 + 12, 65],
      [Bb3 - 12, F3, Bb3, 65],
    ];
    const melody: Note[][] = [
      [[0, 72, 1.5], [1.5, 69, 0.5], [2, 72, 1], [3, 74, 1]],
      [[0, 76, 2], [2, 74, 1], [3, 72, 1]],
      [[0, 74, 1.5], [1.5, 72, 0.5], [2, 69, 2]],
      [[0, 70, 1], [1, 69, 1], [2, 67, 1], [3, 65, 1]],
    ];
    const ending: Note[] = [[0, 70, 1], [1, 74, 1], [2, 72, 2]];
    for (let bar = 0; bar < 17; bar++) {
      const k = bar % 4;
      const b0 = bar * 4;
      const arp = arps[k] as number[];
      for (let i = 0; i < 8; i++) s.keys(b0 + i / 2, [arp[i % 4] as number], 0.5, i === 0 ? 0.11 : 0.075);
      if (bar >= 4) s.pad(b0, chords[k] as number[], 4, 0.03, 1100);
      if (bar >= 4) s.bass(b0, roots[k] as number, 3.5, 0.18);
      if (bar >= 8 && bar < 16) {
        s.kick(b0, 0.45);
        s.kick(b0 + 2, 0.35);
        s.snare(b0 + 3, 0.12);
        for (let i = 0; i < 8; i++) s.shaker(b0 + i / 2, i % 2 ? 0.06 : 0.04);
        s.phrase(bar, bar === 15 ? ending : (melody[k] as Note[]), (b, m, l) => s.bell(b, m + 12, l, 0.13));
      }
      if (bar === 7) s.riser(b0 + 2, 2, 0.08);
    }
    const end = 17 * 4;
    s.keys(end, [53, 60, 65, 69, 72], 4, 0.09);
    s.pad(end, [65, 69, 72], 4, 0.03, 1100);
    s.bell(end, 77, 4, 0.12);
    s.bass(end, F3 - 12, 4, 0.2);
  },
};

export const SONGS: Song[] = [sunnyPaws, zoomies, lazyAfternoon, tinyDetective, goldenHour];

export function songDuration(song: Song): number {
  return (song.bars * 4 * 60) / song.bpm + TAIL_SEC;
}

/** Exact beat times (quarter notes) of the song, seconds. */
export function songBeats(song: Song): number[] {
  return Array.from({ length: song.bars * 4 }, (_, i) => (i * 60) / song.bpm);
}

/** Renders a song to planar stereo at MUSIC_SAMPLE_RATE, peak-normalised to −1 dBFS. */
export function renderSong(song: Song, sampleRate = MUSIC_SAMPLE_RATE): Float32Array[] {
  const studio = new Studio(Math.ceil(songDuration(song) * sampleRate), sampleRate, song.bpm);
  song.compose(studio);
  return studio.mixdown();
}
