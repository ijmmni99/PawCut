/// <reference lib="webworker" />
// Preview decoder. While playing it walks the timeline from the requested time and streams decoded proxy frames
// (as transferable VideoFrames) and PCM audio chunks to the main thread, running ahead of the playhead so cuts are
// already decoded before they're reached. During a transition the two clips' streams interleave (incoming = slot 1).
// Credit-based backpressure keeps only a handful of frames in flight.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type VideoSample, VideoSampleSink } from 'mediabunny';
import { type VoiceFxId, applyVoiceFx } from '../../engine/audio/voiceFx';
import { type TransferCode, trackTransfer } from '../../engine/media/hdr';
import { readFile } from '../../engine/storage/opfs';
import { type Asset, type Clip, type Project, clipDuration } from '../timeline/model';
import { clipWindow, cutsWithTransitions, sourceTime } from '../timeline/transitions';
import type { DecodedFrame, PreviewEvent, PreviewRequest, StillLayer } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/** Max decoded frames waiting on the main thread (~0.5s at 30fps). */
const FRAME_CREDITS = 16;
/** Audio is decoded at most this far ahead of the playhead. */
const AUDIO_AHEAD_SEC = 4;
/** Audio is posted in chunks of about this length. */
const AUDIO_CHUNK_SEC = 0.5;
/** Clip sound with a voice effect is processed in blocks of this length. */
const FX_BLOCK_SEC = 15;
/** At >1× speed, frames closer together than this (timeline seconds) are dropped. */
const MIN_FRAME_GAP = 1 / 40;

let project: Project | null = null;
let assets: Record<string, Asset> = {};
let gen = 0;
let inFlight = 0;
let clock = 0;
const waiters = new Set<() => void>();

const post = (e: PreviewEvent, transfer: Transferable[] = []) => self.postMessage(e, transfer);

// ---- media inputs (one per asset; switches from original to proxy once the proxy exists) ----

const inputs = new Map<string, { path: string; input: Input }>();
/** HDR transfer per file, from its metadata (Safari doesn't always label decoded frames). */
const transfers = new Map<Input, Promise<TransferCode>>();

async function transferOf(input: Input): Promise<TransferCode> {
  let t = transfers.get(input);
  if (!t) {
    t = input.getPrimaryVideoTrack().then((track) => (track ? trackTransfer(track) : 0));
    transfers.set(input, t);
  }
  return t;
}

/** Long-lived sinks for stills, so scrubbing reuses one decoder per file. */
const videoSinks = new Map<Input, VideoSampleSink>();

async function inputFor(assetId: string): Promise<Input | null> {
  const asset = assets[assetId];
  const path = asset?.proxyPath ?? asset?.originalPath;
  if (!path) return null;
  const cached = inputs.get(assetId);
  if (cached?.path === path) return cached.input;
  if (cached) {
    videoSinks.delete(cached.input);
    transfers.delete(cached.input);
    cached.input.dispose();
  }
  const input = new Input({ source: new BlobSource(await readFile(path)), formats: ALL_FORMATS });
  inputs.set(assetId, { path, input });
  return input;
}

/** Re-checks every waiting stream (credits returned, clock moved, or playback cancelled). */
function nudge(): void {
  const all = [...waiters];
  waiters.clear();
  for (const w of all) w();
}

/** Resolves when `ready()` holds or this playback generation is cancelled. Returns false if cancelled. */
async function waitUntil(myGen: number, ready: () => boolean): Promise<boolean> {
  while (myGen === gen && !ready()) {
    await new Promise<void>((resolve) => waiters.add(resolve));
  }
  return myGen === gen;
}

function timeline(from: number): Array<{ clip: Clip; start: number }> {
  const out: Array<{ clip: Clip; start: number }> = [];
  let start = 0;
  for (const clip of project?.main ?? []) {
    const end = start + clipDuration(clip);
    if (end > from + 1e-6) out.push({ clip, start });
    start = end;
  }
  return out;
}

// ---- playback streams ----

/** One clip's decoded-sample stream. Upcoming clips are opened and pre-decoded before they're needed. */
type ClipStream = {
  iter: AsyncGenerator<VideoSample> | null;
  transfer: TransferCode;
  buffer: VideoSample[];
  done: boolean;
  pump: Promise<void>;
};

