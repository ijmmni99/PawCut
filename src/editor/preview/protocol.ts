import type { TransferCode } from '../../engine/media/hdr';
import type { Asset, Project } from '../timeline/model';

export type PreviewRequest =
  | { type: 'sync'; project: Project; assets: Record<string, Asset> }
  /** Start streaming decoded frames + audio from timeline time `from`. */
  | { type: 'play'; gen: number; from: number }
  | { type: 'stop'; gen: number }
  /** Main consumed `frames` video frames; `clock` is the current playback time (paces audio read-ahead). */
  | { type: 'ack'; gen: number; frames: number; clock: number }
  /** Decode a single still frame (scrubbing / trimming). Only the latest request is honoured. */
  | { type: 'still'; id: number; assetId: string; sourceSec: number };

export type PreviewEvent =
  | { type: 'frame'; gen: number; t: number; frame: VideoFrame; rotation: number; transfer: TransferCode }
  | { type: 'audio'; gen: number; t: number; speed: number; sampleRate: number; channels: Float32Array[] }
  | { type: 'end'; gen: number }
  | { type: 'error'; gen: number; message: string }
  | { type: 'still'; id: number; frame: VideoFrame | null; rotation: number; transfer: TransferCode };
