import type { TransferCode } from '../../engine/media/hdr';
import type { Asset, Project } from '../timeline/model';

/** One layer of a still: a source frame of a main-track clip. */
export type StillLayer = { clipId: string; assetId: string; sourceSec: number };

export type PreviewRequest =
  | { type: 'sync'; project: Project; assets: Record<string, Asset> }
  /** Start streaming decoded frames + audio from timeline time `from`. */
  | { type: 'play'; gen: number; from: number }
  | { type: 'stop'; gen: number }
  /** Main consumed `frames` video frames; `clock` is the current playback time (paces audio read-ahead). */
  | { type: 'ack'; gen: number; frames: number; clock: number }
  /** Decode single still frames (scrubbing / trimming): one layer, or two during a transition. Latest wins. */
  | { type: 'still'; id: number; layers: StillLayer[] };

export type DecodedFrame = { frame: VideoFrame; rotation: number; transfer: TransferCode; clipId: string };

export type PreviewEvent =
  /** `slot` 1 = the incoming clip during a transition (shown blended with slot 0). */
  | ({ type: 'frame'; gen: number; t: number; slot: 0 | 1 } & DecodedFrame)
  | { type: 'audio'; gen: number; t: number; speed: number; volume: number; sampleRate: number; channels: Float32Array[] }
  | { type: 'end'; gen: number }
  | { type: 'error'; gen: number; message: string }
  | { type: 'still'; id: number; layers: Array<DecodedFrame | null> };
