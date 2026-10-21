// Canvas timeline (no per-clip DOM). The playhead is fixed at the horizontal centre; the track scrolls under it.
// Gestures: drag = scrub (with inertia), pinch = zoom, tap = select, drag a selected clip's handle = trim,
// long-press a clip = reorder.
import { useEffect, useRef } from 'react';
import { readFile } from '../../engine/storage/opfs';
import { useAssets, useEditor, usePlayback } from '../store';
import {
  type Asset,
  type Clip,
  type Project,
  clipDuration,
  clipStarts,
  moveClip,
  projectDuration,
  trimClip,
} from './model';

const RULER_H = 22;
const TRACK_Y = 30;
const TRACK_H = 64;
export const TIMELINE_HEIGHT = TRACK_Y + TRACK_H + 16;
const HANDLE_W = 18;
const MIN_PPS = 6;
const MAX_PPS = 600;
const DRAG_SLOP = 6;
const LONG_PRESS_MS = 380;
const SNAP_PX = 10;
const BLOCK_W = 56;
const BLOCK_GAP = 6;

type Hit = { index: number; clip: Clip; start: number; x0: number; w: number };

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; x: number; y: number; time: number }
  | { kind: 'pan'; x: number; time: number }
  | { kind: 'trim'; edge: 'in' | 'out'; clipId: string; x: number; time: number; base: Clip; assetDuration: number }
  | { kind: 'reorder'; from: number; to: number; x: number }
  | { kind: 'pinch'; dist: number; pps: number };

export type TimelineCallbacks = {
  /** User started touching the timeline: playback should stop. */
  onInteract(): void;
  /** Show a source frame while trimming. */
  onPeek(assetId: string, sourceSec: number): void;
  /** Trimming finished: show the playhead frame again. */
  onPeekEnd(): void;
};

const haptic = () => navigator.vibrate?.(8);

