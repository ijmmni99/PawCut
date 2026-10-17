// Preview playback over the main track using two <video> elements fed by the 540p proxies:
// one plays the current clip while the other is preloaded and parked on the next clip's in-point, so cuts swap
// instantly. iOS decodes <video> in hardware, which keeps the main thread free for the timeline.
// Scrub seeks are coalesced: only the latest requested time is sought once the previous seek lands.
import { useAssets, useEditor, usePlayback } from '../store';
import { type Asset, type Project, clipDuration, clipStarts, locate } from '../timeline/model';
import { readFile } from '../../engine/storage/opfs';
import { type Compositor, createCompositor } from './compositor';

type Slot = {
  el: HTMLVideoElement;
  /** What the element is (or will be) showing: asset + source second. */
  assetId: string | null;
  url: string | null;
  target: number | null;
  seeking: boolean;
};

type SourceUrl = { url: string; kind: 'proxy' | 'original' };

/** Cut tolerance: half a frame at 30fps. */
const END_EPS = 1 / 60;
const PRELOAD_SEC = 1.5;

function makeVideo(): HTMLVideoElement {
  const el = document.createElement('video');
  el.playsInline = true;
  el.preload = 'auto';
  el.muted = false;
  el.disableRemotePlayback = true;
  // Match export: speed changes shift pitch.
  el.preservesPitch = false;
  return el;
}

export class PreviewPlayer {
  private readonly compositor: Compositor;
  private readonly slots: [Slot, Slot];
  private active: 0 | 1 = 0;
  private playingIndex = -1;
  private raf = 0;
  private unlocked = false;
  private readonly urls = new Map<string, SourceUrl>();
  private readonly pendingUrls = new Map<string, Promise<SourceUrl | null>>();
  private readonly unsubscribers: Array<() => void> = [];
  private destroyed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.compositor = createCompositor(canvas);
    this.slots = [this.makeSlot(), this.makeSlot()];

