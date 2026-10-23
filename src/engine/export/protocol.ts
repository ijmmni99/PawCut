// Messages between the main thread and the export worker. Plain serializable data only.

export type ExportPreset = {
  videoCodec: 'avc' | 'vp9';
  audioCodec: 'aac' | 'opus';
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
  keyFrameInterval: number;
};

export const TIKTOK_1080P30: ExportPreset = {
  videoCodec: 'avc',
  audioCodec: 'aac',
  width: 1080,
  height: 1920,
  frameRate: 30,
  videoBitrate: 10_000_000,
  audioBitrate: 128_000,
  sampleRate: 48_000,
  keyFrameInterval: 2,
};

export type SourceInfo = {
  container: string;
  durationSec: number;
  video: {
    codec: string | null;
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    hdr: boolean;
  } | null;
  audio: { codec: string | null; sampleRate: number; channels: number } | null;
};

export type ExportRequest = { type: 'start'; file: File; preset: ExportPreset } | { type: 'cancel' };

export type ExportEvent =
  | { type: 'probed'; source: SourceInfo; aacFallback: boolean; sink: 'opfs' | 'memory' }
  | { type: 'progress'; progress: number; processedSec: number; elapsedMs: number }
  | {
      type: 'done';
      elapsedMs: number;
      // When written to OPFS the main thread reads it by name; otherwise the bytes are transferred.
      opfsName: string | null;
      buffer: ArrayBuffer | null;
      sizeBytes: number;
      outputDurationSec: number;
      videoCodec: string | null;
      audioCodec: string | null;
    }
  | { type: 'error'; message: string; discarded: string[] };

/**
 * Royalty-free codecs with the same pipeline. Only for CI/headless Chromium, which ships without
 * H.264/AAC; enabled with `?codec=vp9`. Never a user-facing preset.
 */
export const ENGINE_TEST_PRESET: ExportPreset = { ...TIKTOK_1080P30, videoCodec: 'vp9', audioCodec: 'opus' };

// ---- Timeline export (Phase 1+) ----

export const EXPORT_PATH = 'exports/latest.mp4';

export type RenderRequest =
  | {
      type: 'start';
      project: import('../../editor/timeline/model').Project;
      assets: Record<string, import('../../editor/timeline/model').Asset>;
      preset: ExportPreset;
      /** Music / SFX / voiceover pre-mixed on the main thread (Web Audio), 48 kHz stereo planar, timeline-aligned. */
      overlay: Float32Array[] | null;
      /** Text/caption sprites rasterised on the main thread (fonts), keyed like the overlay plan. */
      sprites?: Array<{ key: string; bitmap: ImageBitmap; meta: import('../../editor/overlay/plan').SpriteMeta }>;
    }
  | { type: 'cancel' };

export type RenderEvent =
  | { type: 'progress'; progress: number; elapsedMs: number }
  | { type: 'done'; opfsPath: string; sizeBytes: number; durationSec: number; elapsedMs: number }
  | { type: 'error'; message: string }
  | { type: 'canceled' };
