/// <reference lib="webworker" />
// Import pipeline, one file at a time:
//   1. copy the original into OPFS (picker Files don't survive an app restart on iOS)
//   2. probe duration / size / audio
//   3. one decode pass that writes the 540p editing proxy and, from the same frames, the poster and thumbnail sprite
import { ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, type VideoSample } from 'mediabunny';
import type { CodecProfile } from '../codecProfile';
import { assetDir, readFile } from '../storage/opfs';
import { copyBlobToOpfs, createOpfsTarget, writeBlobToOpfs } from '../storage/opfsWriter';
import type { ImportEvent, ImportRequest, ProbeResult, ProxyResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const PROXY_SHORT_SIDE = 540;
const PROXY_BITRATE = 2_500_000;
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

  const capture = (sample: VideoSample) => {
    if (!posterDrawn && posterCtx) {
      sample.drawWithFit(posterCtx, { fit: 'cover' });
      posterDrawn = true;
    }
    if (!spriteCtx) return;
    while (nextThumb < thumbCount && sample.timestamp + sample.duration > nextThumb * thumbInterval) {
      const tile = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE);
      const tileCtx = tile.getContext('2d');
      if (tileCtx) {
        sample.drawWithFit(tileCtx, { fit: 'cover' });
        spriteCtx.drawImage(
          tile,
          (nextThumb % THUMB_COLUMNS) * THUMB_SIZE,
          Math.floor(nextThumb / THUMB_COLUMNS) * THUMB_SIZE,
        );
      }
      nextThumb++;
    }
  };

  const proxyPath = `${dir}/proxy.mp4`;
  const sink = await createOpfsTarget(proxyPath);
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: sink.target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    showWarnings: false,
    copy: false,
    video: {
      codec: profile.video,
      width,
      height,
      fit: 'fill',
      frameRate: 30,
      quality: new Quality({ bitrate: PROXY_BITRATE }),
      keyFrameInterval: PROXY_KEYFRAME_SEC,
      allowTransformationMetadata: false,
      process: (sample) => {
        capture(sample);
        return sample;
      },
    },
    audio: { codec: profile.audio, sampleRate: 48_000, numberOfChannels: 2, quality: new Quality({ bitrate: 128_000 }) },
  });
  if (!conversion.isValid) {
    sink.close();
    throw new Error(
      `Can't prepare this video: ${conversion.discardedTracks.map((d) => `${d.track.type} ${d.reason}`).join(', ')}`,
    );
  }
  conversion.onProgress = onProgress;
  try {
    await conversion.execute();
  } finally {
    sink.close();
  }

  const posterPath = posterDrawn ? `${dir}/poster.jpg` : null;
  if (posterPath) await writeBlobToOpfs(await poster.convertToBlob({ type: 'image/jpeg', quality: 0.8 }), posterPath);
  const thumbsPath = nextThumb > 0 ? `${dir}/thumbs.jpg` : null;
  if (thumbsPath) await writeBlobToOpfs(await sprite.convertToBlob({ type: 'image/jpeg', quality: 0.7 }), thumbsPath);

  return {
    proxyPath,
    posterPath,
    thumbsPath,
    thumbInterval,
    thumbCount: nextThumb,
    thumbColumns: THUMB_COLUMNS,
    thumbSize: THUMB_SIZE,
  };
}

async function runImport({ assetId, source, profile }: ImportRequest): Promise<void> {
  let probed = false;
  let lastPost = 0;
  const progress = (p: number) => {
    const now = performance.now();
    if (now - lastPost < 200 && p < 1) return;
    lastPost = now;
    post({ type: 'progress', assetId, progress: p });
  };
  try {
    let originalPath: string;
    if ('file' in source) {
      originalPath = `${assetDir(assetId)}/original.${extensionOf(source.file.name)}`;
      await copyBlobToOpfs(source.file, originalPath, (f) => progress(f * COPY_WEIGHT));
    } else {
      originalPath = source.opfsPath;
    }
    const input = new Input({ source: new BlobSource(await readFile(originalPath)), formats: ALL_FORMATS });
    try {
      const info = await probe(input, originalPath);
      probed = true;
      post({ type: 'probed', assetId, probe: info });
      const proxy = await buildProxy(assetId, input, info, profile, (p) => progress(COPY_WEIGHT + p * (1 - COPY_WEIGHT)));
      post({ type: 'ready', assetId, proxy });
    } finally {
      input.dispose();
    }
  } catch (err) {
    post({ type: 'error', assetId, message: err instanceof Error ? err.message : String(err), probed });
  }
}

// Imports run strictly one after another: decoding several 4K files at once exhausts iOS memory.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<ImportRequest>) => {
  const job = e.data;
  queue = queue.then(() => runImport(job));
};
