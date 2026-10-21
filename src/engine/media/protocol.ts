import type { PrepStats } from '../../editor/timeline/model';
import type { CodecProfile } from '../codecProfile';

/** Bump when proxies must be rebuilt (2 = HDR tone-mapped). Older HDR proxies are rebuilt on launch. */
export const PROXY_VERSION = 2;

export type ImportRequest = {
  type: 'import';
  assetId: string;
  /** A picked file to copy into OPFS, or a path to an original already in OPFS (resuming an interrupted import). */
  source: { file: File } | { opfsPath: string };
  profile: CodecProfile;
  /** Rebuild an existing asset's proxy if (and only if) its source is HDR. */
  upgrade?: boolean;
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
  | { type: 'ready'; assetId: string; proxy: ProxyResult; upgrade: boolean }
  /** An upgrade request found nothing to redo (SDR source). */
  | { type: 'unchanged'; assetId: string }
  | { type: 'error'; assetId: string; message: string; probed: boolean };