/** Samples to pre-decode from an upcoming clip so its decoder is warm before the cut. */
const PREFETCH_SAMPLES = 4;
/** Open the next clip's stream this long (timeline seconds) before it appears. */
const PREOPEN_SEC = 1;

function openStream(clip: Clip, srcFrom: number, srcTo: number): ClipStream {
  const cs: ClipStream = { iter: null, transfer: 0, buffer: [], done: false, pump: Promise.resolve() };
  cs.pump = (async () => {
    const input = await inputFor(clip.assetId);
    const track = await input?.getPrimaryVideoTrack();
    if (!track) {
      cs.done = true;
      return;
    }
    cs.transfer = input ? await transferOf(input) : 0;
    cs.iter = new VideoSampleSink(track).samples(srcFrom, srcTo);
  })();
  return cs;
}

function prefetch(cs: ClipStream, myGen: number): void {
  cs.pump = cs.pump.then(async () => {
    while (cs.iter && !cs.done && cs.buffer.length < PREFETCH_SAMPLES && myGen === gen) {
      const r = await cs.iter.next();
      if (r.done) cs.done = true;
      else cs.buffer.push(r.value);
    }
  });
}

async function nextSample(cs: ClipStream): Promise<VideoSample | null> {
  await cs.pump;
  const buffered = cs.buffer.shift();
  if (buffered) return buffered;
  if (cs.done || !cs.iter) return null;
  const r = await cs.iter.next();
  if (r.done) {
    cs.done = true;
    return null;
  }
  return r.value;
}

async function closeStream(cs: ClipStream): Promise<void> {
  await cs.pump.catch(() => undefined);
  for (const s of cs.buffer) s.close();
  cs.buffer = [];
  await cs.iter?.return(undefined);
}

/**
 * What each clip contributes from `from` on: its on-screen window (including transition halves), the source range
 * to decode (running into spare footage around the cut when the file has it), and where its incoming transition
 * ends (frames before that go to slot 1, blended over the outgoing clip).
 */
type Segment = { clip: Clip; start: number; from: number; to: number; srcFrom: number; srcTo: number; slot1Until: number };

function segments(from: number): Segment[] {
  if (!project) return [];
  const cuts = cutsWithTransitions(project);
  const out: Segment[] = [];
  project.main.forEach((clip, i) => {
    const w = clipWindow(project as Project, cuts, i);
    if (w.to <= from + 1e-6) return;
    const dur = assets[clip.assetId]?.durationSec || clip.outSec;
    const visibleFrom = Math.max(w.from, from);
    const before = cuts.find((c) => c.index === i - 1);
    out.push({
      clip,
      start: w.start,
      from: visibleFrom,
      to: w.to,
      srcFrom: sourceTime(clip, w.start, visibleFrom, dur),
      srcTo: Math.min(dur, clip.inSec + (w.to - w.start) * clip.speed),
      slot1Until: before ? w.start + before.duration / 2 : -Infinity,
    });
  });
  return out;
}

type Active = {
  seg: Segment;
  cs: ClipStream;
  head: VideoSample | null;
  headT: number;
  lastT: number;
  /** Nothing posted yet (an upcoming clip, still warming up in the background). */
  first: boolean;
  ended: boolean;
};

