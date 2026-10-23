/// <reference lib="webworker" />
// Preview decoder. While playing it walks the timeline from the requested time and streams decoded proxy frames
// (as transferable VideoFrames) and PCM audio chunks to the main thread, running ahead of the playhead so cuts are
// already decoded before they're reached. Credit-based backpressure keeps only a handful of frames in flight.
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type VideoSample, VideoSampleSink } from 'mediabunny';
import { type TransferCode, trackTransfer } from '../../engine/media/hdr';
import { readFile } from '../../engine/storage/opfs';
import { type Asset, type Clip, type Project, clipDuration } from '../timeline/model';
import type { PreviewEvent, PreviewRequest } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/** Max decoded frames waiting on the main thread (~0.5s at 30fps). */
const FRAME_CREDITS = 16;
/** Audio is decoded at most this far ahead of the playhead. */
const AUDIO_AHEAD_SEC = 4;
/** Audio is posted in chunks of about this length. */
const AUDIO_CHUNK_SEC = 0.5;
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

/** One clip's decoded-sample stream. The next clip's stream is opened and pre-decoded while the current one plays. */
type ClipStream = {
  iter: AsyncGenerator<VideoSample> | null;
  transfer: TransferCode;
  buffer: VideoSample[];
  done: boolean;
  pump: Promise<void>;
};

/** Samples to pre-decode from the next clip so its decoder is warm before the cut. */
const PREFETCH_SAMPLES = 4;

function openStream(clip: Clip, srcFrom: number): ClipStream {
  const cs: ClipStream = { iter: null, transfer: 0, buffer: [], done: false, pump: Promise.resolve() };
  cs.pump = (async () => {
    const input = await inputFor(clip.assetId);
    const track = await input?.getPrimaryVideoTrack();
    if (!track) {
      cs.done = true;
      return;
    }
    cs.transfer = input ? await transferOf(input) : 0;
    cs.iter = new VideoSampleSink(track).samples(srcFrom, clip.outSec);
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

async function streamVideo(myGen: number, from: number): Promise<void> {
  const entries = timeline(from);
  const srcFromOf = (i: number) => {
    const e = entries[i];
    return e ? e.clip.inSec + Math.max(0, from - e.start) * e.clip.speed : 0;
  };
  let current = entries[0] ? openStream(entries[0].clip, srcFromOf(0)) : null;
  try {
    for (let i = 0; i < entries.length && current; i++) {
      const { clip, start } = entries[i] as { clip: Clip; start: number };
      const nextEntry = entries[i + 1];
      let next: ClipStream | null = null;
      let lastT = -Infinity;
      for (;;) {
        const sample = await nextSample(current);
        if (!sample) break;
        if (myGen !== gen) {
          sample.close();
          if (next) await closeStream(next);
          return;
        }
        const t = start + (sample.timestamp - clip.inSec) / clip.speed;
        if (t < from - 1 / 30 || t - lastT < MIN_FRAME_GAP) {
          sample.close();
          continue;
        }
        if (!(await waitUntil(myGen, () => inFlight < FRAME_CREDITS))) {
          sample.close();
          if (next) await closeStream(next);
          return;
        }
        const frame = sample.toVideoFrame();
        const rotation = sample.rotation;
        sample.close();
        inFlight++;
        lastT = t;
        post({ type: 'frame', gen: myGen, t: Math.max(t, start), frame, rotation, transfer: current.transfer }, [frame]);
        // Once this clip is flowing, warm up the next one in the background.
        if (!next && nextEntry) {
          next = openStream(nextEntry.clip, srcFromOf(i + 1));
          prefetch(next, myGen);
        }
      }
      await closeStream(current);
      current = next ?? (nextEntry ? openStream(nextEntry.clip, srcFromOf(i + 1)) : null);
    }
  } finally {
    if (current) await closeStream(current);
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

    const flush = () => {
      if (pendingFrames === 0) return;
      const channelCount = pending[0]?.length ?? 1;
      const channels = Array.from({ length: channelCount }, () => new Float32Array(pendingFrames));
      let off = 0;
      for (const part of pending) {
        for (let c = 0; c < channelCount; c++) channels[c]?.set(part[c] ?? (part[0] as Float32Array), off);
        off += part[0]?.length ?? 0;
      }
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
      if (pendingFrames >= AUDIO_CHUNK_SEC * rate) {
        const chunkT = start + (pendingStart - clip.inSec) / clip.speed;
        if (!(await waitUntil(myGen, () => chunkT < clock + AUDIO_AHEAD_SEC))) return;
        flush();
      }
    }
    flush();
  }
}

// ---- stills (scrubbing) ----

let stillRequest: { id: number; assetId: string; sourceSec: number } | null = null;
let stillBusy = false;

async function serveStills(): Promise<void> {
  if (stillBusy) return;
  stillBusy = true;
  try {
    while (stillRequest) {
      const { id, assetId, sourceSec } = stillRequest;
      stillRequest = null;
      const input = await inputFor(assetId);
      const track = await input?.getPrimaryVideoTrack();
      let sink = input ? videoSinks.get(input) : undefined;
      if (input && track && !sink) {
        sink = new VideoSampleSink(track);
        videoSinks.set(input, sink);
      }
      // A newer request arrived while we were opening the file: skip straight to it.
      if (stillRequest) continue;
      const sample = sink ? await sink.getSample(sourceSec).catch(() => null) : null;
      if (!sample) {
        post({ type: 'still', id, frame: null, rotation: 0, transfer: 0 });
        continue;
      }
      const frame = sample.toVideoFrame();
      const rotation = sample.rotation;
      sample.close();
      const transfer = input ? await transferOf(input) : 0;
      post({ type: 'still', id, frame, rotation, transfer }, [frame]);
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
