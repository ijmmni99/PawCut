/// <reference lib="webworker" />
// Renders a Project's main track from the ORIGINAL files to a TikTok-ready MP4 in OPFS.
// Video: each output frame (constant 30fps) maps back to a source time through the clip's in-point and speed, and
// goes through the shared WebGL renderer (looks, HDR tone-mapping, transitions), then texts/captions on top.
// Audio: decoded per window, speed-resampled to 48 kHz stereo, with short fades at every cut.
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  Input,
  type InputAudioTrack,
  Mp4OutputFormat,
  Output,
  Quality,
  type VideoSample,
  VideoSampleSink,
} from 'mediabunny';
import { type SpriteImage, drawOps } from '../../editor/overlay/draw';
import { FRAME_W, buildPlan, layoutAt } from '../../editor/overlay/plan';
import { type Asset, type Clip, type Project, clipDuration, clipStarts, locate } from '../../editor/timeline/model';
import { clipWindow, cutsWithTransitions, sourceTime, transitionAt } from '../../editor/timeline/transitions';
import { type Pcm, applyEdgeFades, renderSpeedResampled } from '../audio/resample';
import { applyVoiceFx } from '../audio/voiceFx';
import { type TransferCode, trackTransfer } from '../media/hdr';
import { lookParams } from '../render/looks';
import { type Layer, type Renderer, containRect, createRenderer } from '../render/renderer';
import { readFile } from '../storage/opfs';
import { createOpfsTarget } from '../storage/opfsWriter';
import { EXPORT_PATH, type ExportPreset, type RenderEvent, type RenderRequest } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const CHANNELS = 2;
const AUDIO_WINDOW_SEC = 5;
const FADE_SEC = 0.005;

let canceled = false;
const post = (e: RenderEvent) => self.postMessage(e);

class CanceledError extends Error {}
const checkCanceled = () => {
  if (canceled) throw new CanceledError();
};

/** Decodes source audio covering [startSec, endSec] into planar float channels. */
async function decodeRange(sink: AudioSampleSink, startSec: number, endSec: number): Promise<Pcm | null> {
  const parts: Float32Array[][] = [];
  let sampleRate = 48_000;
  let first: number | null = null;
  let total = 0;
  for await (const sample of sink.samples(startSec, endSec)) {
    try {
      sampleRate = sample.sampleRate;
      first ??= sample.timestamp;
      const chans: Float32Array[] = [];
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        chans.push(plane);
      }
      parts.push(chans);
      total += sample.numberOfFrames;
    } finally {
      sample.close();
    }
  }
  if (first === null) return null;
  const channelCount = parts[0]?.length ?? 1;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
  let offset = 0;
  for (const chans of parts) {
    for (let c = 0; c < channelCount; c++) channels[c]?.set(chans[c] ?? (chans[0] as Float32Array), offset);
    offset += chans[0]?.length ?? 0;
  }
  return { channels, sampleRate, startSec: first };
}

async function addClipAudio(
  source: AudioSampleSource,
  track: InputAudioTrack | null,
  clip: Clip,
  firstFrame: number,
  frameCount: number,
  rate: number,
  overlay: Float32Array[] | null,
): Promise<void> {
  const out = Array.from({ length: CHANNELS }, () => new Float32Array(frameCount));
  const volume = clip.volume ?? 1;
  if (track && volume > 0) {
    const sink = new AudioSampleSink(track);
    const windowFrames = AUDIO_WINDOW_SEC * rate;
    for (let w = 0; w < frameCount; w += windowFrames) {
      checkCanceled();
      const frames = Math.min(windowFrames, frameCount - w);
      const srcStart = clip.inSec + (w / rate) * clip.speed;
      const srcEnd = clip.inSec + ((w + frames) / rate) * clip.speed;
      // A little slack either side so interpolation has neighbours.
      const pcm = await decodeRange(sink, Math.max(0, srcStart - 0.05), srcEnd + 0.05);
      if (pcm) renderSpeedResampled(pcm, out, w, frames, rate, srcStart, clip.speed);
    }
    applyEdgeFades(out, 0, frameCount, Math.round(FADE_SEC * rate));
    if (volume !== 1) for (const ch of out) for (let i = 0; i < frameCount; i++) ch[i] = (ch[i] as number) * volume;
    if (clip.voiceFx) applyVoiceFx(out, rate, clip.voiceFx).forEach((ch, c) => out[c]?.set(ch));
  }
  // Add the pre-mixed music / SFX / voice for this stretch of the timeline.
  if (overlay) {
    for (let c = 0; c < CHANNELS; c++) {
      const src = overlay[c] ?? overlay[0];
      const dst = out[c] as Float32Array;
      if (!src) continue;
      for (let i = 0; i < frameCount; i++) dst[i] = (dst[i] as number) + (src[firstFrame + i] ?? 0);
    }
  }
  // Hand the encoder 1s chunks of planar f32.
  for (let off = 0; off < frameCount; off += rate) {
    const n = Math.min(rate, frameCount - off);
    const data = new Float32Array(n * CHANNELS);
    for (let c = 0; c < CHANNELS; c++) data.set((out[c] as Float32Array).subarray(off, off + n), c * n);
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: CHANNELS,
      sampleRate: rate,
      timestamp: (firstFrame + off) / rate,
    });
    await source.add(sample);
    sample.close();
  }
}

