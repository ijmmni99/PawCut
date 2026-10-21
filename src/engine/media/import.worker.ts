/// <reference lib="webworker" />
// Import pipeline, one file at a time:
//   1. copy the original into OPFS (picker Files don't survive an app restart on iOS)
//   2. probe duration / size / audio
//   3. one decode pass that writes the 540p editing proxy and, from the same frames, the poster and thumbnail sprite.
//      Frames are rotated + downscaled by the fastest scaler for the device (scaler.ts); at most 30fps are encoded.
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny';
import type { PrepStats } from '../../editor/timeline/model';
import type { CodecProfile } from '../codecProfile';
import { assetDir, readFile } from '../storage/opfs';
import { copyBlobToOpfs, createOpfsTarget, writeBlobToOpfs } from '../storage/opfsWriter';
import { AdaptiveScaler } from './scaler';
import { PROXY_VERSION, type ImportEvent, ImportRequest, ProbeResult, ProxyResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const PROXY_SHORT_SIDE = 540;
const PROXY_BITRATE = 2_500_000;
const PROXY_FPS = 30;
// Short GOP so preview seeks land fast when scrubbing.
const PROXY_KEYFRAME_SEC = 0.5;
const THUMB_SIZE = 96;
const THUMB_COLUMNS = 16;
const MAX_THUMBS = 120;
const POSTER_W = 270;
const POSTER_H = 480;
const COPY_WEIGHT = 0.1;

const post = (e: ImportEvent) => self.postMessage(e);

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? 'mp4';
}

async function probe(input: Input, originalPath: string): Promise<ProbeResult> {
  const [durationSec, video, audio] = await Promise.all([
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ]);
  if (!video) throw new Error('No video track found');
  return { durationSec, width: video.displayWidth, height: video.displayHeight, hasAudio: audio !== null, originalPath };
}

async function buildProxy(
  assetId: string,
  input: Input,
  info: ProbeResult,
  profile: CodecProfile,
  onProgress: (p: number) => void,
): Promise<ProxyResult> {
  const dir = assetDir(assetId);
  const scale = Math.min(1, PROXY_SHORT_SIDE / Math.min(info.width, info.height));
  const width = even(info.width * scale);
  const height = even(info.height * scale);

  const thumbInterval = Math.max(1, info.durationSec / MAX_THUMBS);
  const thumbCount = Math.max(1, Math.ceil(info.durationSec / thumbInterval));
  const sprite = new OffscreenCanvas(THUMB_COLUMNS * THUMB_SIZE, Math.ceil(thumbCount / THUMB_COLUMNS) * THUMB_SIZE);
  const spriteCtx = sprite.getContext('2d');
  const poster = new OffscreenCanvas(POSTER_W, POSTER_H);
  const posterCtx = poster.getContext('2d');
  let nextThumb = 0;
  let posterDrawn = false;

  /** Draws the (already scaled) proxy frame into a destination box, cropping to cover it. */
  const drawCover = (ctx: OffscreenCanvasRenderingContext2D, src: OffscreenCanvas, dx: number, dy: number, dw: number, dh: number) => {
    const scaleCover = Math.max(dw / src.width, dh / src.height);
    const sw = dw / scaleCover;
    const sh = dh / scaleCover;
    ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, dx, dy, dw, dh);
  };

  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('No video track found');
  const audio = await input.getPrimaryAudioTrack();
  const scaler = new AdaptiveScaler(width, height);
  let prepStats: PrepStats | null = null;

  // Versioned names: an upgrade writes new files while the old proxy may still be playing.
  const proxyPath = `${dir}/proxy-v${PROXY_VERSION}.mp4`;
  const sink = await createOpfsTarget(proxyPath);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: sink.target });
  const videoSource = new VideoSampleSource({
    codec: profile.video,
    quality: new Quality({ bitrate: PROXY_BITRATE }),
    keyFrameInterval: PROXY_KEYFRAME_SEC,
    // The proxy is a throwaway editing copy: favour encode speed over compression efficiency.
    latencyMode: 'realtime',
  });
  output.addVideoTrack(videoSource, { frameRate: PROXY_FPS });
  // Audio rides along as a composable conversion into the same file (decode → 48k stereo → encode).
  const audioConversion = audio
    ? await Conversion.init({
        input,
        output,
        composable: true,
        tracks: 'primary',
        showWarnings: false,
        video: { discard: true },
        audio: {
          codec: profile.audio,
          sampleRate: 48_000,
          numberOfChannels: 2,
          quality: new Quality({ bitrate: 128_000 }),
        },
      })
    : null;

  try {
    await output.start();
    const audioDone = audioConversion?.isValid ? audioConversion.execute() : Promise.resolve();
    // Decode every frame (hardware), but scale + encode at most 30 per second.
    let nextKeep = -Infinity;
    const perf = { decode: 0, draw: 0, encode: 0, frames: 0, kept: 0, started: performance.now() };
    let mark = performance.now();
    for await (const sample of new VideoSampleSink(video).samples()) {
      perf.decode += performance.now() - mark;
      perf.frames++;
      try {
        const ts = sample.timestamp;
        if (ts < nextKeep - 0.25 / PROXY_FPS) continue;
        nextKeep = Math.max(ts, nextKeep) + 1 / PROXY_FPS;
        let t = performance.now();
        const scaled = await scaler.render(sample, ts, 1 / PROXY_FPS);
        perf.draw += performance.now() - t;
        perf.kept++;
        const canvas = scaler.current?.canvas;
        if (!posterDrawn && posterCtx && canvas) {
          drawCover(posterCtx, canvas, 0, 0, POSTER_W, POSTER_H);
          posterDrawn = true;
        }
        while (spriteCtx && canvas && nextThumb < thumbCount && ts + 1 / PROXY_FPS > nextThumb * thumbInterval) {
          drawCover(
            spriteCtx,
            canvas,
            (nextThumb % THUMB_COLUMNS) * THUMB_SIZE,
            Math.floor(nextThumb / THUMB_COLUMNS) * THUMB_SIZE,
            THUMB_SIZE,
            THUMB_SIZE,
          );
          nextThumb++;
        }
        // Keep source timestamps so proxy and original share one time base (clips reference source seconds).
        t = performance.now();
        // Source timestamps are kept so proxy and original share one time base (clips reference source seconds).
        try {
          await videoSource.add(scaled);
        } finally {
          scaled.close();
        }
        perf.encode += performance.now() - t;
        onProgress(Math.min(1, ts / Math.max(info.durationSec, 0.001)));
      } finally {
        sample.close();
        mark = performance.now();
      }
    }
    await audioDone;
    prepStats = {
      copyMs: 0,
      totalMs: Math.round(performance.now() - perf.started),
      decodeMs: Math.round(perf.decode),
      drawMs: Math.round(perf.draw),
      encodeMs: Math.round(perf.encode),
      frames: perf.frames,
      kept: perf.kept,
      scaler: scaler.kind,
      bench: scaler.benchmark(),
    };
    console.info(`PROXY_PERF ${JSON.stringify(prepStats)}`);
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    sink.close();
    scaler.dispose();
  }

  const posterPath = posterDrawn ? `${dir}/poster-v${PROXY_VERSION}.jpg` : null;
  if (posterPath) await writeBlobToOpfs(await poster.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), posterPath);
  const thumbsPath = nextThumb > 0 ? `${dir}/thumbs-v${PROXY_VERSION}.jpg` : null;
  if (thumbsPath) await writeBlobToOpfs(await sprite.convertToBlob({ type: 'image/jpeg', quality: 0.7 }), thumbsPath);

  return {
    proxyPath,
    posterPath,
    thumbsPath,
    thumbInterval,
    thumbCount: nextThumb,
    thumbColumns: THUMB_COLUMNS,
    thumbSize: THUMB_SIZE,
    prepStats: prepStats ?? { copyMs: 0, totalMs: 0, decodeMs: 0, drawMs: 0, encodeMs: 0, frames: 0, kept: 0, scaler: scaler.kind },
  };
}

