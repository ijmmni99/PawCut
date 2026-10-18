// Pure per-frame / per-window feature extractors for Auto-Cut. No DOM or WebCodecs here so it is unit-testable.

/** Luma from RGBA pixels (BT.601). */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * (rgba[p] as number) + 0.587 * (rgba[p + 1] as number) + 0.114 * (rgba[p + 2] as number);
  }
  return out;
}

export function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] as number;
  return values.length ? sum / values.length : 0;
}

/** Linear-interpolated percentile (p in 0..1) of a copy of `values`. */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const pos = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export type Motion = {
  /** Mean of the busiest quarter of grid cells: something moving in the frame. */
  local: number;
  /** Median cell change: the whole frame changing, i.e. camera pan / shake. */
  global: number;
};

/** Frame-difference motion over a cols×rows grid (a cheap stand-in for optical flow). */
export function gridMotion(
  prev: Float32Array,
  cur: Float32Array,
  width: number,
  height: number,
  cols = 4,
  rows = 6,
): Motion {
  const cells = new Float32Array(cols * rows);
  const counts = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / width));
      const i = y * width + x;
      const c = cy * cols + cx;
      cells[c] = (cells[c] as number) + Math.abs((cur[i] as number) - (prev[i] as number));
      counts[c] = (counts[c] as number) + 1;
    }
  }
  const avg = Array.from(cells, (v, i) => v / Math.max(1, counts[i] as number)).sort((a, b) => b - a);
  const top = avg.slice(0, Math.max(1, Math.round(avg.length / 4)));
  return { local: mean(top), global: percentile(avg, 0.5) };
}

/** Variance of the 4-neighbour Laplacian: low values mean a blurry frame. */
export function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        4 * (gray[i] as number) -
        (gray[i - 1] as number) -
        (gray[i + 1] as number) -
        (gray[i - width] as number) -
        (gray[i + width] as number);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const m = sum / n;
  return sumSq / n - m * m;
}

/** RMS level in dBFS of a mono block (floored at -100). */
export function rmsDb(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += (samples[i] as number) ** 2;
  const rms = Math.sqrt(sum / Math.max(1, end - start));
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100;
}

export type Box = { x: number; y: number; w: number; h: number };

/** How much a subject moved/changed size between two detections, ~0 (still) to ~1+ (big move). */
export function boxMovement(a: Box, b: Box): number {
  const size = Math.max(1e-6, Math.sqrt(a.w * a.h));
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const shift = Math.hypot(dx, dy) / size;
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const grow = Math.abs(areaB - areaA) / Math.max(1e-6, Math.max(areaA, areaB));
  return shift + grow;
}