    // While paused, follow the playhead (scrubbing) and re-show the frame after edits.
    this.unsubscribers.push(
      usePlayback.subscribe((s, prev) => {
        if (!s.playing && s.time !== prev.time) this.showTime(s.time);
      }),
      useEditor.subscribe((s, prev) => {
        if (s.project !== prev.project) {
          if (usePlayback.getState().playing) this.pause();
          this.clampTime();
          this.showTime(usePlayback.getState().time);
        }
      }),
      useAssets.subscribe((s, prev) => {
        if (s.assets !== prev.assets && !usePlayback.getState().playing) this.showTime(usePlayback.getState().time);
      }),
    );
  }

  private get current(): Slot {
    return this.slots[this.active];
  }

  private get spare(): Slot {
    return this.slots[this.active === 0 ? 1 : 0];
  }

  private makeSlot(): Slot {
    const slot: Slot = { el: makeVideo(), assetId: null, url: null, target: null, seeking: false };
    slot.el.addEventListener('seeked', () => {
      slot.seeking = false;
      if (slot.target !== null && Math.abs(slot.el.currentTime - slot.target) > 0.02) this.seekSlot(slot, slot.target);
      if (slot === this.current) this.draw();
    });
    slot.el.addEventListener('loadeddata', () => {
      if (slot.target !== null) this.seekSlot(slot, slot.target);
      if (slot === this.current) this.draw();
    });
    return slot;
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // No point rendering above the 540p proxy resolution times ~1.5.
    const scale = Math.min(dpr, 810 / Math.max(1, cssWidth));
    this.compositor.resize(Math.round(cssWidth * scale), Math.round(cssHeight * scale));
    this.draw();
  }

  private project(): Project | null {
    return useEditor.getState().project;
  }

  private clampTime(): void {
    const p = this.project();
    if (!p) return;
    const total = p.main.reduce((s, c) => s + clipDuration(c), 0);
    const { time, setTime } = usePlayback.getState();
    if (time > total) setTime(total);
  }

  /** Resolves (and caches) a playable URL for an asset: proxy when ready, otherwise the OPFS original. */
  private sourceUrl(asset: Asset): SourceUrl | null {
    const wanted: SourceUrl['kind'] | null = asset.proxyPath ? 'proxy' : asset.originalPath ? 'original' : null;
    if (!wanted) return null;
    const cached = this.urls.get(asset.id);
    if (cached?.kind === wanted) return cached;
    const key = `${asset.id}:${wanted}`;
    if (!this.pendingUrls.has(key)) {
      const path = wanted === 'proxy' ? asset.proxyPath : asset.originalPath;
      const pending = readFile(path as string)
        .then((file) => {
          if (this.destroyed) return null;
          const entry: SourceUrl = { url: URL.createObjectURL(file), kind: wanted };
          // Old URL stays valid until no slot uses it; revoked on destroy.
          this.urls.set(asset.id, entry);
          if (!usePlayback.getState().playing) this.showTime(usePlayback.getState().time);
          return entry;
        })
        .catch(() => null);
      this.pendingUrls.set(key, pending);
    }
    return cached ?? null;
  }

  /** Points a slot at asset/second. Returns false if the asset has no playable source yet. */
  private load(slot: Slot, assetId: string, sec: number): boolean {
    const asset = useAssets.getState().assets[assetId];
    const source = asset ? this.sourceUrl(asset) : null;
    if (!source) return false;
    if (slot.url !== source.url) {
      slot.url = source.url;
      slot.assetId = assetId;
      slot.seeking = false;
      slot.el.src = source.url;
      slot.el.load();
    }
    this.seekSlot(slot, sec);
    return true;
  }

  private seekSlot(slot: Slot, sec: number): void {
    slot.target = sec;
    if (slot.seeking || slot.el.readyState < 1) return;
    if (Math.abs(slot.el.currentTime - sec) < 0.001) return;
    slot.seeking = true;
    slot.el.currentTime = sec;
  }

  private draw(): void {
    const slot = this.current;
    this.compositor.draw(slot.assetId ? slot.el : null);
  }

  /** Shows the frame at timeline time `t` (paused). */
  showTime(t: number): void {
    const p = this.project();
    const hit = p ? locate(p, t) : null;
    if (!hit) {
      this.current.assetId = null;
      this.draw();
      return;
    }
    if (!this.load(this.current, hit.clip.assetId, hit.sourceSec)) this.draw();
  }

  /** Shows a specific source frame, e.g. the edge being trimmed. */
  peek(assetId: string, sourceSec: number): void {
    if (usePlayback.getState().playing) this.pause();
    this.load(this.current, assetId, sourceSec);
  }

  /** Must be called from a user gesture (iOS autoplay rules). */
  play(): void {
    const p = this.project();
    if (!p || p.main.length === 0) return;
    const total = p.main.reduce((s, c) => s + clipDuration(c), 0);
    const playback = usePlayback.getState();
    let t = playback.time;
    if (t >= total - END_EPS) t = 0;
    const hit = locate(p, t);
    if (!hit) return;

    if (!this.unlocked) {
      // Unlock both elements for audio while we're inside the gesture.
      const other = this.spare;
      if (!other.el.src) this.load(other, hit.clip.assetId, hit.sourceSec);
      if (other.el.src) {
        void other.el.play().catch(() => undefined);
        other.el.pause();
      }
      this.unlocked = true;
    }

    const slot = this.current;
    if (!this.load(slot, hit.clip.assetId, hit.sourceSec)) return;
    slot.el.playbackRate = hit.clip.speed;
    this.playingIndex = hit.index;
    playback.setTime(t);
    playback.setPlaying(true);
    void slot.el.play().catch(() => this.pause());
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    for (const s of this.slots) s.el.pause();
    this.playingIndex = -1;
    usePlayback.getState().setPlaying(false);
  }

  toggle(): void {
    if (usePlayback.getState().playing) this.pause();
    else this.play();
  }

  private readonly tick = () => {
    const p = this.project();
    const clip = p?.main[this.playingIndex];
    if (!p || !clip) {
      this.pause();
      return;
    }
    const starts = clipStarts(p);
    const start = starts[this.playingIndex] ?? 0;
    const slot = this.current;
    const el = slot.el;
    const remaining = (clip.outSec - el.currentTime) / clip.speed;
    const next = p.main[this.playingIndex + 1];
    const other = this.spare;

    if (next && remaining < PRELOAD_SEC && (other.assetId !== next.assetId || other.target !== next.inSec)) {
      this.load(other, next.assetId, next.inSec);
    }

    if (el.ended || el.currentTime >= clip.outSec - END_EPS) {
      if (!next) {
        this.pause();
        usePlayback.getState().setTime(start + clipDuration(clip));
        return;
      }
      // Cut: swap to the preloaded element.
      el.pause();
      if (!this.load(other, next.assetId, next.inSec)) {
        this.pause();
        return;
      }
      this.active = this.active === 0 ? 1 : 0;
      this.playingIndex++;
      other.el.playbackRate = next.speed;
      void other.el.play().catch(() => {
        // Autoplay with sound refused (element never unlocked): keep the picture going, silently.
        other.el.muted = true;
        void other.el.play().catch(() => this.pause());
      });
      usePlayback.getState().setTime(starts[this.playingIndex] ?? 0);
    } else {
      const t = start + Math.max(0, el.currentTime - clip.inSec) / clip.speed;
      usePlayback.getState().setTime(t);
    }
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    this.destroyed = true;
    this.pause();
    for (const u of this.unsubscribers) u();
    for (const s of this.slots) {
      s.el.removeAttribute('src');
      s.el.load();
    }
    for (const { url } of this.urls.values()) URL.revokeObjectURL(url);
    this.compositor.destroy();
    void this.canvas;
  }
}
