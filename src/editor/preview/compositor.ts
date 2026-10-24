// Draws decoded VideoFrames onto the single preview canvas through the shared WebGL renderer (looks, HDR tone-map,
// transitions — the same code as export). Falls back to a plain 2D canvas (no effects) without WebGL2.
import type { TransferCode } from '../../engine/media/hdr';
import type { LookParams } from '../../engine/render/looks';
import { type Layer, type TransitionState, containRect, createRenderer } from '../../engine/render/renderer';

/** A decoded frame plus the clockwise rotation (0/90/180/270) needed to display it upright. */
export type FrameSource = {
  frame: VideoFrame;
  rotation: number;
  /** HDR transfer from the track metadata. */
  transfer?: TransferCode;
  /** Main-track clip the frame belongs to (for its look). */
  clipId?: string;
};

export type Compositor = {
  resize(width: number, height: number): void;
  draw(a: FrameSource | null, b?: FrameSource | null, transition?: TransitionState | null): void;
  /** Re-draws the last frame(s), e.g. after a resize or a look change. */
  redraw(): void;
  destroy(): void;
};

function displaySize({ frame, rotation }: FrameSource): { w: number; h: number } {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  return rotation % 180 === 0 ? { w, h } : { w: h, h: w };
}

type LookOf = (clipId: string | undefined) => LookParams | null;

function toLayer(s: FrameSource, lookOf: LookOf): Layer {
  return {
    image: s.frame,
    width: s.frame.displayWidth,
    height: s.frame.displayHeight,
    rotation: s.rotation,
    transfer: s.transfer ?? 0,
    colorSpace: s.frame.colorSpace,
    look: lookOf(s.clipId),
  };
}

function create2D(canvas: HTMLCanvasElement): Pick<Compositor, 'resize'> & { draw(a: FrameSource | null): void } {
  const ctx = canvas.getContext('2d');
  return {
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    draw(source) {
      if (!ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!source) return;
      const size = displaySize(source);
      const r = containRect(size.w, size.h, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.rotate((source.rotation * Math.PI) / 180);
      const [dw, dh] = source.rotation % 180 === 0 ? [r.w, r.h] : [r.h, r.w];
      ctx.drawImage(source.frame, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    },
  };
}

export function createCompositor(canvas: HTMLCanvasElement, lookOf: LookOf): Compositor {
  let last: [FrameSource | null, FrameSource | null, TransitionState | null] = [null, null, null];
  let renderer = null;
  try {
    renderer = createRenderer(canvas);
  } catch (err) {
    console.warn('WebGL renderer unavailable', err);
  }
  if (!renderer) {
    const fallback = create2D(canvas);
    return {
      resize: fallback.resize,
      draw(a, b = null, tr = null) {
        last = [a, b, tr];
        fallback.draw(tr && b && tr.p >= 0.5 ? b : a);
      },
      redraw() {
        fallback.draw(last[2] && last[1] && last[2].p >= 0.5 ? last[1] : last[0]);
      },
      destroy() {},
    };
  }
  const r = renderer;
  const paint = () => {
    const [a, b, tr] = last;
    try {
      r.render(a ? toLayer(a, lookOf) : null, b ? toLayer(b, lookOf) : null, tr);
    } catch (err) {
      // A closed frame (raced with a newer one) — the next draw replaces it.
      console.warn('preview draw', err);
    }
  };
  return {
    resize(width, height) {
      r.resize(width, height);
    },
    draw(a, b = null, tr = null) {
      last = [a, b, tr];
      paint();
    },
    redraw: paint,
    destroy() {
      r.destroy();
    },
  };
}