function progressReporter(assetId: string): (p: number) => void {
  let lastPost = 0;
  return (p) => {
    const now = performance.now();
    if (now - lastPost < 200 && p < 1) return;
    lastPost = now;
    post({ type: 'progress', assetId, progress: p });
  };
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Probed = { job: ImportRequest; input: Input; info: ProbeResult; copyMs: number };

/** Stage 1 (fast): copy into OPFS and probe, so the clip lands on the timeline right away. */
async function copyAndProbe(job: ImportRequest): Promise<Probed | null> {
  const { assetId, source } = job;
  const progress = progressReporter(assetId);
  let input: Input | null = null;
  try {
    let originalPath: string;
    const copyStarted = performance.now();
    if ('file' in source) {
      originalPath = `${assetDir(assetId)}/original.${extensionOf(source.file.name)}`;
      await copyBlobToOpfs(source.file, originalPath, (f) => progress(f * COPY_WEIGHT));
    } else {
      originalPath = source.opfsPath;
    }
    const copyMs = performance.now() - copyStarted;
    input = new Input({ source: new BlobSource(await readFile(originalPath)), formats: ALL_FORMATS });
    const info = await probe(input, originalPath);
    if (!job.upgrade) post({ type: 'probed', assetId, probe: info });
    return { job, input, info, copyMs };
  } catch (err) {
    input?.dispose();
    post({ type: 'error', assetId, message: errorMessage(err), probed: false });
    return null;
  }
}

/** Stage 2 (slow): proxy + thumbnails. */
async function prepare({ job, input, info, copyMs }: Probed): Promise<void> {
  const progress = progressReporter(job.assetId);
  try {
    if (job.upgrade && !(await (await input.getPrimaryVideoTrack())?.hasHighDynamicRange())) {
      post({ type: 'unchanged', assetId: job.assetId });
      return;
    }
    const proxy = await buildProxy(job.assetId, input, info, job.profile, (p) =>
      progress(COPY_WEIGHT + p * (1 - COPY_WEIGHT)),
    );
    proxy.prepStats.copyMs = Math.round(copyMs);
    post({ type: 'ready', assetId: job.assetId, proxy, upgrade: job.upgrade === true });
  } catch (err) {
    post({ type: 'error', assetId: job.assetId, message: errorMessage(err), probed: true });
  } finally {
    input.dispose();
  }
}

// Two serial queues: every file is copied + probed as soon as it arrives (clips show up immediately, in order),
// while proxies are built one at a time (decoding several 4K files at once exhausts iOS memory).
let probeQueue = Promise.resolve();
let prepareQueue = Promise.resolve();
self.onmessage = (e: MessageEvent<ImportRequest>) => {
  const job = e.data;
  probeQueue = probeQueue.then(async () => {
    const probed = await copyAndProbe(job);
    if (probed) prepareQueue = prepareQueue.then(() => prepare(probed));
  });
};
