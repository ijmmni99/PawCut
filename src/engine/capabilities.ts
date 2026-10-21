// Feature detection for the media pipeline. Never throws: every probe degrades to `false`.
import { hdrUploadIsRaw } from './media/hdr';

export type CodecProbe = { label: string; codec: string; supported: boolean; hw?: boolean };

export type Capabilities = {
  userAgent: string;
  standalone: boolean;
  crossOriginIsolated: boolean;
  webCodecs: { videoDecoder: boolean; videoEncoder: boolean; audioDecoder: boolean; audioEncoder: boolean };
  videoEncode: CodecProbe[];
  videoDecode: CodecProbe[];
  audioEncode: CodecProbe[];
  audioDecode: CodecProbe[];
  webgl2: boolean;
  webgpu: boolean;
  /** HDR video arrives raw in WebGL, so PawCut tone-maps it (false = the browser converts it itself). */
  hdrToneMapping: boolean;
  opfs: boolean;
  wakeLock: boolean;
  shareFiles: boolean;
  storagePersist: boolean;
  deviceMemoryGB: number | null;
  hardwareConcurrency: number;
};

const W = 1080;
const H = 1920;

// H.264 levels: 4.0 = 1080p30, 4.2 = 1080p60, 5.1 = 4K. High/Main/Baseline profiles.
const AVC_ENCODE = [
  { label: 'H.264 High L4.2', codec: 'avc1.64002A' },
  { label: 'H.264 High L4.0', codec: 'avc1.640028' },
  { label: 'H.264 Main L4.0', codec: 'avc1.4D0028' },
  { label: 'H.264 Baseline L4.0', codec: 'avc1.420028' },
  { label: 'HEVC Main L4.1', codec: 'hvc1.1.6.L123.B0' },
  { label: 'VP9', codec: 'vp09.00.40.08' },
  { label: 'AV1', codec: 'av01.0.08M.08' },
];

// What iPhones record: HEVC (incl. 10-bit HDR / Dolby Vision base layer) or H.264.
const VIDEO_DECODE = [
  { label: 'H.264 High L5.1 (4K)', codec: 'avc1.640033' },
  { label: 'HEVC Main L5.1 (4K)', codec: 'hvc1.1.6.L153.B0' },
  { label: 'HEVC Main10 L5.1 (HDR)', codec: 'hvc1.2.4.L153.B0' },
  { label: 'VP9', codec: 'vp09.00.40.08' },
  { label: 'AV1', codec: 'av01.0.08M.08' },
];

const AUDIO_ENCODE = [
  { label: 'AAC-LC', codec: 'mp4a.40.2' },
  { label: 'Opus', codec: 'opus' },
];

const AUDIO_DECODE = [
  { label: 'AAC-LC', codec: 'mp4a.40.2' },
  { label: 'Opus', codec: 'opus' },
  { label: 'MP3', codec: 'mp3' },
];

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function probeVideoEncode(codec: string): Promise<{ supported: boolean; hw: boolean }> {
  if (typeof VideoEncoder === 'undefined') return { supported: false, hw: false };
  const base: VideoEncoderConfig = { codec, width: W, height: H, bitrate: 10_000_000, framerate: 30 };
  const hw = await safe(
    async () => (await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-hardware' })).supported === true,
    false,
  );
  const any = hw || (await safe(async () => (await VideoEncoder.isConfigSupported(base)).supported === true, false));
  return { supported: any, hw };
}

async function probeVideoDecode(codec: string): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  return safe(
    async () => (await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160 })).supported === true,
    false,
  );
}

async function probeAudioEncode(codec: string): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  return safe(
    async () =>
      (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }))
        .supported === true,
    false,
  );
}

async function probeAudioDecode(codec: string): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined') return false;
  return safe(
    async () => (await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 })).supported === true,
    false,
  );
}

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  return safe(async () => (await gpu.requestAdapter()) !== null, false);
}

async function hasOPFS(): Promise<boolean> {
  return safe(async () => {
    await navigator.storage.getDirectory();
    return true;
  }, false);
}

function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], 'probe.mp4', { type: 'video/mp4' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const [videoEncode, videoDecode, audioEncode, audioDecode, webgpu, opfs] = await Promise.all([
    Promise.all(AVC_ENCODE.map(async (c) => ({ ...c, ...(await probeVideoEncode(c.codec)) }))),
    Promise.all(VIDEO_DECODE.map(async (c) => ({ ...c, supported: await probeVideoDecode(c.codec) }))),
    Promise.all(AUDIO_ENCODE.map(async (c) => ({ ...c, supported: await probeAudioEncode(c.codec) }))),
    Promise.all(AUDIO_DECODE.map(async (c) => ({ ...c, supported: await probeAudioDecode(c.codec) }))),
    hasWebGPU(),
    hasOPFS(),
  ]);

  return {
    userAgent: navigator.userAgent,
    standalone: isStandalone(),
    crossOriginIsolated: self.crossOriginIsolated === true,
    webCodecs: {
      videoDecoder: typeof VideoDecoder !== 'undefined',
      videoEncoder: typeof VideoEncoder !== 'undefined',
      audioDecoder: typeof AudioDecoder !== 'undefined',
      audioEncoder: typeof AudioEncoder !== 'undefined',
    },
    videoEncode,
    videoDecode,
    audioEncode,
    audioDecode,
    webgl2: hasWebGL2(),
    hdrToneMapping: hdrUploadIsRaw(),
    webgpu,
    opfs,
    wakeLock: 'wakeLock' in navigator,
    shareFiles: canShareFiles(),
    storagePersist: typeof navigator.storage?.persist === 'function',
    deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}
