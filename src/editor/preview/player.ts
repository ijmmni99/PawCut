// Preview playback. A worker decodes the proxies with WebCodecs and streams frames + PCM ahead of the playhead;
// this side schedules the audio sample-accurately on an AudioContext and uses that audio clock to pick which
// frame to show each animation frame. Because frames after a cut are decoded before the cut is reached, cuts are
// seamless (no element switching or play() start-up latency, which is what made <video>-based cuts stutter on iOS).
// While paused, scrubbing requests single stills; the worker only decodes the latest request.
import { useAssets, useEditor, usePlayback } from '../store';
import { locate, projectDuration } from '../timeline/model';
import { type Compositor, type FrameSource, createCompositor } from './compositor';
import type { PreviewEvent, PreviewRequest } from './protocol';

type QueuedFrame = FrameSource & { t: number };
type AudioChunk = Extract<PreviewEvent, { type: 'audio' }>;

/** Wait at most this long for the first audio chunk before starting the clock. */
const AUDIO_GRACE_MS = 250;
/** Frames buffered before the clock starts, so the decoder is ahead from the first frame. */
const START_FRAMES = 6;
/** ...unless the stream is shorter than that or the decoder is slow: start anyway after this long. */
const START_MAX_WAIT_MS = 400;
/** Start the clock slightly in the future so the first audio buffer is never late. */
const START_LEAD_SEC = 0.05;
const ACK_EVERY_FRAMES = 4;
const ACK_EVERY_MS = 200;

type State = 'paused' | 'starting' | 'playing';

