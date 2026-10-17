// Pure PCM helpers used by the export worker (Web Audio isn't available in workers).

/** Decoded source audio: planar channels starting at source time `startSec`. */
export type Pcm = { channels: Float32Array[]; sampleRate: number; startSec: number };

/**
 * Renders `frames` output frames of a clip into planar `out` (starting at `outOffset`).
 * Output frame j plays source time `srcStartSec + (j / outRate) * speed`, linearly interpolated, so speed changes
 * also shift pitch (matching the preview, which disables pitch preservation). Mono sources fill every channel.
 */
export function renderSpeedResampled(
  src: Pcm,
  out: Float32Array[],
  outOffset: number,
  frames: number,
  outRate: number,
  srcStartSec: number,
  speed: number,
): void {
  const step = (speed * src.sampleRate) / outRate;
  const base = (srcStartSec - src.startSec) * src.sampleRate;
  for (let c = 0; c < out.length; c++) {
    const dst = out[c] as Float32Array;
    const data = src.channels[Math.min(c, src.channels.length - 1)];
    if (!data || data.length === 0) continue;
    const last = data.length - 1;
    for (let j = 0; j < frames; j++) {
      const pos = base + j * step;
      if (pos < 0 || pos > last) continue;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = data[i] as number;
      const b = data[Math.min(i + 1, last)] as number;
      dst[outOffset + j] = a + (b - a) * frac;
    }
  }
}

/** Short linear fades at both ends of a range to avoid clicks at cuts. */
export function applyEdgeFades(out: Float32Array[], start: number, frames: number, fadeFrames: number): void {
  const n = Math.min(fadeFrames, Math.floor(frames / 2));
  for (const ch of out) {
    for (let i = 0; i < n; i++) {
      const g = i / n;
      ch[start + i] = (ch[start + i] as number) * g;
      ch[start + frames - 1 - i] = (ch[start + frames - 1 - i] as number) * g;
    }
  }
}
