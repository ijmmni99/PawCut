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
