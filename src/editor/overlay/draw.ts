// Draws laid-out overlay sprites onto a 2D canvas. DOM-free: used by the preview (main thread) and the export worker.
import type { DrawOp, SpriteMeta } from './plan';

export type SpriteImage = { image: CanvasImageSource; meta: SpriteMeta };
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** `k` = canvas pixels per design pixel (1 for a 1080-wide export). */
export function drawOps(ctx: Ctx2D, ops: readonly DrawOp[], get: (key: string) => SpriteImage | undefined, k: number): void {
  for (const op of ops) {
    const sprite = get(op.key);
    if (!sprite || op.opacity <= 0.001 || op.scale <= 0.001) continue;
    const { image, meta } = sprite;
    ctx.save();
    ctx.globalAlpha = Math.min(1, op.opacity);
    ctx.translate(op.cx * k, op.cy * k);
    if (op.rotation) ctx.rotate((op.rotation * Math.PI) / 180);
    ctx.scale(op.scale * k, op.scale * k);
    const x0 = -meta.w / 2;
    const y0 = -meta.h / 2;
    if (op.reveal >= 1) {
      ctx.drawImage(image, x0, y0, meta.w, meta.h);
    } else {
      // Typewriter: reveal characters line by line, left to right.
      const total = meta.lines.reduce((s, l) => s + l.chars, 0) || 1;
      let shown = op.reveal * total;
      for (const line of meta.lines) {
        if (shown <= 0) break;
        const frac = Math.min(1, shown / Math.max(1, line.chars));
        shown -= line.chars;
        const w = Math.min(meta.w, line.x + line.w * frac);
        if (w > 0 && line.h > 0) ctx.drawImage(image, 0, line.y, w, line.h, x0, y0 + line.y, w, line.h);
      }
    }
    ctx.restore();
  }
}
