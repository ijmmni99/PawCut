// Timeline data model: plain serializable JSON plus pure operations.
// Preview and export both render from a Project, so every edit goes through these functions.

export type AssetStatus = 'importing' | 'ready' | 'error';

export type Asset = {
  id: string;
  kind: 'video';
  name: string;
  /** Display size after rotation. 0 until probed. */
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  status: AssetStatus;
  /** 0..1 while importing. */
  progress: number;
  error: string | null;
  /** OPFS paths, relative to the OPFS root. */
  originalPath: string | null;
  proxyPath: string | null;
  thumbsPath: string | null;
  posterPath: string | null;
  /** Thumbnail sprite: one square tile every `thumbInterval` seconds of source, `thumbColumns` tiles per row. */
  thumbInterval: number;
  thumbCount: number;
  thumbColumns: number;
  thumbSize: number;
  createdAt: number;
  /** Source colour metadata (from the file), shown in Diagnostics. */
  color?: AssetColor;
  /** Proxy generation the files were built with (see PROXY_VERSION). Missing = 1. */
  proxyVersion?: number;
  /** Loudness of the clip's own sound over time (drives music ducking). Missing until measured. */
  loudness?: Loudness;
  /** How long preparing the proxy took, per stage (shown in Diagnostics to tune import speed). */
  prepStats?: PrepStats | null;
};

/** Loudness of an asset's audio: dBFS per `step` seconds of source. */
export type Loudness = { step: number; db: number[] };

export type AssetColor = { primaries: string | null; transfer: string | null; hdr: boolean };

export type PrepStats = {
  /** Copying the original into app storage. */
  copyMs: number;
  /** Building the proxy (decode + scale + encode + audio). */
  totalMs: number;
  decodeMs: number;
  drawMs: number;
  encodeMs: number;
  frames: number;
  kept: number;
  scaler: 'gl' | 'bitmap' | '2d';
  /** Median ms per frame for each scaler tried. */
  bench?: Partial<Record<'gl' | 'bitmap' | '2d', number>>;
  /** Scaling methods that failed on this device. */
  failures?: string[];
};

export type Clip = {
  id: string;
  assetId: string;
  /** Source in/out points, seconds. */
  inSec: number;
  outSec: number;
  /** Constant playback speed, 0.25..4. */
  speed: number;
  /** Original-sound gain, 0 (muted) .. 2. Missing = 1. */
  volume?: number;
  /** Transition into the NEXT clip, centred on the cut (the timeline length doesn't change). */
  transition?: ClipTransition;
  /** Filter preset + manual adjustments. */
  look?: Look;
};

export type TransitionKind =
  | 'dissolve'
  | 'dipBlack'
  | 'dipWhite'
  | 'slideLeft'
  | 'slideUp'
  | 'pushLeft'
  | 'pushRight'
  | 'wipeLeft'
  | 'wipeUp'
  | 'circle'
  | 'heart'
  | 'luma'
  | 'pixelize'
  | 'zoomIn'
  | 'zoomOut'
  | 'whipLeft'
  | 'whipRight'
  | 'whipUp'
  | 'whipDown'
  | 'spin'
  | 'glitch'
  | 'rgbSplit'
  | 'flash'
  | 'shake'
  | 'blurZoom'
  | 'lightLeak';

export type ClipTransition = { kind: TransitionKind; duration: number };

export type FilterId =
  | 'none'
  | 'warm'
  | 'cool'
  | 'vivid'
  | 'film'
  | 'golden'
  | 'pastel'
  | 'kitty'
  | 'tealOrange'
  | 'retro'
  | 'dreamy'
  | 'bw'
  | 'noir';

/** Manual adjustments, each roughly −1..1 (vignette, sharpen and fade 0..1). Missing = 0. */
export type Adjust = {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  fade: number;
  sharpen: number;
  vignette: number;
};

export type Look = { filter: FilterId; amount: number; adjust: Partial<Adjust> };

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  aspect: '9:16';
  /** Main video track. Magnetic: clips play back to back with no gaps. */
  main: Clip[];
  /** Music / SFX / voiceover clips, freely positioned. Missing = none (projects from before Phase 3). */
  audio?: AudioClip[];
  /** Mix settings. Missing = defaults. */
  mix?: MixSettings;
  /** Text overlays (Phase 4). */
  texts?: TextItem[];
  /** Auto / manual captions (Phase 4). */
  captions?: Captions;
};

// ---- text & captions (Phase 4). Positions are fractions of the 9:16 frame; sizes are px of a 1080-wide frame. ----

