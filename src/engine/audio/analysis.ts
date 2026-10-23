// Pure audio analysis for the music / SFX library: waveform thumbnails, tempo + beat grid, WAV encoding.

/** Peak level (0..1) per bucket, for drawing a waveform. */
export function waveformPeaks(channels: readonly Float32Array[], buckets: number): number[] {
  const length = channels[0]?.length ?? 0;
  const out = new Array<number>(buckets).fill(0);
  if (length === 0) return out;
  const size = length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(length, Math.floor((b + 1) * size));
    let peak = 0;
    for (const ch of channels) {
      // Stride through long buckets; the waveform is a thumbnail.
      const step = Math.max(1, Math.floor((to - from) / 256));
      for (let i = from; i < to; i += step) peak = Math.max(peak, Math.abs(ch[i] as number));
    }
    out[b] = Math.min(1, peak);
  }
  return out;
}

export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] = (mono[i] as number) + (ch[i] as number) / channels.length;
  return mono;
}

export type Tempo = { bpm: number | null; beats: number[] };

const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;

/**
 * Tempo and beat grid from onset strength: log-energy rises per 512-sample hop → autocorrelation over 60–180 BPM
 * (weighted towards ~120 to avoid half/double-time picks) → the beat phase with the most onset energy.
 */
export function detectTempo(mono: Float32Array, sampleRate: number): Tempo {
  const frames = Math.floor(mono.length / HOP);
  if (frames < 16) return { bpm: null, beats: [] };
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) sum += (mono[i] as number) ** 2;
    energy[f] = Math.log(1e-9 + sum / HOP);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, (energy[f] as number) - (energy[f - 1] as number));
  // Remove the mean so silence doesn't correlate.
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, (onset[f] as number) - mean);

  const hopSec = HOP / sampleRate;
  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / hopSec));
  const maxLag = Math.min(frames - 1, Math.ceil(60 / MIN_BPM / hopSec));
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = lag; f < frames; f++) sum += (onset[f] as number) * (onset[f - lag] as number);
    // Gentle log-Gaussian preference for ~120 BPM.
    const bpm = 60 / (lag * hopSec);
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (sum / (frames - lag)) * weight;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return { bpm: null, beats: [] };

  // Parabolic refinement of the lag for a sub-hop period.
  const ac = (lag: number) => {
    let sum = 0;
    for (let f = lag; f < frames; f++) sum += (onset[f] as number) * (onset[f - lag] as number);
    return sum / (frames - lag);
  };
  const acPrev = ac(bestLag - 1);
  const acMid = ac(bestLag);
  const acNext = ac(bestLag + 1);
  const denom = acPrev - 2 * acMid + acNext;
  const lag = denom !== 0 ? bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (acPrev - acNext)) / denom)) : bestLag;

  // Phase: the offset (in hops) whose comb collects the most onset energy.
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let ph = 0; ph < Math.ceil(lag); ph++) {
    let sum = 0;
    for (let x = ph; x < frames; x += lag) sum += onset[Math.round(x)] ?? 0;
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = ph;
    }
  }
  // Refine: snap each predicted beat to the strongest onset within ±15% of a period, then fit an even grid
  // (least squares on beat index) through the snapped positions so small tempo errors don't drift over a song.
  const window = Math.max(1, Math.round(lag * 0.15));
  const ks: number[] = [];
  const fs: number[] = [];
  let k = 0;
  for (let x = bestPhase; x < frames; x += lag, k++) {
    const centre = Math.round(x);
    let best = centre;
    for (let f = Math.max(1, centre - window); f <= Math.min(frames - 1, centre + window); f++) {
      if ((onset[f] as number) > (onset[best] ?? 0)) best = f;
    }
    if ((onset[best] ?? 0) > 0) {
      ks.push(k);
      fs.push(best);
    }
  }
  let a = bestPhase;
  let slope = lag;
  if (ks.length >= 4) {
    const mk = ks.reduce((s, v) => s + v, 0) / ks.length;
    const mf = fs.reduce((s, v) => s + v, 0) / fs.length;
    let num = 0;
    let den = 0;
    ks.forEach((kv, i) => {
      num += (kv - mk) * ((fs[i] as number) - mf);
      den += (kv - mk) ** 2;
    });
    if (den > 0) {
      slope = num / den;
      a = mf - slope * mk;
    }
  }
  const duration = mono.length / sampleRate;
  const beats: number[] = [];
  // A rise detected at hop f began, on average, half a hop before that hop's start.
  for (let t = Math.max(0, (a - 0.5) * hopSec); t < duration; t += slope * hopSec) beats.push(Number(t.toFixed(4)));
  return { bpm: Math.round((60 / (slope * hopSec)) * 10) / 10, beats };
}

/** 16-bit PCM WAV file from planar float channels. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const view = new DataView(bytes.buffer);
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + n * ch * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return bytes;
}
