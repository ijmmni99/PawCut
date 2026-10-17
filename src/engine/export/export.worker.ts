/// <reference lib="webworker" />
// Phase 0 export spike: decode any input with WebCodecs and re-encode to a TikTok-ready MP4.
// Runs entirely off the main thread. Output streams into OPFS when possible so the encoded
// file never has to sit fully in JS memory.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  canEncodeAudio,
  type StreamTargetChunk,
} from 'mediabunny';
import type { ExportEvent, ExportPreset, ExportRequest, SourceInfo } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const OUTPUT_NAME = 'pawcut-export.mp4';

let current: Conversion | null = null;

function post(event: ExportEvent, transfer: Transferable[] = []): void {
  self.postMessage(event, transfer);
}

async function ensureAac(): Promise<boolean> {
  if (await canEncodeAudio('aac', { sampleRate: 48_000, numberOfChannels: 2 })) return false;
  // Native AAC encoding missing (older iOS). Lazy-load the WASM AAC encoder only in this case.
  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
  return true;
}

type Sink = {
  kind: 'opfs' | 'memory';
  target: StreamTarget | BufferTarget;
  finish(): Promise<{ opfsName: string | null; buffer: ArrayBuffer | null; sizeBytes: number }>;
};

async function createOpfsSink(): Promise<Sink | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(OUTPUT_NAME, { create: true });
    const access = await fileHandle.createSyncAccessHandle();
    access.truncate(0);
    let size = 0;
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        access.write(chunk.data, { at: chunk.position });
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      },
    });
    return {
      kind: 'opfs',
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
      async finish() {
        access.flush();
        access.close();
        return { opfsName: OUTPUT_NAME, buffer: null, sizeBytes: size };
      },
    };
  } catch {
    return null;
  }
}

function createMemorySink(): Sink {
  const target = new BufferTarget();
  return {
    kind: 'memory',
    target,
    async finish() {
      const buffer = target.buffer;
      if (!buffer) throw new Error('Export produced no data');
      return { opfsName: null, buffer, sizeBytes: buffer.byteLength };
    },
  };
}

async function probe(input: Input): Promise<SourceInfo> {
  const [format, durationSec, video, audio] = await Promise.all([
    input.getFormat(),
    input.computeDuration(),
    input.getPrimaryVideoTrack(),
    input.getPrimaryAudioTrack(),
  ]);
  return {
    container: format.name,
    durationSec,
    video: video
      ? {
          codec: video.codec,
          codedWidth: video.codedWidth,
          codedHeight: video.codedHeight,
          displayWidth: video.displayWidth,
          displayHeight: video.displayHeight,
          rotation: video.rotation,
          hdr: await video.hasHighDynamicRange(),
        }
      : null,
    audio: audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels } : null,
  };
}

async function run(file: File, preset: ExportPreset): Promise<void> {
  const started = performance.now();
  const aacFallback = preset.audioCodec === 'aac' ? await ensureAac() : false;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const source = await probe(input);

  const sink = (await createOpfsSink()) ?? createMemorySink();
  post({ type: 'probed', source, aacFallback, sink: sink.kind });

  const output = new Output({
    // Monolithic mdat with moov written at the end: no extra in-memory copy, plays everywhere.
    format: new Mp4OutputFormat({ fastStart: false }),
    target: sink.target,
  });

  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    showWarnings: false,
    copy: false,
    video: {
      codec: preset.videoCodec,
      width: preset.width,
      height: preset.height,
      fit: 'contain',
      frameRate: preset.frameRate,
      quality: new Quality({ bitrate: preset.videoBitrate }),
      keyFrameInterval: preset.keyFrameInterval,
      // Bake rotation into pixels so every player (and TikTok) shows the same orientation.
      allowTransformationMetadata: false,
      // 'prefer-hardware' is a hard requirement in WebCodecs and fails without a HW encoder; let the UA pick.
      hardwareAcceleration: 'no-preference',
    },
    audio: {
      codec: preset.audioCodec,
      sampleRate: preset.sampleRate,
      numberOfChannels: 2,
      quality: new Quality({ bitrate: preset.audioBitrate }),
    },
  });

  if (!conversion.isValid) {
    post({
      type: 'error',
      message: 'This file cannot be converted on this device.',
      discarded: conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`),
    });
    return;
  }

  current = conversion;
  let lastPost = 0;
  conversion.onProgress = (progress, processedSec) => {
    const now = performance.now();
    if (now - lastPost < 250 && progress < 1) return;
    lastPost = now;
    post({ type: 'progress', progress, processedSec, elapsedMs: now - started });
  };

  await conversion.execute();
  current = null;

  const result = await sink.finish();
  post(
    {
      type: 'done',
      elapsedMs: performance.now() - started,
      ...result,
      outputDurationSec: source.durationSec,
      videoCodec: conversion.utilizedTracks.some((t) => t.type === 'video') ? preset.videoCodec : null,
      audioCodec: conversion.utilizedTracks.some((t) => t.type === 'audio') ? preset.audioCodec : null,
    },
    result.buffer ? [result.buffer] : [],
  );
}

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    void current?.cancel();
    return;
  }
  run(msg.file, msg.preset).catch((err: unknown) => {
    current = null;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), discarded: [] });
  });
};