function formatTick(sec: number, step: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : Math.round(s).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

class TimelineController {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = TIMELINE_HEIGHT;
  private dpr = 1;
  pps = 60;
  private dirty = true;
  private raf = 0;
  private mode: Mode = { kind: 'idle' };
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private longPress = 0;
  private velocity: Array<{ x: number; t: number }> = [];
  private inertia = 0;
  private readonly sprites = new Map<string, ImageBitmap | 'loading' | 'failed'>();
  private readonly unsub: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: TimelineCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    const mark = () => this.invalidate();
    this.unsub.push(useEditor.subscribe(mark), useAssets.subscribe(mark), usePlayback.subscribe(mark));
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    this.loop();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inertia);
    window.clearTimeout(this.longPress);
    for (const u of this.unsub) u();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    for (const s of this.sprites.values()) if (s instanceof ImageBitmap) s.close();
  }

  resize(cssWidth: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = cssWidth;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
  }

  private loop = () => {
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // ---- geometry ----

  private get project(): Project | null {
    return useEditor.getState().project;
  }

  private get time(): number {
    return usePlayback.getState().time;
  }

  private get cx(): number {
    return this.width / 2;
  }

  private xOf(t: number): number {
    return this.cx + (t - this.time) * this.pps;
  }

  private hitAt(x: number, y: number): Hit | null {
    const p = this.project;
    if (!p || y < TRACK_Y - 8 || y > TRACK_Y + TRACK_H + 8) return null;
    const starts = clipStarts(p);
    for (let index = 0; index < p.main.length; index++) {
      const clip = p.main[index] as Clip;
      const start = starts[index] ?? 0;
      const x0 = this.xOf(start);
      const w = clipDuration(clip) * this.pps;
      if (x >= x0 && x <= x0 + w) return { index, clip, start, x0, w };
    }
    return null;
  }

  private handleAt(x: number, y: number): { edge: 'in' | 'out'; hit: Hit } | null {
    const p = this.project;
    const selected = useEditor.getState().selection;
    if (!p || selected.length !== 1 || y < TRACK_Y - 12 || y > TRACK_Y + TRACK_H + 12) return null;
    const starts = clipStarts(p);
    const index = p.main.findIndex((c) => c.id === selected[0]);
    const clip = p.main[index];
    if (!clip) return null;
    const start = starts[index] ?? 0;
    const x0 = this.xOf(start);
    const w = clipDuration(clip) * this.pps;
    const hit = { index, clip, start, x0, w };
    // Generous touch zones that extend a little outside the clip.
    if (x >= x0 - 12 && x <= x0 + HANDLE_W + 4) return { edge: 'in', hit };
    if (x >= x0 + w - HANDLE_W - 4 && x <= x0 + w + 12) return { edge: 'out', hit };
    return null;
  }

  private setTime(t: number): void {
    const p = this.project;
    const total = p ? projectDuration(p) : 0;
    usePlayback.getState().setTime(Math.min(Math.max(t, 0), total));
  }

  // ---- gestures ----

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    cancelAnimationFrame(this.inertia);
    this.cb.onInteract();

    if (this.pointers.size === 2) {
      window.clearTimeout(this.longPress);
      this.finishGesture(false);
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.mode = { kind: 'pinch', dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), pps: this.pps };
      return;
    }
    if (this.pointers.size > 2) return;

    const handle = this.handleAt(pt.x, pt.y);
    if (handle) {
      const asset = useAssets.getState().assets[handle.hit.clip.assetId];
      useEditor.getState().beginGesture();
      this.mode = {
        kind: 'trim',
        edge: handle.edge,
        clipId: handle.hit.clip.id,
        x: pt.x,
        time: this.time,
        base: handle.hit.clip,
        assetDuration: asset?.durationSec ?? handle.hit.clip.outSec,
      };
      haptic();
      return;
    }

    this.mode = { kind: 'pending', x: pt.x, y: pt.y, time: this.time };
    this.velocity = [{ x: pt.x, t: e.timeStamp }];
    this.longPress = window.setTimeout(() => {
      if (this.mode.kind !== 'pending') return;
      const hit = this.hitAt(this.mode.x, this.mode.y);
      if (!hit || (this.project?.main.length ?? 0) < 2) return;
      haptic();
      this.mode = { kind: 'reorder', from: hit.index, to: hit.index, x: this.mode.x };
      this.invalidate();
    }, LONG_PRESS_MS);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    const m = this.mode;

    switch (m.kind) {
      case 'pending':
        if (Math.abs(pt.x - m.x) > DRAG_SLOP || Math.abs(pt.y - m.y) > DRAG_SLOP) {
          window.clearTimeout(this.longPress);
          this.mode = { kind: 'pan', x: m.x, time: m.time };
          this.onMove(e);
        }
        break;
      case 'pan':
        this.setTime(m.time - (pt.x - m.x) / this.pps);
        this.velocity.push({ x: pt.x, t: e.timeStamp });
        if (this.velocity.length > 6) this.velocity.shift();
        break;
      case 'trim':
        this.trimMove(m, pt.x);
        break;
      case 'reorder': {
        const n = this.project?.main.length ?? 0;
        const to = Math.round(m.from + (pt.x - this.cx) / (BLOCK_W + BLOCK_GAP));
        const clamped = Math.min(Math.max(to, 0), n - 1);
        if (clamped !== m.to) haptic();
        this.mode = { ...m, to: clamped, x: pt.x };
        this.invalidate();
        break;
      }
      case 'pinch': {
        if (this.pointers.size < 2) break;
        const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        this.pps = Math.min(Math.max((m.pps * dist) / m.dist, MIN_PPS), MAX_PPS);
        this.invalidate();
        break;
      }
      case 'idle':
        break;
    }
  };

  private trimMove(m: Extract<Mode, { kind: 'trim' }>, x: number): void {
    const dxSec = (x - m.x) / this.pps;
    const editor = useEditor.getState();
    const { base } = m;
    if (m.edge === 'in') {
      editor.apply((p) => trimClip(p, m.clipId, 'in', base.inSec + dxSec * base.speed, m.assetDuration));
      const clip = useEditor.getState().project?.main.find((c) => c.id === m.clipId) ?? base;
      // Keep the handle under the finger: the playhead moves by however far the in-point actually moved.
      const moved = (clip.inSec - base.inSec) / base.speed;
      usePlayback.getState().setTime(Math.max(0, m.time - moved));
      this.cb.onPeek(clip.assetId, clip.inSec);
    } else {
      let target = base.outSec + dxSec * base.speed;
      const p = this.project;
      const start = p ? (clipStarts(p)[p.main.findIndex((c) => c.id === m.clipId)] ?? 0) : 0;
      const edgeX = this.xOf(start + (target - base.inSec) / base.speed);
      if (Math.abs(edgeX - this.cx) < SNAP_PX) target = base.inSec + (this.time - start) * base.speed;
      editor.apply((proj) => trimClip(proj, m.clipId, 'out', target, m.assetDuration));
      const clip = useEditor.getState().project?.main.find((c) => c.id === m.clipId) ?? base;
      this.cb.onPeek(clip.assetId, Math.max(clip.inSec, clip.outSec - 1 / 30));
    }
  }

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    window.clearTimeout(this.longPress);
    const m = this.mode;

    if (m.kind === 'pinch') {
      if (this.pointers.size === 0) this.mode = { kind: 'idle' };
      return;
    }
    if (this.pointers.size > 0) return;

    if (m.kind === 'pending') {
      const hit = this.hitAt(m.x, m.y);
      const editor = useEditor.getState();
      if (!hit) editor.select([]);
      else editor.select(editor.selection.length === 1 && editor.selection[0] === hit.clip.id ? [] : [hit.clip.id]);
    } else if (m.kind === 'pan') {
      this.startInertia(e.timeStamp);
    }
    this.finishGesture(true);
  };

  private finishGesture(commitReorder: boolean): void {
    const m = this.mode;
    if (m.kind === 'trim') {
      useEditor.getState().endGesture();
      this.cb.onPeekEnd();
    } else if (m.kind === 'reorder' && commitReorder && m.to !== m.from) {
      const editor = useEditor.getState();
      const clip = editor.project?.main[m.from];
      editor.apply((p) => moveClip(p, m.from, m.to));
      if (clip) editor.select([clip.id]);
    }
    this.mode = { kind: 'idle' };
    this.invalidate();
  }

  private startInertia(now: number): void {
    const first = this.velocity[0];
    const last = this.velocity[this.velocity.length - 1];
    if (!first || !last || now - last.t > 80 || last.t === first.t) return;
    let v = (last.x - first.x) / (last.t - first.t); // px per ms
    if (Math.abs(v) < 0.25) return;
    let prev = performance.now();
    const step = (ts: number) => {
      const dt = ts - prev;
      prev = ts;
      this.setTime(this.time - (v * dt) / this.pps);
      v *= Math.pow(0.94, dt / 16);
      const p = this.project;
      const atEdge = this.time <= 0 || (p !== null && this.time >= projectDuration(p));
      if (Math.abs(v) > 0.02 && !atEdge) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  // ---- drawing ----

  private sprite(asset: Asset | undefined): ImageBitmap | null {
    if (!asset?.thumbsPath) return null;
    const s = this.sprites.get(asset.id);
    if (s instanceof ImageBitmap) return s;
    if (!s) {
      this.sprites.set(asset.id, 'loading');
      readFile(asset.thumbsPath)
        .then((f) => createImageBitmap(f))
        .then((bmp) => {
          this.sprites.set(asset.id, bmp);
          this.invalidate();
        })
        .catch(() => this.sprites.set(asset.id, 'failed'));
    }
    return null;
  }

  private drawThumb(asset: Asset, sprite: ImageBitmap, sourceSec: number, x: number, y: number, size: number): void {
    const idx = Math.min(asset.thumbCount - 1, Math.max(0, Math.floor(sourceSec / asset.thumbInterval)));
    const sx = (idx % asset.thumbColumns) * asset.thumbSize;
    const sy = Math.floor(idx / asset.thumbColumns) * asset.thumbSize;
    this.ctx.drawImage(sprite, sx, sy, asset.thumbSize, asset.thumbSize, x, y, size, size);
  }

  private draw(): void {
    const { ctx, width: w, height: h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const p = this.project;
    if (!p) return;
    this.drawRuler(p);
    if (this.mode.kind === 'reorder') this.drawReorder(p, this.mode);
    else this.drawTrack(p);
    // Playhead.
    ctx.fillStyle = '#fff';
    ctx.fillRect(this.cx - 1, 4, 2, h - 8);
    ctx.beginPath();
    ctx.moveTo(this.cx - 6, 2);
    ctx.lineTo(this.cx + 6, 2);
    ctx.lineTo(this.cx, 9);
    ctx.fill();
  }

  private drawRuler(p: Project): void {
    const { ctx } = this;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s * this.pps >= 64) ?? 120;
    const minor = step / (step >= 1 && step % 5 === 0 ? 5 : 2);
    const t0 = Math.max(0, this.time - this.cx / this.pps);
    const t1 = Math.min(projectDuration(p) + step, this.time + this.cx / this.pps);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = this.xOf(t);
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = major ? '#a1a1aa' : '#52525b';
      ctx.fillRect(x, RULER_H - (major ? 8 : 4), 1, major ? 8 : 4);
      if (major) ctx.fillText(formatTick(t, step), x + 3, 3);
    }
  }

  private drawTrack(p: Project): void {
    const { ctx } = this;
    const assets = useAssets.getState().assets;
    const selected = new Set(useEditor.getState().selection);
    const starts = clipStarts(p);
    for (let i = 0; i < p.main.length; i++) {
      const clip = p.main[i] as Clip;
      const x0 = this.xOf(starts[i] ?? 0);
      const cw = clipDuration(clip) * this.pps;
      if (x0 > this.width || x0 + cw < 0) continue;
      const asset = assets[clip.assetId];
      const x = x0 + 1;
      const wInner = Math.max(1, cw - 2);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, TRACK_Y, wInner, TRACK_H, 6);
      ctx.clip();
      ctx.fillStyle = '#27272a';
      ctx.fillRect(x, TRACK_Y, wInner, TRACK_H);
      const sprite = this.sprite(asset);
      if (asset && sprite) {
        const firstTile = Math.max(0, Math.floor(-x / TRACK_H));
        for (let tx = x + firstTile * TRACK_H; tx < Math.min(x + wInner, this.width); tx += TRACK_H) {
          const localSec = (tx - x + TRACK_H / 2) / this.pps;
          this.drawThumb(asset, sprite, clip.inSec + localSec * clip.speed, tx, TRACK_Y, TRACK_H);
        }
      }
      if (asset?.status === 'importing') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x, TRACK_Y, wInner, TRACK_H);
        ctx.fillStyle = '#ec4899';
        ctx.fillRect(x, TRACK_Y + TRACK_H - 4, wInner * asset.progress, 4);
        this.label(`Preparing ${Math.round(asset.progress * 100)}%`, x + 6, TRACK_Y + 6);
      } else if (asset?.status === 'error') {
        ctx.fillStyle = 'rgba(127,29,29,0.6)';
        ctx.fillRect(x, TRACK_Y, wInner, TRACK_H);
        this.label('⚠︎ not prepared · tap for details', x + 6, TRACK_Y + 6);
      }
      if (clip.speed !== 1) this.label(`${+clip.speed.toFixed(2)}×`, x + 6, TRACK_Y + TRACK_H - 22);
      ctx.restore();

      if (selected.has(clip.id)) this.drawSelection(x, wInner, selected.size === 1);
    }
  }

  private drawSelection(x: number, w: number, handles: boolean): void {
    const { ctx } = this;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, TRACK_Y, w, TRACK_H, 6);
    ctx.stroke();
    if (!handles) return;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(x, TRACK_Y, HANDLE_W, TRACK_H, [6, 0, 0, 6]);
    ctx.roundRect(x + w - HANDLE_W, TRACK_Y, HANDLE_W, TRACK_H, [0, 6, 6, 0]);
    ctx.fill();
    ctx.fillStyle = '#18181b';
    ctx.fillRect(x + HANDLE_W / 2 - 1, TRACK_Y + TRACK_H / 2 - 10, 2, 20);
    ctx.fillRect(x + w - HANDLE_W / 2 - 1, TRACK_Y + TRACK_H / 2 - 10, 2, 20);
  }

  private label(text: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.font = '600 11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 2, tw + 6, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }

  private drawReorder(p: Project, m: Extract<Mode, { kind: 'reorder' }>): void {
    const { ctx } = this;
    const assets = useAssets.getState().assets;
    const size = BLOCK_W;
    const y = TRACK_Y + (TRACK_H - size) / 2;
    const slot = (i: number) => this.cx - size / 2 + (i - m.from) * (size + BLOCK_GAP);
    const order = p.main.map((_, i) => i).filter((i) => i !== m.from);
    order.splice(m.to, 0, m.from);
    const drawBlock = (clip: Clip, x: number, by: number) => {
      const asset = assets[clip.assetId];
      const sprite = this.sprite(asset);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, by, size, size, 6);
      ctx.clip();
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(x, by, size, size);
      if (asset && sprite) this.drawThumb(asset, sprite, clip.inSec, x, by, size);
      ctx.restore();
    };
    order.forEach((clipIndex, position) => {
      if (clipIndex !== m.from) drawBlock(p.main[clipIndex] as Clip, slot(position), y);
    });
    const dragged = p.main[m.from] as Clip;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 12;
    drawBlock(dragged, m.x - size / 2, y - 6);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ec4899';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(m.x - size / 2, y - 6, size, size, 6);
    ctx.stroke();
  }
}

export function TimelineView(props: TimelineCallbacks) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cbRef = useRef(props);
  cbRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new TimelineController(canvas, {
      onInteract: () => cbRef.current.onInteract(),
      onPeek: (a, s) => cbRef.current.onPeek(a, s),
      onPeekEnd: () => cbRef.current.onPeekEnd(),
    });
    const ro = new ResizeObserver(([entry]) => {
      if (entry) controller.resize(entry.contentRect.width);
    });
    ro.observe(canvas);
    return () => {
      ro.disconnect();
      controller.destroy();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="timeline"
      className="block w-full touch-none"
      style={{ height: TIMELINE_HEIGHT }}
    />
  );
}
