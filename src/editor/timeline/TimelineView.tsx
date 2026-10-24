// Canvas timeline (no per-clip DOM). The playhead is fixed at the horizontal centre; the track scrolls under it.
// Rows: the magnetic video track, then text overlays and captions (when present), then one row per audio track in
// use (music, SFX, voiceover). Text clips move/trim like audio clips; tapping captions selects the whole track.
// Gestures: drag = scrub (with inertia), pinch = zoom, tap = select, drag a selected clip's handle = trim,
// long-press a video clip = reorder, drag a selected audio clip = move. Edges snap to the playhead, cuts,
// other audio clips and music beats.
import { useEffect, useRef } from 'react';
import { readFile } from '../../engine/storage/opfs';
import { useLibrary } from '../../library/audioLibrary';
import { type CaptionChunk, captionChunks, joinWords } from '../overlay/captions';
import { CAPTIONS_ID, moveText, textsOf, trimText } from '../overlay/textOps';
import { TRANSITIONS, cutsWithTransitions } from './transitions';
import { useAssets, useEditor, usePlayback } from '../store';
import {
  AUDIO_TRACKS,
  audioClips,
  audioEnd,
  moveAudioClip,
  nearest,
  timelineBeats,
  trimAudioClip,
} from './audio';
import {
  type Asset,
  type AudioClip,
  type AudioTrackKind,
  type Clip,
  type Project,
  type TextItem,
  clipDuration,
  clipStarts,
  moveClip,
  projectDuration,
  trimClip,
} from './model';

const RULER_H = 22;
const TRACK_Y = 30;
const TRACK_H = 64;
const AROW_H = 34;
const AROW_GAP = 6;
const AUDIO_Y = TRACK_Y + TRACK_H + 10;

const TRACK_COLORS: Record<AudioTrackKind, { fill: string; wave: string; label: string }> = {
  music: { fill: '#4c1d95', wave: '#c4b5fd', label: '♫' },
  sfx: { fill: '#075985', wave: '#7dd3fc', label: '✦' },
  voice: { fill: '#78350f', wave: '#fcd34d', label: '🎙' },
};

type Lane = 'text' | 'captions' | AudioTrackKind;

/** Rows under the video: text, captions, then audio tracks — only those in use, in fixed order. */
export function laneRows(p: Project | null): Lane[] {
  if (!p) return [];
  const clips = audioClips(p);
  return [
    ...(textsOf(p).length > 0 ? (['text'] as const) : []),
    ...((p.captions?.words.length ?? 0) > 0 ? (['captions'] as const) : []),
    ...AUDIO_TRACKS.filter((k) => clips.some((c) => c.track === k)),
  ];
}

export function timelineHeight(p: Project | null): number {
  const rows = laneRows(p).length;
  return rows === 0 ? TRACK_Y + TRACK_H + 16 : AUDIO_Y + rows * (AROW_H + AROW_GAP) + 6;
}
const HANDLE_W = 18;
const MIN_PPS = 6;
const MAX_PPS = 600;
const DRAG_SLOP = 6;
const LONG_PRESS_MS = 380;
const SNAP_PX = 10;
const BLOCK_W = 56;
const BLOCK_GAP = 6;

type Hit = { index: number; clip: Clip; start: number; x0: number; w: number };
type AudioHit = { clip: AudioClip; x0: number; w: number; y: number };

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; x: number; y: number; time: number }
  | { kind: 'pan'; x: number; time: number }
  | { kind: 'trim'; edge: 'in' | 'out'; clipId: string; x: number; time: number; base: Clip; assetDuration: number }
  | { kind: 'reorder'; from: number; to: number; x: number }
  | { kind: 'moveAudio'; clipId: string; x: number; base: AudioClip }
  | { kind: 'trimAudio'; clipId: string; edge: 'in' | 'out'; x: number; base: AudioClip; sourceDuration: number }
  | { kind: 'moveText'; id: string; x: number; base: TextItem }
  | { kind: 'trimText'; id: string; edge: 'in' | 'out'; x: number; base: TextItem }
  | { kind: 'pinch'; dist: number; pps: number };