/** A clip being decoded for export: one sample per output frame across its on-screen window. */
type ClipFrames = {
  iter: AsyncIterator<VideoSample | null>;
  /** Last decoded frame (held when the decoder has nothing yet). */
  last: VideoFrame | null;
  rotation: number;
  transfer: TransferCode;
  clipId: string;
};

function containDraw(ctx: OffscreenCanvasRenderingContext2D, f: VideoFrame, rotation: number, width: number, height: number) {
  const [sw, sh] = rotation % 180 === 0 ? [f.displayWidth, f.displayHeight] : [f.displayHeight, f.displayWidth];
  const r = containRect(sw, sh, width, height);
  ctx.save();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const [dw, dh] = rotation % 180 === 0 ? [r.w, r.h] : [r.h, r.w];
  ctx.drawImage(f, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

async function render(
  project: Project,
  assets: Record<string, Asset>,
  preset: ExportPreset,
  overlay: Float32Array[] | null,
  sprites: Map<string, SpriteImage>,
): Promise<void> {
  const started = performance.now();
  const { width, height, frameRate: fps, sampleRate: rate } = preset;
  const totalSec = project.main.reduce((s, c) => s + clipDuration(c), 0);
  const totalFrames = Math.round(totalSec * fps);
  if (totalFrames === 0) throw new Error('Nothing to export: the timeline is empty.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  // Video goes through the same WebGL renderer as the preview (looks, HDR tone-mapping, transitions).
  const glCanvas = new OffscreenCanvas(width, height);
  let renderer: Renderer | null = null;
  try {
    renderer = createRenderer(glCanvas);
  } catch (err) {
    console.warn('export renderer unavailable, drawing without effects', err);
  }
  // Texts and captions, laid out with the same code as the preview.
  const plan = buildPlan(project);
  const spriteOf = (key: string) => sprites.get(key);
  const metaOf = (key: string) => sprites.get(key)?.meta;
  const frameScale = width / FRAME_W;
  const cuts = cutsWithTransitions(project);
  const starts = clipStarts(project);
  const windows = project.main.map((_, i) => {
    const w = clipWindow(project, cuts, i);
    return { k0: Math.round(w.from * fps), k1: Math.round(w.to * fps), start: w.start };
  });
  const looks = project.main.map((c) => lookParams(c.look));

  const sink = await createOpfsTarget(EXPORT_PATH);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: sink.target });
  const video = new CanvasSource(canvas, {
    codec: preset.videoCodec,
    quality: new Quality({ bitrate: preset.videoBitrate }),
    keyFrameInterval: preset.keyFrameInterval,
  });
  const audio = new AudioSampleSource({ codec: preset.audioCodec, quality: new Quality({ bitrate: preset.audioBitrate }) });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);

  const inputs = new Map<string, Input>();
  const inputFor = async (assetId: string): Promise<Input> => {
    const cached = inputs.get(assetId);
    if (cached) return cached;
    const path = assets[assetId]?.originalPath;
    if (!path) throw new Error('A clip is missing its source file.');
    const input = new Input({ source: new BlobSource(await readFile(path)), formats: ALL_FORMATS });
    inputs.set(assetId, input);
    return input;
  };

  const openClip = async (i: number): Promise<ClipFrames> => {
    const clip = project.main[i] as Clip;
    const input = await inputFor(clip.assetId);
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('A clip has no video track.');
    const dur = assets[clip.assetId]?.durationSec || clip.outSec;
    const { k0, k1 } = windows[i] as { k0: number; k1: number };
    const start = starts[i] ?? 0;
    // Sample mid-frame so rounding never lands just before the intended source frame.
    const times = function* () {
      for (let k = k0; k < k1; k++) yield sourceTime(clip, start, (k + 0.5) / fps, dur);
    };
    const iter = new VideoSampleSink(track).samplesAtTimestamps(times())[Symbol.asyncIterator]();
    return { iter, last: null, rotation: 0, transfer: await trackTransfer(track), clipId: clip.id };
  };

  const advance = async (cf: ClipFrames): Promise<void> => {
    const r = await cf.iter.next();
    const sample = r.done ? null : r.value;
    if (!sample) return;
    cf.last?.close();
    cf.last = sample.toVideoFrame();
    cf.rotation = sample.rotation;
    sample.close();
  };

  const layerOf = (cf: ClipFrames, i: number): Layer | null =>
    cf.last
      ? {
          image: cf.last,
          width: cf.last.displayWidth,
          height: cf.last.displayHeight,
          rotation: cf.rotation,
          transfer: cf.transfer,
          colorSpace: cf.last.colorSpace,
          look: looks[i] ?? null,
        }
      : null;

  const open = new Map<number, ClipFrames>();
  const closeClip = async (i: number) => {
    const cf = open.get(i);
    if (!cf) return;
    open.delete(i);
    cf.last?.close();
    await cf.iter.return?.();
  };

  let lastPost = 0;
  let audioNext = 0;
  try {
    await output.start();
    for (let k = 0; k < totalFrames; k++) {
      checkCanceled();
      // Each clip's sound goes in when its first frame comes up (keeps the muxer interleaving simple).
      while (audioNext < project.main.length && Math.round((starts[audioNext] ?? 0) * fps) <= k) {
        const clip = project.main[audioNext] as Clip;
        const input = await inputFor(clip.assetId);
        const clipStartSec = starts[audioNext] ?? 0;
        const firstSample = Math.round(clipStartSec * rate);
        const sampleCount = Math.round((clipStartSec + clipDuration(clip)) * rate) - firstSample;
        await addClipAudio(audio, await input.getPrimaryAudioTrack(), clip, firstSample, sampleCount, rate, overlay);
        audioNext++;
      }
      // Clips on screen at this frame (two during a transition).
      for (let i = 0; i < project.main.length; i++) {
        const w = windows[i] as { k0: number; k1: number };
        const visible = k >= w.k0 && k < w.k1;
        if (visible && !open.has(i)) open.set(i, await openClip(i));
        else if (!visible && open.has(i)) await closeClip(i);
      }
      for (const cf of open.values()) await advance(cf);

      const tMid = (k + 0.5) / fps;
      const tr = transitionAt(cuts, tMid);
      // Outside transitions exactly one clip is on screen; inside, the outgoing one is A and the incoming one B.
      const ia = tr ? tr.index : (locate(project, tMid)?.index ?? 0);
      const ib = tr ? tr.index + 1 : -1;
      const a = open.get(ia);
      const b = ib >= 0 ? open.get(ib) : undefined;
      if (renderer) {
        renderer.render(a ? layerOf(a, ia) : null, b ? layerOf(b, ib) : null, tr && b ? { kind: tr.kind, p: tr.p } : null);
        ctx.drawImage(glCanvas, 0, 0);
      } else {
        // No WebGL in this worker: plain letterboxed frames, transitions as a cross-fade.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        if (a?.last) containDraw(ctx, a.last, a.rotation, width, height);
        if (tr && b?.last) {
          ctx.globalAlpha = tr.p;
          containDraw(ctx, b.last, b.rotation, width, height);
          ctx.globalAlpha = 1;
        }
      }
      if (plan.items.length > 0) drawOps(ctx, layoutAt(plan, k / fps, metaOf), spriteOf, frameScale);
      await video.add(k / fps, 1 / fps);
      const now = performance.now();
      if (now - lastPost > 250) {
        lastPost = now;
        post({ type: 'progress', progress: (k + 1) / totalFrames, elapsedMs: now - started });
      }
    }
    for (const i of [...open.keys()]) await closeClip(i);
    await output.finalize();
    const sizeBytes = sink.close();
    post({ type: 'done', opfsPath: EXPORT_PATH, sizeBytes, durationSec: totalSec, elapsedMs: performance.now() - started });
  } catch (err) {
    for (const i of [...open.keys()]) await closeClip(i).catch(() => undefined);
    await output.cancel().catch(() => undefined);
    sink.close();
    throw err;
  } finally {
    renderer?.destroy();
    for (const input of inputs.values()) input.dispose();
  }
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    canceled = true;
    return;
  }
  canceled = false;
  const sprites = new Map((msg.sprites ?? []).map((s) => [s.key, { image: s.bitmap, meta: s.meta }]));
  render(msg.project, msg.assets, msg.preset, msg.overlay, sprites)
    .finally(() => {
      for (const s of sprites.values()) (s.image as ImageBitmap).close();
    })
    .catch((err: unknown) => {
    if (err instanceof CanceledError) post({ type: 'canceled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};