/** Streams frames of every visible clip in timeline order; during a transition two clips interleave. */
async function streamVideo(myGen: number, from: number): Promise<void> {
  const segs = segments(from);
  let next = 0;
  const open: Active[] = [];
  const tOf = (a: Active, sample: VideoSample) => a.seg.start + (sample.timestamp - a.seg.clip.inSec) / a.seg.clip.speed;
  /** Next usable sample of a stream, dropping frames that are too early or too close together. */
  const fill = async (a: Active) => {
    while (!a.head && !a.ended) {
      const sample = await nextSample(a.cs);
      if (!sample) {
        a.ended = true;
        break;
      }
      const t = tOf(a, sample);
      if (t >= a.seg.to) {
        sample.close();
        a.ended = true;
        break;
      }
      if (t < from - 1 / 30 || t - a.lastT < MIN_FRAME_GAP) {
        sample.close();
        continue;
      }
      a.head = sample;
      a.headT = t;
    }
  };
  const frontier = () => open.reduce((m, a) => (a.head ? Math.min(m, a.headT) : m), Infinity);
  try {
    for (;;) {
      if (myGen !== gen) return;
      // Clips already playing first; an upcoming clip is only waited on once its time has come, so warming it up
      // (in the background) never stalls the clip on screen.
      for (const a of open) if (!a.first) await fill(a);
      for (const a of open) if (a.first && !a.head && a.seg.from <= frontier()) await fill(a);
      for (let i = open.length - 1; i >= 0; i--) {
        const a = open[i] as Active;
        if (a.ended && !a.head) {
          open.splice(i, 1);
          await closeStream(a.cs);
        }
      }
      const upcoming = segs[next];
      if (upcoming && (open.length === 0 || upcoming.from <= frontier() + PREOPEN_SEC)) {
        const cs = openStream(upcoming.clip, upcoming.srcFrom, upcoming.srcTo);
        prefetch(cs, myGen);
        open.push({ seg: upcoming, cs, head: null, headT: Infinity, lastT: -Infinity, first: true, ended: false });
        next++;
        continue;
      }
      const ready = open.filter((x) => x.head);
      if (ready.length === 0) {
        if (open.length === 0) break;
        continue;
      }
      const a = ready.reduce((m, x) => (x.headT < m.headT ? x : m));
      const sample = a.head as VideoSample;
      a.head = null;
      if (!(await waitUntil(myGen, () => inFlight < FRAME_CREDITS))) {
        sample.close();
        return;
      }
      // A clip with no footage before its in-point holds its first frame from the start of its window.
      const t = a.first ? Math.min(a.headT, Math.max(a.seg.from, from)) : a.headT;
      a.first = false;
      a.lastT = a.headT;
      a.headT = Infinity;
      const frame = sample.toVideoFrame();
      const rotation = sample.rotation;
      sample.close();
      inFlight++;
      const slot = t < a.seg.slot1Until ? 1 : 0;
      post({ type: 'frame', gen: myGen, t, slot, frame, rotation, transfer: a.cs.transfer, clipId: a.seg.clip.id }, [frame]);
    }
  } finally {
    for (const a of open) {
      a.head?.close();
      await closeStream(a.cs);
    }
  }
  if (myGen === gen) post({ type: 'end', gen: myGen });
}

async function streamAudio(myGen: number, from: number): Promise<void> {
  for (const { clip, start } of timeline(from)) {
    const input = await inputFor(clip.assetId);
    const track = await input?.getPrimaryAudioTrack();
    if (myGen !== gen) return;
    if (!track || (clip.volume ?? 1) <= 0) continue;
    const srcFrom = clip.inSec + Math.max(0, from - start) * clip.speed;
    const sink = new AudioSampleSink(track);
    let pending: Float32Array[][] = [];
    let pendingFrames = 0;
    let pendingStart = 0;
    let rate = track.sampleRate;

    const combine = () => {
      const channelCount = pending[0]?.length ?? 1;
      const channels = Array.from({ length: channelCount }, () => new Float32Array(pendingFrames));
      let off = 0;
      for (const part of pending) {
        for (let c = 0; c < channelCount; c++) channels[c]?.set(part[c] ?? (part[0] as Float32Array), off);
        off += part[0]?.length ?? 0;
      }
      return channels;
    };
    // A short first block so effected sound starts promptly, then longer ones.
    let fxBlockSec = 3;
    /** Applies the voice effect to everything pending and posts it in paced chunks. False if playback stopped. */
    const postFx = async (fx: VoiceFxId): Promise<boolean> => {
      if (pendingFrames === 0) return true;
      const processed = applyVoiceFx(combine(), rate, fx);
      const blockStart = pendingStart;
      const frames = pendingFrames;
      pending = [];
      pendingFrames = 0;
      const chunk = Math.round(AUDIO_CHUNK_SEC * rate);
      for (let off = 0; off < frames; off += chunk) {
        const t = start + (blockStart + off / rate - clip.inSec) / clip.speed;
        if (!(await waitUntil(myGen, () => t < clock + AUDIO_AHEAD_SEC))) return false;
        const channels = processed.map((ch) => ch.slice(off, off + chunk));
        post(
          { type: 'audio', gen: myGen, t, speed: clip.speed, volume: clip.volume ?? 1, sampleRate: rate, channels },
          channels.map((c) => c.buffer as ArrayBuffer),
        );
      }
      return true;
    };
    const flush = () => {
      if (pendingFrames === 0) return;
      const channels = combine();
      const t = start + (pendingStart - clip.inSec) / clip.speed;
      post(
        { type: 'audio', gen: myGen, t, speed: clip.speed, volume: clip.volume ?? 1, sampleRate: rate, channels },
        channels.map((c) => c.buffer as ArrayBuffer),
      );
      pending = [];
      pendingFrames = 0;
    };

    for await (const sample of sink.samples(srcFrom, clip.outSec)) {
      try {
        if (myGen !== gen) return;
        rate = sample.sampleRate;
        // Trim to [srcFrom, outSec].
        const skip = Math.max(0, Math.round((srcFrom - sample.timestamp) * rate));
        const endFrame = Math.min(sample.numberOfFrames, Math.round((clip.outSec - sample.timestamp) * rate));
        const count = endFrame - skip;
        if (count <= 0) continue;
        const part: Float32Array[] = [];
        for (let c = 0; c < sample.numberOfChannels; c++) {
          const plane = new Float32Array(count);
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar', frameOffset: skip, frameCount: count });
          part.push(plane);
        }
        if (pendingFrames === 0) pendingStart = sample.timestamp + skip / rate;
        pending.push(part);
        pendingFrames += count;
      } finally {
        sample.close();
      }
      // A voice effect needs longer stretches (echo tails, pitch grains): processed in blocks.
      if (clip.voiceFx) {
        if (pendingFrames >= fxBlockSec * rate) {
          if (!(await postFx(clip.voiceFx))) return;
          fxBlockSec = FX_BLOCK_SEC;
        }
        continue;
      }
      if (pendingFrames >= AUDIO_CHUNK_SEC * rate) {
        const chunkT = start + (pendingStart - clip.inSec) / clip.speed;
        if (!(await waitUntil(myGen, () => chunkT < clock + AUDIO_AHEAD_SEC))) return;
        flush();
      }
    }
    if (clip.voiceFx && !(await postFx(clip.voiceFx))) return;
    flush();
  }
}