export type TimelineCallbacks = {
  /** User started touching the timeline: playback should stop. */
  onInteract(): void;
  /** Show a source frame while trimming. */
  onPeek(assetId: string, sourceSec: number): void;
  /** Trimming finished: show the playhead frame again. */
  onPeekEnd(): void;
  /** The transition marker between clip `index` and the next was tapped. */
  onCutTap(index: number): void;
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
  private height = timelineHeight(null);
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
    this.unsub.push(
      useEditor.subscribe(mark),
      useAssets.subscribe(mark),
      usePlayback.subscribe(mark),
      useLibrary.subscribe(mark),
    );
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

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = cssWidth;
    this.height = cssHeight;
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

  private rowY(kind: Lane): number | null {
    const i = laneRows(this.project).indexOf(kind);
    return i < 0 ? null : AUDIO_Y + i * (AROW_H + AROW_GAP);
  }

  private audioHitAt(x: number, y: number): AudioHit | null {
    const p = this.project;
    if (!p) return null;
    // Later clips draw on top, so they win.
    const clips = audioClips(p);
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i] as AudioClip;
      const ry = this.rowY(clip.track);
      if (ry === null || y < ry - 4 || y > ry + AROW_H + 4) continue;
      const x0 = this.xOf(clip.start);
      const w = (clip.outSec - clip.inSec) * this.pps;
      if (x >= x0 && x <= x0 + w) return { clip, x0, w, y: ry };
    }
    return null;
  }

  private audioHandleAt(x: number, y: number): { edge: 'in' | 'out'; clip: AudioClip } | null {
    const p = this.project;
    const selected = useEditor.getState().selection;
    if (!p || selected.length !== 1) return null;
    const clip = audioClips(p).find((c) => c.id === selected[0]);
    const ry = clip ? this.rowY(clip.track) : null;
    if (!clip || ry === null || y < ry - 8 || y > ry + AROW_H + 8) return null;
    const x0 = this.xOf(clip.start);
    const w = (clip.outSec - clip.inSec) * this.pps;
    if (x >= x0 - 12 && x <= x0 + 12) return { edge: 'in', clip };
    if (x >= x0 + w - 12 && x <= x0 + w + 12) return { edge: 'out', clip };
    return null;
  }

  /** Transition marker between two video clips (small square on the cut). */
  private cutMarkerAt(x: number, y: number): number | null {
    const p = this.project;
    if (!p || p.main.length < 2 || Math.abs(y - (TRACK_Y + TRACK_H / 2)) > 18) return null;
    const starts = clipStarts(p);
    for (let i = 1; i < p.main.length; i++) {
      if (Math.abs(x - this.xOf(starts[i] ?? 0)) <= 15) return i - 1;
    }
    return null;
  }

  private textHitAt(x: number, y: number): TextItem | null {
    const p = this.project;
    const ry = this.rowY('text');
    if (!p || ry === null || y < ry - 4 || y > ry + AROW_H + 4) return null;
    const texts = textsOf(p);
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i] as TextItem;
      const x0 = this.xOf(t.start);
      if (x >= x0 && x <= x0 + t.duration * this.pps) return t;
    }
    return null;
  }

  private textHandleAt(x: number, y: number): { edge: 'in' | 'out'; item: TextItem } | null {
    const p = this.project;
    const selected = useEditor.getState().selection;
    const ry = this.rowY('text');
    if (!p || selected.length !== 1 || ry === null || y < ry - 8 || y > ry + AROW_H + 8) return null;
    const item = textsOf(p).find((t) => t.id === selected[0]);
    if (!item) return null;
    const x0 = this.xOf(item.start);
    const x1 = x0 + item.duration * this.pps;
    if (x >= x0 - 12 && x <= x0 + 12) return { edge: 'in', item };
    if (x >= x1 - 12 && x <= x1 + 12) return { edge: 'out', item };
    return null;
  }

  private captionsHitAt(y: number): boolean {
    const ry = this.rowY('captions');
    return ry !== null && y >= ry - 4 && y <= ry + AROW_H + 4;
  }

  private beats(): number[] {
    const p = this.project;
    const items = useLibrary.getState().items;
    return p ? timelineBeats(p, (id) => items[id]?.beats) : [];
  }

  /** Snap `t` to the playhead, a cut, another audio clip's edge or a beat, if within SNAP_PX. */
  /** `mainTrimIndex`: a main clip being trimmed — its own end and every later cut move with it, so skip them. */
  private snapTime(t: number, excludeId?: string, mainTrimIndex?: number): number {
    const p = this.project;
    if (!p) return t;
    const starts = clipStarts(p);
    const points = [
      this.time,
      0,
      ...(mainTrimIndex === undefined ? [...starts, projectDuration(p)] : starts.slice(0, mainTrimIndex + 1)),
      ...audioClips(p)
        .filter((c) => c.id !== excludeId)
        .flatMap((c) => [c.start, audioEnd(c)]),
      ...textsOf(p)
        .filter((t) => t.id !== excludeId)
        .flatMap((t) => [t.start, t.start + t.duration]),
      ...this.beats(),
    ];
    const hit = nearest(points, t, SNAP_PX / this.pps);
    if (hit !== null && hit !== t) haptic();
    return hit ?? t;
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

    const audioHandle = this.audioHandleAt(pt.x, pt.y);
    if (audioHandle) {
      const item = useLibrary.getState().items[audioHandle.clip.sourceId];
      useEditor.getState().beginGesture();
      this.mode = {
        kind: 'trimAudio',
        clipId: audioHandle.clip.id,
        edge: audioHandle.edge,
        x: pt.x,
        base: audioHandle.clip,
        sourceDuration: item?.durationSec ?? audioHandle.clip.outSec,
      };
      haptic();
      return;
    }
    const textHandle = this.textHandleAt(pt.x, pt.y);
    if (textHandle) {
      useEditor.getState().beginGesture();
      this.mode = { kind: 'trimText', id: textHandle.item.id, edge: textHandle.edge, x: pt.x, base: textHandle.item };
      haptic();
      return;
    }
    const selection = useEditor.getState().selection;
    const textHit = this.textHitAt(pt.x, pt.y);
    if (textHit && selection.length === 1 && selection[0] === textHit.id) {
      useEditor.getState().beginGesture();
      this.mode = { kind: 'moveText', id: textHit.id, x: pt.x, base: textHit };
      return;
    }
    const audioHit = this.audioHitAt(pt.x, pt.y);
    if (audioHit && selection.length === 1 && selection[0] === audioHit.clip.id) {
      useEditor.getState().beginGesture();
      this.mode = { kind: 'moveAudio', clipId: audioHit.clip.id, x: pt.x, base: audioHit.clip };
      return;
    }

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
      case 'moveAudio': {
        const len = m.base.outSec - m.base.inSec;
        let start = Math.max(0, m.base.start + (pt.x - m.x) / this.pps);
        // Snap whichever edge is closer to something.
        const s0 = this.snapTime(start, m.clipId);
        const s1 = this.snapTime(start + len, m.clipId) - len;
        start = Math.abs(s0 - start) <= Math.abs(s1 - start) || s1 === start ? s0 : s1;
        useEditor.getState().apply((p) => moveAudioClip(p, m.clipId, start));
        break;
      }
      case 'trimAudio': {
        const base = m.edge === 'in' ? m.base.start : audioEnd(m.base);
        const t = this.snapTime(base + (pt.x - m.x) / this.pps, m.clipId);
        useEditor.getState().apply((p) => trimAudioClip(p, m.clipId, m.edge, t, m.sourceDuration));
        break;
      }
      case 'moveText': {
        const len = m.base.duration;
        let start = Math.max(0, m.base.start + (pt.x - m.x) / this.pps);
        const s0 = this.snapTime(start, m.id);
        const s1 = this.snapTime(start + len, m.id) - len;
        start = Math.abs(s0 - start) <= Math.abs(s1 - start) || s1 === start ? s0 : s1;
        useEditor.getState().apply((p) => moveText(p, m.id, start));
        break;
      }
      case 'trimText': {
        const base = m.edge === 'in' ? m.base.start : m.base.start + m.base.duration;
        const t = this.snapTime(base + (pt.x - m.x) / this.pps, m.id);
        useEditor.getState().apply((p) => trimText(p, m.id, m.edge, t));
        break;
      }
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
      const index = p ? p.main.findIndex((c) => c.id === m.clipId) : 0;
      const start = p ? (clipStarts(p)[index] ?? 0) : 0;
      const edgeT = start + (target - base.inSec) / base.speed;
      const snapped = this.snapTime(edgeT, m.clipId, index);
      if (snapped !== edgeT) target = base.inSec + (snapped - start) * base.speed;
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
      const cut = this.cutMarkerAt(m.x, m.y);
      if (cut !== null) {
        this.finishGesture(true);
        this.cb.onCutTap(cut);
        return;
      }
      const id =
        this.textHitAt(m.x, m.y)?.id ??
        (this.captionsHitAt(m.y) ? CAPTIONS_ID : undefined) ??
        this.audioHitAt(m.x, m.y)?.clip.id ??
        this.hitAt(m.x, m.y)?.clip.id;
      const editor = useEditor.getState();
      if (!id) editor.select([]);
      else editor.select(editor.selection.length === 1 && editor.selection[0] === id ? [] : [id]);
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
    } else if (m.kind === 'moveAudio' || m.kind === 'trimAudio' || m.kind === 'moveText' || m.kind === 'trimText') {
      useEditor.getState().endGesture();
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
    if (this.mode.kind !== 'reorder') this.drawCutMarkers(p);
    this.drawTexts(p);
    this.drawCaptions(p);
    this.drawAudio(p);
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

  private drawAudio(p: Project): void {
    const { ctx } = this;
    const items = useLibrary.getState().items;
    const selected = new Set(useEditor.getState().selection);
    for (const kind of laneRows(p)) {
      if (kind === 'text' || kind === 'captions') continue;
      const y = this.rowY(kind) as number;
      const color = TRACK_COLORS[kind];
      ctx.fillStyle = '#18181b';
      ctx.fillRect(0, y, this.width, AROW_H);
      for (const clip of audioClips(p).filter((c) => c.track === kind)) {
        const x0 = this.xOf(clip.start);
        const w = Math.max(2, (clip.outSec - clip.inSec) * this.pps);
        if (x0 > this.width || x0 + w < 0) continue;
        const item = items[clip.sourceId];
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x0, y, w, AROW_H, 5);
        ctx.clip();
        ctx.fillStyle = color.fill;
        ctx.fillRect(x0, y, w, AROW_H);
        // Waveform: the item's peaks mapped over the source window.
        if (item && item.waveform.length > 0 && item.durationSec > 0) {
          ctx.fillStyle = color.wave;
          const n = item.waveform.length;
          const from = Math.max(x0, 0);
          const to = Math.min(x0 + w, this.width);
          for (let x = from; x < to; x += 3) {
            const src = clip.inSec + (x - x0) / this.pps;
            const peak = item.waveform[Math.min(n - 1, Math.floor((src / item.durationSec) * n))] ?? 0;
            const h = Math.max(1, peak * (AROW_H - 8) * clip.volume);
            ctx.fillRect(x, y + (AROW_H - h) / 2, 2, h);
          }
        }
        // Fades as dark wedges.
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        if (clip.fadeIn > 0) {
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x0 + clip.fadeIn * this.pps, y);
          ctx.lineTo(x0, y + AROW_H);
          ctx.fill();
        }
        if (clip.fadeOut > 0) {
          ctx.beginPath();
          ctx.moveTo(x0 + w, y);
          ctx.lineTo(x0 + w - clip.fadeOut * this.pps, y);
          ctx.lineTo(x0 + w, y + AROW_H);
          ctx.fill();
        }
        this.label(`${color.label} ${item?.title ?? '…'}`, Math.max(x0, 0) + 6, y + 3);
        ctx.restore();
        if (selected.has(clip.id)) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(x0, y, w, AROW_H, 5);
          ctx.stroke();
          if (selected.size === 1) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(x0, y, 6, AROW_H);
            ctx.fillRect(x0 + w - 6, y, 6, AROW_H);
          }
        }
      }
      // Beat ticks along the music row.
      if (kind === 'music') {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        for (const b of this.beats()) {
          const x = this.xOf(b);
          if (x >= 0 && x <= this.width) ctx.fillRect(x, y + AROW_H - 5, 1, 5);
        }
      }
    }
  }

  /** Transition windows as a light band, and a tappable marker on every cut. */
  private drawCutMarkers(p: Project): void {
    if (p.main.length < 2) return;
    const { ctx } = this;
    const starts = clipStarts(p);
    for (const c of cutsWithTransitions(p)) {
      const x0 = this.xOf(c.time - c.duration / 2);
      ctx.fillStyle = 'rgba(236,72,153,0.35)';
      ctx.fillRect(x0, TRACK_Y + TRACK_H - 8, c.duration * this.pps, 8);
    }
    const s = 22;
    for (let i = 1; i < p.main.length; i++) {
      const x = this.xOf(starts[i] ?? 0);
      if (x < -s || x > this.width + s) continue;
      const kind = (p.main[i - 1] as Clip).transition?.kind;
      const y = TRACK_Y + TRACK_H / 2 - s / 2;
      ctx.fillStyle = kind ? '#ec4899' : 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.roundRect(x - s / 2, y, s, s, 6);
      ctx.fill();
      ctx.font = '600 13px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = kind ? '#fff' : '#18181b';
      ctx.fillText(kind ? (TRANSITIONS.find((t) => t.id === kind)?.icon ?? '⧉') : '+', x, y + s / 2 + 1);
      ctx.textAlign = 'start';
    }
  }

  private drawTexts(p: Project): void {
    const y = this.rowY('text');
    if (y === null) return;
    const { ctx } = this;
    const selected = new Set(useEditor.getState().selection);
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, y, this.width, AROW_H);
    for (const t of textsOf(p)) {
      const x0 = this.xOf(t.start);
      const w = Math.max(4, t.duration * this.pps);
      if (x0 > this.width || x0 + w < 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, y, w, AROW_H, 5);
      ctx.clip();
      ctx.fillStyle = '#9d174d';
      ctx.fillRect(x0, y, w, AROW_H);
      this.label(`T ${t.text.replace(/\s+/g, ' ')}`, Math.max(x0, 0) + 6, y + 9);
      ctx.restore();
      if (selected.has(t.id)) this.drawLaneSelection(x0, y, w, selected.size === 1);
    }
  }

  private drawCaptions(p: Project): void {
    const y = this.rowY('captions');
    const c = p.captions;
    if (y === null || !c) return;
    const { ctx } = this;
    const selected = useEditor.getState().selection.includes(CAPTIONS_ID);
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, y, this.width, AROW_H);
    captionChunks(c).forEach((ch: CaptionChunk, k) => {
      const x0 = this.xOf(ch.start);
      const w = Math.max(3, (ch.end - ch.start) * this.pps - 1);
      if (x0 > this.width || x0 + w < 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, y, w, AROW_H, 4);
      ctx.clip();
      ctx.fillStyle = k % 2 ? '#115e59' : '#0f766e';
      ctx.fillRect(x0, y, w, AROW_H);
      if (w > 24) this.label(joinWords(c.words.slice(ch.first, ch.last + 1).map((wd) => wd.text)), x0 + 4, y + 9);
      ctx.restore();
    });
    if (selected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, y, this.width - 2, AROW_H);
    }
  }

  private drawLaneSelection(x0: number, y: number, w: number, handles: boolean): void {
    const { ctx } = this;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x0, y, w, AROW_H, 5);
    ctx.stroke();
    if (handles) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x0, y, 6, AROW_H);
      ctx.fillRect(x0 + w - 6, y, 6, AROW_H);
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
  const height = useEditor((s) => timelineHeight(s.project));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new TimelineController(canvas, {
      onInteract: () => cbRef.current.onInteract(),
      onPeek: (a, s) => cbRef.current.onPeek(a, s),
      onPeekEnd: () => cbRef.current.onPeekEnd(),
      onCutTap: (i) => cbRef.current.onCutTap(i),
    });
    const ro = new ResizeObserver(([entry]) => {
      if (entry) controller.resize(entry.contentRect.width, entry.contentRect.height);
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
      style={{ height }}
    />
  );
}
