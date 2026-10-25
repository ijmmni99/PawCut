/// <reference lib="webworker" />
// Whisper speech-to-text with word timestamps (Transformers.js, ONNX Runtime WASM with threads).
// The model downloads once from Hugging Face and is cached by Transformers.js (Cache API), so it works offline after.
import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from '@huggingface/transformers';
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { readFile } from '../../engine/storage/opfs';
import type { SpeechSource, TimedWord, TranscribeEvent, TranscribeRequest } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const SR = 16_000;
const MODELS = {
  base: 'onnx-community/whisper-base_timestamped',
  tiny: 'onnx-community/whisper-tiny_timestamped',
} as const;

const post = (e: TranscribeEvent) => self.postMessage(e);

// Self-hosted runtime (see scripts/copy-runtimes.mjs).
const ortBase = new URL('/ort/', self.location.origin).href;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: `${ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${ortBase}ort-wasm-simd-threaded.wasm` };
  onnx.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}
env.allowLocalModels = false;

// ---- model download: from our own origin (split into parts, see scripts/fetch-whisper.mjs), with retries ----

const HF = /^https:\/\/huggingface\.co\/onnx-community\/([\w.-]+)\/resolve\/[^/]+\/(.+)$/;
type Parts = Record<string, { size: number; parts: number }>;
const manifests = new Map<string, Promise<Parts | null>>();

function manifestFor(model: string): Promise<Parts | null> {
  let m = manifests.get(model);
  if (!m) {
    m = fetch(`/models/whisper/${model}/parts.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Parts>) : null))
      .catch(() => null);
    manifests.set(model, m);
  }
  return m;
}

/** fetch with retries (a flaky mobile connection shouldn't fail captions). Errors name the file. */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status === 404) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  const name = url.split('?')[0]?.split('/').slice(-2).join('/');
  throw new Error(`Couldn't download ${name}: ${last instanceof Error ? last.message : String(last)}`);
}

env.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const hit = HF.exec(url);
  const parts = hit ? await manifestFor(hit[1] as string) : null;
  const entry = hit && parts ? parts[hit[2] as string] : undefined;
  if (!hit || !entry) return fetchRetry(url, init);
  const base = `/models/whisper/${hit[1]}/${hit[2]}`;
  const blobs: Blob[] = [];
  for (let i = 0; i < entry.parts; i++) {
    const res = await fetchRetry(entry.parts === 1 ? base : `${base}.part${i}`);
    if (!res.ok) throw new Error(`Couldn't download ${hit[2]} (HTTP ${res.status})`);
    blobs.push(await res.blob());
  }
  const body = new Blob(blobs);
  return new Response(body, { status: 200, headers: { 'content-length': String(body.size) } });
}) as typeof env.fetch;

let loaded: { model: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function loadModel(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (loaded?.model === model) return loaded.asr;
  const files = new Map<string, { loaded: number; total: number }>();
  const asr = pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let done = 0;
      let total = 0;
      for (const f of files.values()) {
        done += f.loaded;
        total += f.total;
      }
      if (total > 0) post({ type: 'progress', stage: 'download', progress: done / total });
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  asr.catch(() => {
    loaded = null;
  });
  loaded = { model, asr };
  return asr;
}

/** Decodes [inSec, outSec] of a file's audio to 16 kHz mono. Null when the file has no sound. */
async function speechAudio(src: SpeechSource): Promise<Float32Array | null> {
  const input = new Input({ source: new BlobSource(await readFile(src.path)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const rate = track.sampleRate;
    const step = rate / SR;
    const total = Math.ceil((src.outSec - src.inSec) * SR);
    const out = new Float32Array(total);
    // Box-filter each output sample over its input span (cheap anti-aliasing, plenty for speech).
    let acc = 0;
    let n = 0;
    let inIndex = 0;
    let first: number | null = null;
    for await (const sample of new AudioSampleSink(track).samples(src.inSec, src.outSec)) {
      try {
        first ??= Math.round((sample.timestamp - src.inSec) * rate);
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        const mono = new Float32Array(frames);
        const plane = new Float32Array(frames);
        for (let c = 0; c < channels; c++) {
          sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let k = 0; k < frames; k++) mono[k] = (mono[k] as number) + (plane[k] as number) / channels;
        }
        for (let k = 0; k < frames; k++) {
          const pos = first + inIndex++;
          if (pos < 0) continue;
          const o = Math.floor(pos / step);
          if (o >= total) break;
          acc += mono[k] as number;
          n++;
          const nextBoundary = Math.floor((pos + 1) / step);
          if (nextBoundary !== o) {
            out[o] = acc / n;
            acc = 0;
            n = 0;
          }
        }
      } finally {
        sample.close();
      }
    }
    return out;
  } finally {
    input.dispose();
  }
}

type AsrChunk = { text: string; timestamp: [number, number | null] };

async function transcribe(req: TranscribeRequest): Promise<void> {
  post({ type: 'progress', stage: 'download', progress: 0 });
  const asr = await loadModel(MODELS[req.model]);
  const words: TimedWord[] = [];
  const sources = req.sources.filter((s) => s.outSec - s.inSec > 0.4);
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] as SpeechSource;
    post({ type: 'progress', stage: 'audio', progress: i / sources.length });
    const audio = await speechAudio(src);
    if (!audio) continue;
    post({ type: 'progress', stage: 'transcribe', progress: i / sources.length });
    const result = (await asr(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      ...(req.language === 'auto' ? {} : { language: req.language }),
    })) as { chunks?: AsrChunk[] };
    const len = audio.length / SR;
    for (const c of result.chunks ?? []) {
      const text = c.text.trim();
      if (!text) continue;
      const s = Math.min(c.timestamp[0], len);
      const e = Math.min(c.timestamp[1] ?? s + 0.3, len);
      words.push({
        text,
        start: src.timelineStart + s / src.speed,
        end: src.timelineStart + Math.max(e, s + 0.05) / src.speed,
      });
    }
  }
  words.sort((a, b) => a.start - b.start);
  post({ type: 'done', words });
}

self.onmessage = (e: MessageEvent<TranscribeRequest>) => {
  transcribe(e.data).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