/** Playback smoothness counters (read by e2e tests; reset on every play). */
export const previewStats = { shown: 0, dropped: 0, maxGapMs: 0, maxGapAt: 0, lastShowAt: 0, lastError: '' };

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export class PreviewPlayer {
  private readonly compositor: Compositor;
  private readonly worker: Worker;
  private readonly unsubscribers: Array<() => void> = [];
  private shown: FrameSource | null = null;
  private queue: QueuedFrame[] = [];
  private pendingAudio: AudioChunk[] = [];
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private state: State = 'paused';
  private gen = 0;
  private stillId = 0;
  private shownStillId = 0;
  private from = 0;
  private ctxStart = 0;
  private playRequestedAt = 0;
  private gotAudio = false;
  private streamEnded = false;
  private consumed = 0;
  private lastAck = 0;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.compositor = createCompositor(canvas);
    this.worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<PreviewEvent>) => this.onEvent(e.data);
    this.sync();

    this.unsubscribers.push(
      usePlayback.subscribe((s, prev) => {
        if (this.state === 'paused' && s.time !== prev.time) this.showTime(s.time);
      }),
      useEditor.subscribe((s, prev) => {
        if (s.project === prev.project) return;
        this.sync();
        if (this.state !== 'paused') this.pause();
        this.clampTime();
        this.showTime(usePlayback.getState().time);
      }),
      useAssets.subscribe((s, prev) => {
        if (s.assets === prev.assets) return;
        this.sync();
        if (this.state === 'paused') this.showTime(usePlayback.getState().time);
      }),
    );
  }

  private send(msg: PreviewRequest): void {
    this.worker.postMessage(msg);
  }

  private sync(): void {
    const project = useEditor.getState().project;
    if (project) this.send({ type: 'sync', project, assets: useAssets.getState().assets });
  }

  private clampTime(): void {
    const project = useEditor.getState().project;
    if (!project) return;
    const { time, setTime } = usePlayback.getState();
    const total = projectDuration(project);
    if (time > total) setTime(total);
  }

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // No point rendering far above the 540p proxy resolution.
    const scale = Math.min(dpr, 810 / Math.max(1, cssWidth));
    this.compositor.resize(Math.round(cssWidth * scale), Math.round(cssHeight * scale));
    this.compositor.draw(this.shown);
  }

  private show(source: FrameSource | null): void {
    if (this.shown && this.shown !== source) this.shown.frame.close();
    this.shown = source;
    this.compositor.draw(source);
  }

  // ---- stills ----

  /** Shows the frame at timeline time `t` (paused). */
  showTime(t: number): void {
    const project = useEditor.getState().project;
    const hit = project ? locate(project, t) : null;
    if (!hit) {
      this.show(null);
      return;
    }
    this.requestStill(hit.clip.assetId, hit.sourceSec);
  }

  /** Shows a specific source frame, e.g. the edge being trimmed. */
  peek(assetId: string, sourceSec: number): void {
    if (this.state !== 'paused') this.pause();
    this.requestStill(assetId, sourceSec);
  }

  private requestStill(assetId: string, sourceSec: number): void {
    this.send({ type: 'still', id: ++this.stillId, assetId, sourceSec });
  }

  // ---- playback ----

  /** Must be called from a user gesture: it creates/resumes the AudioContext (iOS autoplay rules). */
  play(): void {
    const project = useEditor.getState().project;
    if (!project || project.main.length === 0 || this.state !== 'paused') return;
    const total = projectDuration(project);
    const playback = usePlayback.getState();
    const from = playback.time >= total - 1 / 60 ? 0 : playback.time;

    const ctx = this.ensureAudio();
    void ctx.resume();

    this.gen++;
    this.from = from;
    this.clearQueues();
    this.state = 'starting';
    this.gotAudio = false;
    this.streamEnded = false;
    this.consumed = 0;
    this.playRequestedAt = performance.now();
    if (from !== playback.time) playback.setTime(from);
    playback.setPlaying(true);
    this.send({ type: 'play', gen: this.gen, from });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    if (this.state !== 'paused') {
      this.gen++;
      this.send({ type: 'stop', gen: this.gen });
    }
    this.state = 'paused';
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Not started yet.
      }
    }
    this.nodes.clear();
    this.clearQueues();
    usePlayback.getState().setPlaying(false);
  }

  toggle(): void {
    if (this.state === 'paused') this.play();
    else this.pause();
  }

  private ensureAudio(): AudioContext {
    if (this.ctx) return this.ctx;
    // Play through the ringer/silent switch like a video app (Safari 17+).
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session) session.type = 'playback';
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.ctx = ctx;
    return ctx;
  }

  private clearQueues(): void {
    for (const f of this.queue) f.frame.close();
    this.queue = [];
    this.pendingAudio = [];
  }

  private clock(): number {
    return this.ctx ? this.from + (this.ctx.currentTime - this.ctxStart) : this.from;
  }

  private beginClock(): void {
    if (!this.ctx) return;
    this.state = 'playing';
    Object.assign(previewStats, { shown: 0, dropped: 0, maxGapMs: 0, maxGapAt: 0, lastShowAt: 0 });
    this.ctxStart = this.ctx.currentTime + START_LEAD_SEC;
    for (const chunk of this.pendingAudio) this.schedule(chunk);
    this.pendingAudio = [];
  }

  private schedule(chunk: AudioChunk): void {
    const { ctx, master } = this;
    if (!ctx || !master) return;
    const length = chunk.channels[0]?.length ?? 0;
    if (length === 0) return;
    const buffer = ctx.createBuffer(chunk.channels.length, length, chunk.sampleRate);
    chunk.channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    // Pitch follows speed, matching the export resampler.
    node.playbackRate.value = chunk.speed;
    node.connect(master);
    const when = this.ctxStart + (chunk.t - this.from);
    const now = ctx.currentTime;
    if (when >= now) node.start(when);
    else {
      const offset = (now - when) * chunk.speed;
      if (offset >= buffer.duration) return;
      node.start(now, offset);
    }
    this.nodes.add(node);
    node.onended = () => this.nodes.delete(node);
  }

  private onEvent(e: PreviewEvent): void {
    switch (e.type) {
      case 'still':
        if (this.state !== 'paused' || e.id <= this.shownStillId) {
          e.frame?.close();
          return;
        }
        this.shownStillId = e.id;
        this.show(e.frame ? { frame: e.frame, rotation: e.rotation, transfer: e.transfer } : null);
        return;
      case 'frame':
        if (e.gen !== this.gen || this.state === 'paused') {
          e.frame.close();
          return;
        }
        this.queue.push({ frame: e.frame, rotation: e.rotation, transfer: e.transfer, t: e.t });
        return;
      case 'audio':
        if (e.gen !== this.gen || this.state === 'paused') return;
        this.gotAudio = true;
        if (this.state === 'playing') this.schedule(e);
        else this.pendingAudio.push(e);
        return;
      case 'end':
        if (e.gen === this.gen) this.streamEnded = true;
        return;
      case 'error':
        if (e.gen !== this.gen) return;
        previewStats.lastError = e.message;
        this.pause();
        return;
    }
  }

  private readonly tick = () => {
    const project = useEditor.getState().project;
    if (!project || this.state === 'paused') return;

    if (this.state === 'starting') {
      const waited = performance.now() - this.playRequestedAt;
      const framesReady =
        this.queue.length >= START_FRAMES || (this.queue.length > 0 && (this.streamEnded || waited > START_MAX_WAIT_MS));
      if (framesReady && (this.gotAudio || waited > AUDIO_GRACE_MS)) this.beginClock();
      else if (this.streamEnded && this.queue.length === 0) {
        // Nothing decodable from here: stop instead of sitting in "playing" forever.
        this.pause();
        return;
      }
      this.raf = requestAnimationFrame(this.tick);
      return;
    }

    const t = this.clock();
    const total = projectDuration(project);
    if (t >= total) {
      this.pause();
      usePlayback.getState().setTime(total);
      return;
    }

    // Show the newest frame that is due; drop any older ones the decoder delivered late.
    let due = -1;
    for (let i = 0; i < this.queue.length && (this.queue[i] as QueuedFrame).t <= t + 1 / 120; i++) due = i;
    if (due >= 0) {
      const frames = this.queue.splice(0, due + 1);
      const latest = frames.pop() as QueuedFrame;
      for (const f of frames) f.frame.close();
      this.show({ frame: latest.frame, rotation: latest.rotation, transfer: latest.transfer });
      this.consumed += due + 1;
      const shownAt = performance.now();
      const gap = previewStats.lastShowAt ? shownAt - previewStats.lastShowAt : 0;
      if (gap > previewStats.maxGapMs) Object.assign(previewStats, { maxGapMs: gap, maxGapAt: t });
      previewStats.lastShowAt = shownAt;
      previewStats.shown++;
      previewStats.dropped += frames.length;
    }

    const now = performance.now();
    if (this.consumed >= ACK_EVERY_FRAMES || now - this.lastAck > ACK_EVERY_MS) {
      this.send({ type: 'ack', gen: this.gen, frames: this.consumed, clock: t });
      this.consumed = 0;
      this.lastAck = now;
    }

    usePlayback.getState().setTime(Math.max(0, t));
    this.raf = requestAnimationFrame(this.tick);
  };

  destroy(): void {
    this.pause();
    for (const u of this.unsubscribers) u();
    this.worker.terminate();
    this.show(null);
    this.compositor.destroy();
    void this.ctx?.close();
  }
}