export type FontId = 'montserrat' | 'poppins' | 'anton' | 'bebas' | 'bangers' | 'nunito';
export type TextAnimIn = 'none' | 'pop' | 'typewriter' | 'bounce' | 'slide' | 'fade';
export type TextAnimLoop = 'none' | 'bounce' | 'pulse' | 'wiggle' | 'glow';

export type TextStyle = {
  font: FontId;
  size: number;
  color: string;
  /** Outline colour, or null. Width scales with size. */
  outline: string | null;
  shadow: boolean;
  /** Background box colour, or null. */
  box: string | null;
  /** Soft glow colour, or null. */
  glow: string | null;
  uppercase: boolean;
};

export type TextItem = {
  id: string;
  text: string;
  start: number;
  duration: number;
  /** Centre, 0..1 of the frame. */
  x: number;
  y: number;
  scale: number;
  /** Degrees. */
  rotation: number;
  style: TextStyle;
  animIn: TextAnimIn;
  animOut: TextAnimIn;
  loop: TextAnimLoop;
};

export type CaptionPreset = 'wordPop' | 'karaoke' | 'boldOutline' | 'keyword';

export type CaptionWord = {
  id: string;
  text: string;
  start: number;
  end: number;
  /** 'split' forces a new caption before this word; 'join' keeps it with the previous one. */
  brk?: 'split' | 'join';
};

export type Captions = {
  words: CaptionWord[];
  preset: CaptionPreset;
  position: 'top' | 'middle' | 'bottom';
  /** Max characters per line, and lines per caption. */
  maxChars: number;
  lines: 1 | 2;
  /** Append a matching emoji (😺 for cat…). */
  emoji: boolean;
  /** Language used for transcription (kept for re-runs). */
  language: string;
};

export type AudioTrackKind = 'music' | 'sfx' | 'voice';

export type AudioClip = {
  id: string;
  track: AudioTrackKind;
  /** Library item (music, sound effect or recorded voiceover). */
  sourceId: string;
  /** Timeline position of the clip's first sample, seconds. */
  start: number;
  /** Source window, seconds. */
  inSec: number;
  outSec: number;
  /** Gain 0..2. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
};

export type MixSettings = {
  /** Lower music under voiceover and loud video sound. */
  duck: boolean;
  /** How far music drops while ducked, dB (negative). */
  duckDb: number;
};

export const DEFAULT_MIX: MixSettings = { duck: true, duckDb: -12 };

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** Shortest clip allowed on the timeline, seconds of timeline time. */
export const MIN_CLIP_SEC = 0.1;

const EPS = 1e-6;

export function newId(): string {
  return crypto.randomUUID();
}

export function createProject(name: string, now = Date.now()): Project {
  return { id: newId(), name, createdAt: now, updatedAt: now, aspect: '9:16', main: [] };
}

export function clipDuration(clip: Clip): number {
  return (clip.outSec - clip.inSec) / clip.speed;
}

export function projectDuration(project: Project): number {
  return project.main.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Timeline start time of every clip on the main track. */
export function clipStarts(project: Project): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const clip of project.main) {
    starts.push(t);
    t += clipDuration(clip);
  }
  return starts;
}

export type Located = { index: number; clip: Clip; start: number; end: number; sourceSec: number };

/**
 * Finds the clip playing at timeline time `t`. A time exactly on a cut belongs to the clip that starts there.
 * Times at or past the end resolve to the last frame of the last clip.
 */
export function locate(project: Project, t: number): Located | null {
  const clips = project.main;
  if (clips.length === 0) return null;
  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index] as Clip;
    const end = start + clipDuration(clip);
    const isLast = index === clips.length - 1;
    if (t < end - EPS || isLast) {
      const local = Math.min(Math.max(t - start, 0), end - start);
      const sourceSec = Math.min(clip.inSec + local * clip.speed, clip.outSec);
      return { index, clip, start, end, sourceSec };
    }
    start = end;
  }
  return null;
}

/** Timeline time at which the clip with `clipId` starts, or null. */
export function clipStart(project: Project, clipId: string): number | null {
  let t = 0;
  for (const clip of project.main) {
    if (clip.id === clipId) return t;
    t += clipDuration(clip);
  }
  return null;
}

function replaceMain(project: Project, main: Clip[]): Project {
  return { ...project, main };
}

