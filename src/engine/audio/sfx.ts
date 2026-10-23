// Built-in sound effects, synthesised with Web Audio (no samples, no licensing). Each recipe draws into an
// OfflineAudioContext; the library renders them once to WAV and stores them like imported effects.

export const SFX_SAMPLE_RATE = 48_000;
/** Bump when recipes change so stored renders are regenerated. */
export const SFX_VERSION = 1;

type Recipe = { id: string; name: string; category: string; seconds: number; build(ctx: OfflineAudioContext): void };

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return buf;
}

function noise(ctx: BaseAudioContext, seconds: number, at = 0): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, seconds);
  src.start(at);
  return src;
}

function envelope(ctx: BaseAudioContext, points: Array<[number, number]>, curve: 'lin' | 'exp' = 'lin'): GainNode {
  const g = ctx.createGain();
  const [first, ...rest] = points;
  g.gain.setValueAtTime(first?.[1] ?? 0, first?.[0] ?? 0);
  for (const [t, v] of rest) {
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0001), t);
    else g.gain.linearRampToValueAtTime(v, t);
  }
  return g;
}

function tone(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: Array<[number, number]>,
  at: number,
  stop: number,
): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = type;
  const [first, ...rest] = freq;
  osc.frequency.setValueAtTime(first?.[1] ?? 440, first?.[0] ?? at);
  for (const [t, f] of rest) osc.frequency.exponentialRampToValueAtTime(f, t);
  osc.start(at);
  osc.stop(stop);
  return osc;
}

function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) (nodes[i] as AudioNode).connect(nodes[i + 1] as AudioNode);
  return nodes[nodes.length - 1] as AudioNode;
}

const sweepNoise = (ctx: OfflineAudioContext, from: number, to: number, len: number, type: BiquadFilterType, peak = 0.9) => {
  const bp = ctx.createBiquadFilter();
  bp.type = type;
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(from, 0);
  bp.frequency.exponentialRampToValueAtTime(to, len);
  chain(noise(ctx, len), bp, envelope(ctx, [[0, 0], [len * 0.45, peak], [len, 0]]), ctx.destination);
};

const ding = (ctx: OfflineAudioContext, freq: number, at: number, len: number, level = 0.5) => {
  for (const [mult, amp] of [
    [1, 1],
    [2.76, 0.35],
    [5.4, 0.12],
  ] as const) {
    chain(
      tone(ctx, 'sine', [[at, freq * mult]], at, at + len),
      envelope(ctx, [[at, 0.0001], [at + 0.005, level * amp], [at + len, 0.0001]], 'exp'),
      ctx.destination,
    );
  }
};

const click = (ctx: OfflineAudioContext, at: number, level = 0.8, cutoff = 2000) => {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = cutoff;
  chain(noise(ctx, 0.03, at), hp, envelope(ctx, [[at, level], [at + 0.025, 0.0001]], 'exp'), ctx.destination);
};

export const SFX_RECIPES: Recipe[] = [
  { id: 'whoosh', name: 'Whoosh', category: 'Whoosh', seconds: 0.7, build: (c) => sweepNoise(c, 300, 3200, 0.7, 'bandpass') },
  { id: 'swoosh', name: 'Swoosh', category: 'Whoosh', seconds: 0.4, build: (c) => sweepNoise(c, 5000, 600, 0.4, 'bandpass', 0.8) },
  {
    id: 'pop',
    name: 'Pop',
    category: 'Pop',
    seconds: 0.15,
    build: (c) =>
      chain(tone(c, 'sine', [[0, 700], [0.08, 180]], 0, 0.15), envelope(c, [[0, 0.9], [0.12, 0.0001]], 'exp'), c.destination),
  },
  {
    id: 'bloop',
    name: 'Cute bloop',
    category: 'Pop',
    seconds: 0.2,
    build: (c) =>
      chain(tone(c, 'sine', [[0, 280], [0.13, 950]], 0, 0.2), envelope(c, [[0, 0.0001], [0.02, 0.7], [0.18, 0.0001]], 'exp'), c.destination),
  },
  { id: 'ding', name: 'Ding', category: 'Ding', seconds: 1.3, build: (c) => ding(c, 1320, 0, 1.25) },
  { id: 'click', name: 'Click', category: 'Click', seconds: 0.05, build: (c) => click(c, 0) },
  {
    id: 'boing',
    name: 'Boing',
    category: 'Boing',
    seconds: 0.7,
    build: (c) => {
      const osc = tone(c, 'triangle', [[0, 140]], 0, 0.7);
      const lfo = tone(c, 'sine', [[0, 18], [0.6, 6]], 0, 0.7);
      const depth = c.createGain();
      depth.gain.setValueAtTime(90, 0);
      depth.gain.exponentialRampToValueAtTime(5, 0.65);
      lfo.connect(depth).connect(osc.frequency);
      osc.frequency.setValueAtTime(140, 0);
      osc.frequency.linearRampToValueAtTime(260, 0.6);
      chain(osc, envelope(c, [[0, 0.8], [0.68, 0.0001]], 'exp'), c.destination);
    },
  },
  {
    id: 'riser',
    name: 'Riser',
    category: 'Riser',
    seconds: 1.6,
    build: (c) => {
      sweepNoise(c, 400, 6000, 1.6, 'bandpass', 0.5);
      chain(tone(c, 'sawtooth', [[0, 110], [1.55, 880]], 0, 1.6), envelope(c, [[0, 0], [1.5, 0.25], [1.6, 0]]), c.destination);
    },
  },
  {
    id: 'impact',
    name: 'Impact',
    category: 'Impact',
    seconds: 0.9,
    build: (c) => {
      chain(tone(c, 'sine', [[0, 120], [0.4, 40]], 0, 0.9), envelope(c, [[0, 1], [0.85, 0.0001]], 'exp'), c.destination);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      chain(noise(c, 0.3), lp, envelope(c, [[0, 0.7], [0.25, 0.0001]], 'exp'), c.destination);
    },
  },
  {
    id: 'cash',
    name: 'Cash register',
    category: 'Cash',
    seconds: 1.1,
    build: (c) => {
      click(c, 0, 0.6, 1200);
      click(c, 0.05, 0.5, 1200);
      ding(c, 2093, 0.12, 0.9, 0.35);
      ding(c, 2637, 0.2, 0.9, 0.35);
    },
  },
  {
    id: 'shutter',
    name: 'Camera shutter',
    category: 'Camera',
    seconds: 0.2,
    build: (c) => {
      click(c, 0, 0.9, 1500);
      click(c, 0.07, 0.7, 2500);
    },
  },
];

/** Renders one recipe to planar float channels (mono) at SFX_SAMPLE_RATE. */
export async function renderSfx(recipe: Recipe): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(1, Math.ceil(recipe.seconds * SFX_SAMPLE_RATE), SFX_SAMPLE_RATE);
  recipe.build(ctx);
  const buffer = await ctx.startRendering();
  return [buffer.getChannelData(0).slice()];
}
