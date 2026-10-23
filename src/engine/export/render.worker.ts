/// <reference lib="webworker" />
// Renders a Project's main track from the ORIGINAL files to a TikTok-ready MP4 in OPFS.
// Video: each output frame (constant 30fps) maps back to a source time through the clip's in-point and speed.
// Audio: decoded per window, speed-resampled to 48 kHz stereo, with short fades at every cut.
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSink,
  CanvasSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
} from 'mediabunny';
import { type Asset, type Clip, type Project, clipDuration } from '../../editor/timeline/model';
import { type Pcm, applyEdgeFades, renderSpeedResampled } from '../audio/resample';
import { trackTransfer } from '../media/hdr';
import { type FrameScaler, createContainScaler } from '../media/scaler';
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

let hdrScaler: FrameScaler | null | undefined;

/**
 * Letterboxed frames of one clip at the given source times. SDR goes through CanvasSink; HDR (iPhone HLG/PQ)
 * goes through the WebGL scaler, which tone-maps so the export isn't washed out.
 */
async function clipFrames(
  track: InputVideoTrack,
  width: number,
  height: number,
  times: Iterable<number>,
): Promise<AsyncIterable<CanvasImageSource | null>> {
  const transfer = await trackTransfer(track);
  if (transfer !== 0) {
    hdrScaler ??= createContainScaler(width, height);
    const scaler = hdrScaler;
    if (scaler) {
      scaler.sourceTransfer = transfer;
      const samples = new VideoSampleSink(track).samplesAtTimestamps(times);
      return (async function* () {
        for await (const sample of samples) {
          if (!sample) {
            yield null;
            continue;
          }
          try {
            await scaler.draw(sample);
          } finally {
            sample.close();
          }
          yield scaler.canvas;
        }
      })();
    }
  }
  const sink = new CanvasSink(track, { width, height, fit: 'contain', poolSize: 2 });
  return (async function* () {
    for await (const wrapped of sink.canvasesAtTimestamps(times)) yield wrapped?.canvas ?? null;
  })();
}

async function render(
  project: Project,
  assets: Record<string, Asset>,
  preset: ExportPreset,
  overlay: Float32Array[] | null,
): Promise<void> {
  const started = performance.now();
  const { width, height, frameRate: fps, sampleRate: rate } = preset;
  const totalSec = project.main.reduce((s, c) => s + clipDuration(c), 0);
  const totalFrames = Math.round(totalSec * fps);
  if (totalFrames === 0) throw new Error('Nothing to export: the timeline is empty.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

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

  let lastPost = 0;
  try {
    await output.start();
    let clipStartSec = 0;
    let framesDone = 0;
    for (const clip of project.main) {
      checkCanceled();
      const clipEndSec = clipStartSec + clipDuration(clip);
      const firstFrame = Math.round(clipStartSec * fps);
      const frameCount = Math.round(clipEndSec * fps) - firstFrame;
      const firstSample = Math.round(clipStartSec * rate);
      const sampleCount = Math.round(clipEndSec * rate) - firstSample;

      const input = await inputFor(clip.assetId);
      const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
      if (!videoTrack) throw new Error('A clip has no video track.');

      // Audio for the clip goes in first; it's small once encoded and keeps the muxer interleaving simple.
      await addClipAudio(audio, audioTrack, clip, firstSample, sampleCount, rate, overlay);

      // Sample mid-frame so rounding never lands just before the intended source frame.
      const times = function* () {
        for (let k = 0; k < frameCount; k++) yield clip.inSec + ((k + 0.5) / fps) * clip.speed;
      };
      const frames = await clipFrames(videoTrack, width, height, times());
      let k = 0;
      for await (const image of frames) {
        checkCanceled();
        // Before the first decodable frame we repeat whatever is on the canvas (black at the very start).
        if (image) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);
        }
        await video.add((firstFrame + k) / fps, 1 / fps);
        k++;
        framesDone++;
        const now = performance.now();
        if (now - lastPost > 250) {
          lastPost = now;
          post({ type: 'progress', progress: framesDone / totalFrames, elapsedMs: now - started });
        }
      }
      clipStartSec = clipEndSec;
    }
    await output.finalize();
    const sizeBytes = sink.close();
    post({ type: 'done', opfsPath: EXPORT_PATH, sizeBytes, durationSec: totalSec, elapsedMs: performance.now() - started });
  } catch (err) {
    await output.cancel().catch(() => undefined);
    sink.close();
    throw err;
  } finally {
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
  render(msg.project, msg.assets, msg.preset, msg.overlay).catch((err: unknown) => {
    if (err instanceof CanceledError) post({ type: 'canceled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};