/** Splits the clip under timeline time `t`. No-op if `t` is too close to a cut. */
export function splitAt(project: Project, t: number, makeId: () => string = newId): Project {
  const hit = locate(project, t);
  if (!hit) return project;
  if (t - hit.start < MIN_CLIP_SEC || hit.end - t < MIN_CLIP_SEC) return project;
  const left: Clip = { ...hit.clip, outSec: hit.sourceSec };
  const right: Clip = { ...hit.clip, id: makeId(), inSec: hit.sourceSec };
  const main = [...project.main];
  main.splice(hit.index, 1, left, right);
  return replaceMain(project, main);
}

export type TrimEdge = 'in' | 'out';

/**
 * Moves one edge of a clip to `sourceSec`, clamped to the asset bounds and to the minimum clip length.
 * Following clips ripple automatically because the main track is magnetic.
 */
export function trimClip(
  project: Project,
  clipId: string,
  edge: TrimEdge,
  sourceSec: number,
  assetDurationSec: number,
): Project {
  const main = project.main.map((clip) => {
    if (clip.id !== clipId) return clip;
    const minSource = MIN_CLIP_SEC * clip.speed;
    if (edge === 'in') {
      const inSec = Math.min(Math.max(sourceSec, 0), clip.outSec - minSource);
      return { ...clip, inSec };
    }
    const outSec = Math.max(Math.min(sourceSec, assetDurationSec), clip.inSec + minSource);
    return { ...clip, outSec };
  });
  return replaceMain(project, main);
}

/** Removes a clip; later clips slide left (ripple delete). */
export function removeClip(project: Project, clipId: string): Project {
  return replaceMain(
    project,
    project.main.filter((c) => c.id !== clipId),
  );
}

/** Removes main-track, audio and text clips with the given ids (main track ripples). */
export function removeClips(project: Project, clipIds: ReadonlySet<string>): Project {
  const audio = project.audio?.filter((c) => !clipIds.has(c.id));
  const texts = project.texts?.filter((t) => !clipIds.has(t.id));
  return {
    ...replaceMain(
      project,
      project.main.filter((c) => !clipIds.has(c.id)),
    ),
    ...(audio ? { audio } : {}),
    ...(texts ? { texts } : {}),
  };
}

export function setClipVolume(project: Project, clipIds: ReadonlySet<string>, volume: number): Project {
  const v = Math.min(Math.max(volume, 0), 2);
  return replaceMain(
    project,
    project.main.map((c) => (clipIds.has(c.id) ? { ...c, volume: v } : c)),
  );
}

export function setLook(project: Project, clipIds: ReadonlySet<string>, look: Look | null): Project {
  return replaceMain(
    project,
    project.main.map((c) => {
      if (!clipIds.has(c.id)) return c;
      if (look) return { ...c, look };
      const { look: _drop, ...rest } = c;
      return rest;
    }),
  );
}

export function duplicateClip(project: Project, clipId: string, makeId: () => string = newId): Project {
  const index = project.main.findIndex((c) => c.id === clipId);
  if (index < 0) return project;
  const main = [...project.main];
  main.splice(index + 1, 0, { ...(main[index] as Clip), id: makeId() });
  return replaceMain(project, main);
}

/** Moves the clip at `from` so it ends up at index `to` (indices in the final array). */
export function moveClip(project: Project, from: number, to: number): Project {
  const n = project.main.length;
  if (from < 0 || from >= n) return project;
  const target = Math.min(Math.max(to, 0), n - 1);
  if (target === from) return project;
  const main = [...project.main];
  const [clip] = main.splice(from, 1);
  main.splice(target, 0, clip as Clip);
  return replaceMain(project, main);
}

export function clampSpeed(speed: number): number {
  return Math.min(Math.max(speed, MIN_SPEED), MAX_SPEED);
}

export function setSpeed(project: Project, clipIds: ReadonlySet<string>, speed: number): Project {
  const s = clampSpeed(speed);
  return replaceMain(
    project,
    project.main.map((c) => (clipIds.has(c.id) ? { ...c, speed: s } : c)),
  );
}

export function appendClip(project: Project, clip: Clip): Project {
  return replaceMain(project, [...project.main, clip]);
}

export function clipForAsset(asset: Pick<Asset, 'id' | 'durationSec'>, makeId: () => string = newId): Clip {
  return { id: makeId(), assetId: asset.id, inSec: 0, outSec: asset.durationSec, speed: 1 };
}

/** Asset ids used by the project. */
export function textEnd(t: TextItem): number {
  return t.start + t.duration;
}

export function referencedAssets(project: Project): Set<string> {
  return new Set(project.main.map((c) => c.assetId));
}
