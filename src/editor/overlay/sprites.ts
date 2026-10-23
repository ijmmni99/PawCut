// Rasterises overlay sprites (text with font, outline, shadow, glow, box) on the main thread, where web fonts are
// reliably available. Preview caches them; export renders the whole set up front and hands the bitmaps to the worker.
import { cssFont, loadFont } from './fonts';
import type { SpriteImage } from './draw';
import type { Rect, SpriteMeta, SpriteSpec } from './plan';

type Ctx2D = OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx2D | null = null;
function measurer(): Ctx2D {
  measureCtx ??= new OffscreenCanvas(4, 4).getContext('2d') as Ctx2D;
  return measureCtx;
}

type Placed = { text: string; color: string; size: number; w: number };

export async function rasterize(spec: SpriteSpec): Promise<{ bitmap: ImageBitmap; meta: SpriteMeta }> {
  const st = spec.style;
  await loadFont(st.font).catch(() => undefined);
  const m = measurer();
  const size = st.size;
  m.font = cssFont(st.font, size);
  const space = m.measureText(' ').width;

  // Measure runs and wrap to maxWidth.
  const lines: Placed[][] = [];
  for (const line of spec.lines) {
    let cur: Placed[] = [];
    let w = 0;
    for (const run of line) {
      const fs = size * run.scale;
      m.font = cssFont(st.font, fs);
      const rw = m.measureText(run.text).width;
      if (cur.length > 0 && w + space + rw > spec.maxWidth) {
        lines.push(cur);
        cur = [];
        w = 0;
      }
      w += (cur.length > 0 ? space : 0) + rw;
      cur.push({ text: run.text, color: run.color, size: fs, w: rw });
    }
    if (cur.length > 0) lines.push(cur);
  }
  if (lines.length === 0) lines.push([{ text: ' ', color: st.color, size, w: space }]);

  const lineW = lines.map((l) => l.reduce((s, r, i) => s + r.w + (i > 0 ? space : 0), 0));
  const lineH = lines.map((l) => Math.max(...l.map((r) => r.size)) * (st.font === 'anton' || st.font === 'bebas' ? 1.12 : 1.22));
  const outline = st.outline ? Math.max(3, size * (st.font === 'anton' ? 0.13 : 0.1)) : 0;
  const boxPad = st.box ? size * 0.22 : 0;
  const shadowBlur = st.shadow ? size * 0.1 : 0;
  const shadowY = st.shadow ? size * 0.05 : 0;
  const glowBlur = st.glow ? size * 0.35 : 0;
  const pad = Math.ceil(Math.max(outline, shadowBlur + shadowY, glowBlur) + boxPad + 4);
  const W = Math.ceil(Math.max(...lineW) + pad * 2);
  const H = Math.ceil(lineH.reduce((a, b) => a + b, 0) + pad * 2);

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d') as Ctx2D;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const runs: Rect[] = [];
  const bands: SpriteMeta['lines'] = [];
  const placed: Array<{ r: Placed; x: number; y: number }> = [];
  let y = pad;
  lines.forEach((line, li) => {
    const lw = lineW[li] as number;
    const lh = lineH[li] as number;
    const x0 = (W - lw) / 2;
    let x = x0;
    for (const r of line) {
      runs.push({ x, y, w: r.w, h: lh });
      placed.push({ r, x, y: y + lh / 2 });
      x += r.w + space;
    }
    const top = li === 0 ? 0 : y;
    const bottom = li === lines.length - 1 ? H : y + lh;
    bands.push({ x: x0, y: top, w: lw, h: bottom - top, chars: line.reduce((s, r) => s + r.text.length + 1, -1) });
    // TikTok-style box behind each line.
    if (st.box) {
      ctx.fillStyle = st.box;
      const r = size * 0.24;
      ctx.beginPath();
      ctx.roundRect(x0 - boxPad, y - boxPad * 0.35, lw + boxPad * 2, lh + boxPad * 0.7, r);
      ctx.fill();
    }
    y += lh;
  });

  const text = (fill: string | null, stroke: string | null, lw = 0) => {
    for (const { r, x, y: cy } of placed) {
      ctx.font = cssFont(st.font, r.size);
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.strokeText(r.text, x, cy);
      }
      if (fill) {
        ctx.fillStyle = fill === 'run' ? r.color : fill;
        ctx.fillText(r.text, x, cy);
      }
    }
  };

  if (st.glow) {
    ctx.save();
    ctx.shadowColor = st.glow;
    ctx.shadowBlur = glowBlur;
    text(st.glow, null);
    text(st.glow, null);
    ctx.restore();
  }
  if (st.shadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetY = shadowY;
    if (st.outline) text(null, st.outline, outline * 2);
    else text('run', null);
    ctx.restore();
  }
  if (st.outline) text(null, st.outline, outline * 2);
  text('run', null);

  return { bitmap: canvas.transferToImageBitmap(), meta: { w: W, h: H, runs, lines: bands } };
}

/** Session cache for the preview, bounded by pixel count (~120 MB of RGBA). */
const MAX_PIXELS = 30_000_000;
const cache = new Map<string, SpriteImage & { pixels: number }>();
const pending = new Map<string, Promise<void>>();
let pixels = 0;

export function cachedSprite(key: string): SpriteImage | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** Ensures sprites are rasterised; resolves when all are ready. */
export function prepareSprites(specs: ReadonlyMap<string, SpriteSpec>, keys: Iterable<string>): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const key of keys) {
    if (cache.has(key)) continue;
    let job = pending.get(key);
    if (!job) {
      const spec = specs.get(key);
      if (!spec) continue;
      job = rasterize(spec).then(({ bitmap, meta }) => {
        const px = meta.w * meta.h;
        cache.set(key, { image: bitmap, meta, pixels: px });
        pixels += px;
        for (const [k, v] of cache) {
          if (pixels <= MAX_PIXELS) break;
          (v.image as ImageBitmap).close();
          cache.delete(k);
          pixels -= v.pixels;
        }
      });
      job.finally(() => pending.delete(key)).catch(() => undefined);
      pending.set(key, job);
    }
    jobs.push(job);
  }
  return Promise.all(jobs).then(() => undefined);
}