// ---- stills (scrubbing) ----

let stillRequest: { id: number; layers: StillLayer[] } | null = null;
let stillBusy = false;

async function decodeStill(layer: StillLayer): Promise<DecodedFrame | null> {
  const input = await inputFor(layer.assetId);
  const track = await input?.getPrimaryVideoTrack();
  if (!input || !track) return null;
  let sink = videoSinks.get(input);
  if (!sink) {
    sink = new VideoSampleSink(track);
    videoSinks.set(input, sink);
  }
  const sample = await sink.getSample(layer.sourceSec).catch(() => null);
  if (!sample) return null;
  const frame = sample.toVideoFrame();
  const rotation = sample.rotation;
  sample.close();
  return { frame, rotation, transfer: await transferOf(input), clipId: layer.clipId };
}

async function serveStills(): Promise<void> {
  if (stillBusy) return;
  stillBusy = true;
  try {
    while (stillRequest) {
      const { id, layers } = stillRequest;
      stillRequest = null;
      const frames: Array<DecodedFrame | null> = [];
      for (const layer of layers) {
        // A newer request arrived meanwhile: drop this one.
        if (stillRequest) break;
        frames.push(await decodeStill(layer));
      }
      if (frames.length < layers.length) {
        for (const f of frames) f?.frame.close();
        continue;
      }
      post({ type: 'still', id, layers: frames }, frames.flatMap((f) => (f ? [f.frame] : [])));
    }
  } finally {
    stillBusy = false;
  }
}

self.onmessage = (e: MessageEvent<PreviewRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'sync':
      project = msg.project;
      assets = msg.assets;
      break;
    case 'play':
      gen = msg.gen;
      inFlight = 0;
      clock = msg.from;
      nudge();
      void streamVideo(msg.gen, msg.from).catch((err: unknown) => {
        console.warn('preview video', err);
        post({ type: 'error', gen: msg.gen, message: err instanceof Error ? err.message : String(err) });
      });
      void streamAudio(msg.gen, msg.from).catch((err: unknown) => console.warn('preview audio', err));
      break;
    case 'stop':
      gen = msg.gen;
      nudge();
      break;
    case 'ack':
      if (msg.gen === gen) {
        inFlight = Math.max(0, inFlight - msg.frames);
        clock = msg.clock;
        nudge();
      }
      break;
    case 'still':
      stillRequest = msg;
      void serveStills();
      break;
  }
};
