import type { PrepStats } from '../../editor/timeline/model';
import type { CodecProfile } from '../codecProfile';

export type ImportRequest = {
  type: 'import';
  assetId: string;
  /** A picked file to copy into OPFS, or a path to an original already in OPFS (resuming an interrupted import). */
  source: { file: File } | { opfsPath: string };
  profile: CodecProfile;
};

export type ProbeResult = {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  originalPath: string;
};

export type ProxyResult = {
  proxyPath: string;
  posterPath: string | null;
  thumbsPath: string | null;
  thumbInterval: number;
  thumbCount: number;
  thumbColumns: number;
  thumbSize: number;
  prepStats: PrepStats;
};

export type ImportEvent =
  | { type: 'progress'; assetId: string; progress: number }
  | { type: 'probed'; assetId: string; probe: ProbeResult }
  | { type: 'ready'; assetId: string; proxy: ProxyResult }
  | { type: 'error'; assetId: string; message: string; probed: boolean };
