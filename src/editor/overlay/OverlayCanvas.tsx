// Preview layer over the video: draws texts and captions for the playhead time, and lets the user grab a text
// (tap = select, drag = move, pinch = scale + rotate). Taps elsewhere fall through to play/pause.
import { useEffect, useRef } from 'react';
import { useEditor, usePlayback } from '../store';
import { drawOps } from './draw';
import { type DrawOp, FRAME_H, FRAME_W, buildPlan, layoutAt } from './plan';
import { cachedSprite, prepareSprites } from './sprites';
import { textsOf, updateText } from './textOps';

type Props = { width: number; height: number; safeZone: boolean; onTap(): void };

const PREFETCH_SEC = 4;
const SNAP = 0.02;

function hitText(ops: readonly DrawOp[], textIds: ReadonlySet<string>, x: number, y: number): DrawOp | null {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i] as DrawOp;
    if (!op.id || !textIds.has(op.id)) continue;
    const meta = cachedSprite(op.key)?.meta;
    if (!meta) continue;
    const a = (-op.rotation * Math.PI) / 180;
    const dx = x - op.cx;
    const dy = y - op.cy;
    const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / op.scale;
    const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / op.scale;
    if (Math.abs(lx) <= meta.w / 2 + 20 && Math.abs(ly) <= meta.h / 2 + 20) return op;
  }
  return null;
}

/** TikTok UI zones (top bar, right-hand buttons, caption + bottom bar), as fractions of the frame. */
const SAFE_ZONES = [
  { x: 0, y: 0, w: 1, h: 0.09 },
  { x: 0.86, y: 0.36, w: 0.14, h: 0.5 },
  { x: 0, y: 0.8, w: 1, h: 0.2 },
];

export function OverlayCanvas({ width, height, safeZone, onTap }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const opsRef = useRef<DrawOp[]>([]);
  const guide = useRef<{ v: boolean } | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  // Drawing: on playhead / project / size changes, plus once more whenever missing sprites become ready.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let alive = true;
    const draw = () => {
      raf = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      const { project, selection } = useEditor.getState();
      if (!project || w === 0) return;
      const t = usePlayback.getState().time;
      const plan = buildPlan(project);
      // A selected text shows at rest while paused, so it's visible while being edited.
      const settled = usePlayback.getState().playing ? undefined : new Set(selection);
      const ops = layoutAt(plan, t, (key) => cachedSprite(key)?.meta, settled);
      opsRef.current = ops;
      const k = w / FRAME_W;
      drawOps(ctx, ops, cachedSprite, k);

      // Sprites for what's on screen now and coming up next.
      const want = plan.items.filter((it) => it.end > t - 0.5 && it.start < t + PREFETCH_SEC);
      const keys = want.flatMap((it) => [it.key, ...(it.karaoke?.map((kw) => kw.key) ?? [])]);
      if (keys.some((key) => !cachedSprite(key))) {
        void prepareSprites(plan.specs, keys).then(() => {
          if (alive) schedule();
        });
      }

      // Selected text: dashed frame.
      const sel = ops.find((op) => op.id && selection.includes(op.id));
      const meta = sel ? cachedSprite(sel.key)?.meta : undefined;
      if (sel && meta) {
        ctx.save();
        ctx.translate(sel.cx * k, sel.cy * k);
        ctx.rotate((sel.rotation * Math.PI) / 180);
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = 1.5 * dpr;
        const bw = meta.w * sel.scale * k;
        const bh = meta.h * sel.scale * k;
        ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
        ctx.restore();
      }
      if (guide.current?.v) {
        ctx.fillStyle = 'rgba(236,72,153,0.9)';
        ctx.fillRect(w / 2 - dpr / 2, 0, dpr, h);
      }
      if (safeZone) {
        ctx.fillStyle = 'rgba(239,68,68,0.22)';
        for (const z of SAFE_ZONES) ctx.fillRect(z.x * w, z.y * h, z.w * w, z.h * h);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    schedule();
    const unsubs = [usePlayback.subscribe(schedule), useEditor.subscribe(schedule)];
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      for (const u of unsubs) u();
    };
  }, [width, height, safeZone]);

  // Gestures.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pointers = new Map<number, { x: number; y: number }>();
    type Drag = { id: string; x0: number; y0: number; px: number; py: number; moved: boolean };
    type Pinch = { id: string; dist: number; angle: number; scale: number; rotation: number };
    let drag: Drag | null = null;
    let pinch: Pinch | null = null;
    let tapStart: { x: number; y: number } | null = null;

    const toFrame = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * FRAME_W, y: ((e.clientY - r.top) / r.height) * FRAME_H };
    };
    const pair = () => {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), angle: Math.atan2(b.y - a.y, b.x - a.x) };
    };

    const onDown = (e: PointerEvent) => {
      const pt = toFrame(e);
      pointers.set(e.pointerId, pt);
      canvas.setPointerCapture(e.pointerId);
      const editor = useEditor.getState();
      const project = editor.project;
      if (!project) return;
      if (pointers.size === 2 && drag) {
        const item = textsOf(project).find((t) => t.id === drag?.id);
        if (item) pinch = { id: item.id, ...pair(), scale: item.scale, rotation: item.rotation };
        drag = null;
        return;
      }
      if (pointers.size > 1) return;
      const textIds = new Set(textsOf(project).map((t) => t.id));
      const hit = hitText(opsRef.current, textIds, pt.x, pt.y);
      if (!hit?.id) {
        tapStart = pt;
        return;
      }
      const item = textsOf(project).find((t) => t.id === hit.id);
      if (!item) return;
      if (!(editor.selection.length === 1 && editor.selection[0] === item.id)) editor.select([item.id]);
      editor.beginGesture();
      drag = { id: item.id, x0: item.x, y0: item.y, px: pt.x, py: pt.y, moved: false };
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const pt = toFrame(e);
      pointers.set(e.pointerId, pt);
      const editor = useEditor.getState();
      if (pinch && pointers.size >= 2) {
        const { dist, angle } = pair();
        const p = pinch;
        const scale = Math.min(4, Math.max(0.3, (p.scale * dist) / p.dist));
        let rotation = p.rotation + ((angle - p.angle) * 180) / Math.PI;
        if (Math.abs(rotation) < 3) rotation = 0;
        editor.apply((proj) => updateText(proj, p.id, { scale, rotation }));
        return;
      }
      if (!drag) return;
      const dx = (pt.x - drag.px) / FRAME_W;
      const dy = (pt.y - drag.py) / FRAME_H;
      if (!drag.moved && Math.hypot(pt.x - drag.px, pt.y - drag.py) < 12) return;
      drag.moved = true;
      let x = Math.min(1, Math.max(0, drag.x0 + dx));
      const y = Math.min(1, Math.max(0, drag.y0 + dy));
      const snapped = Math.abs(x - 0.5) < SNAP;
      if (snapped) x = 0.5;
      guide.current = { v: snapped };
      const id = drag.id;
      editor.apply((proj) => updateText(proj, id, { x, y }));
    };

    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const pt = toFrame(e);
      pointers.delete(e.pointerId);
      if (pointers.size > 0) return;
      if (drag || pinch) useEditor.getState().endGesture();
      if (tapStart && Math.hypot(pt.x - tapStart.x, pt.y - tapStart.y) < 30) onTapRef.current();
      drag = null;
      pinch = null;
      tapStart = null;
      guide.current = null;
      usePlayback.setState({});
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      data-testid="overlay"
      className="absolute touch-none rounded-lg"
      style={{ width, height }}
    />
  );
}
