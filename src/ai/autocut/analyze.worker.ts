/// <reference lib="webworker" />
// Auto-Cut analysis of one asset's 540p proxy. One pass over video (4 samples/s: motion, brightness, sharpness,
// plus object detection every 0.5s) and one over audio (loudness + onsets), producing per-0.25s raw features.
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { readFile } from '../../engine/storage/opfs';
import { type SubjectDetector, type Subject, loadDetector, subjectScore } from './detector';
import { gridMotion, laplacianVariance, mean, rmsDb, toGray } from './features';
import type { AnalyzeEvent, AnalyzeRequest } from './protocol';
import { ANALYSIS_VERSION, type AssetAnalysis, BIN_SEC } from './score';

declare const self: DedicatedWorkerGlobalScope;

const METRIC_SHORT = 96;
const DETECT_SHORT = 192;
/** Detection every this many bins (0.5s); doubled if the device turns out to be slow. */
const DETECT_EVERY = 2;
const SLOW_DETECT_MS = 80;
const VIDEO_WEIGHT = 0.85;
const AUDIO_WINDOW_SEC = 0.05;

const post = (e: AnalyzeEvent) => self.postMessage(e);

let detectorPromise: Promise<SubjectDetector | null> | null = null;
const getDetector = () => (detectorPromise ??= loadDetector());

function fitShort(w: number, h: number, short: number): [number, number] {
  const scale = short / Math.min(w, h);
  return [Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale))];
}

async function analyze({ assetId, path }: AnalyzeRequest): Promise<void> {
  const started = performance.now();
  const input = new Input({ source: new BlobSource(await readFile(path)), formats: ALL_FORMATS });
  try {
    const [durationSec, video, audio] = await Promise.all([
      input.computeDuration(),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    if (!video) throw new Error('No video track');
    const bins = Math.max(1, Math.ceil(durationSec / BIN_SEC));
    const a: AssetAnalysis = {
      assetId,
      version: ANALYSIS_VERSION,
      binSec: BIN_SEC,
      durationSec,
      hasAudio: audio !== null,
      detector: 'unavailable',
      motionLocal: new Array<number>(bins).fill(0),
      motionGlobal: new Array<number>(bins).fill(0),
      brightness: new Array<number>(bins).fill(128),
      sharpness: new Array<number>(bins).fill(0),
      subject: new Array<number>(bins).fill(0),
      audioDb: new Array<number>(bins).fill(-100),
      onset: new Array<number>(bins).fill(0),
      createdAt: Date.now(),
    };

    // ---- video ----
    const detector = await getDetector();
    if (detector) a.detector = 'ok';
    const [dw, dh] = fitShort(video.displayWidth, video.displayHeight, DETECT_SHORT);
    const [mw, mh] = fitShort(video.displayWidth, video.displayHeight, METRIC_SHORT);
    const small = new OffscreenCanvas(mw, mh);
    const smallCtx = small.getContext('2d', { willReadFrequently: true });
    if (!smallCtx) throw new Error('2D canvas unavailable');
    const sink = new CanvasSink(video, { width: dw, height: dh, fit: 'fill', poolSize: 2 });
    const times = function* () {
      for (let i = 0; i < bins; i++) yield Math.min(i * BIN_SEC + BIN_SEC / 2, Math.max(0, durationSec - 0.01));
    };
    let prevGray: Float32Array | null = null;
    let prevSubject: Subject | null = null;
    let detectEvery = DETECT_EVERY;
    let detectMs = 0;
    let detectRuns = 0;
    let lastPost = 0;
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times())) {
      if (wrapped) {
        smallCtx.drawImage(wrapped.canvas, 0, 0, mw, mh);
        const gray = toGray(smallCtx.getImageData(0, 0, mw, mh).data, mw, mh);
        if (prevGray) {
          const m = gridMotion(prevGray, gray, mw, mh);
          a.motionLocal[i] = m.local;
          a.motionGlobal[i] = m.global;
        }
        a.brightness[i] = mean(gray);
        a.sharpness[i] = laplacianVariance(gray, mw, mh);
        prevGray = gray;

        if (detector && i % detectEvery === 0) {
          const t0 = performance.now();
          const subject = detector.detect(wrapped.canvas as OffscreenCanvas);
          detectMs += performance.now() - t0;
          detectRuns++;
          const value = subjectScore(prevSubject, subject);
          for (let k = i; k < Math.min(bins, i + detectEvery); k++) a.subject[k] = value;
          prevSubject = subject;
          // Slow device: halve the detection rate to stay inside the analysis budget.
          if (detectRuns === 6 && detectMs / detectRuns > SLOW_DETECT_MS) detectEvery *= 2;
        }
      }
      i++;
      const now = performance.now();
      if (now - lastPost > 200) {
        lastPost = now;
        post({ type: 'progress', assetId, progress: (i / bins) * VIDEO_WEIGHT });
      }
    }
    // Motion of bin 0 has no predecessor; borrow bin 1.
    if (bins > 1) {
      a.motionLocal[0] = a.motionLocal[1] ?? 0;
      a.motionGlobal[0] = a.motionGlobal[1] ?? 0;
    }

    // ---- audio ----
    if (audio) {
      const windowDb: number[] = [];
      const rate = audio.sampleRate;
      const windowLen = Math.round(rate * AUDIO_WINDOW_SEC);
      let carry = new Float32Array(0);
      for await (const sample of new AudioSampleSink(audio).samples()) {
        try {
          const n = sample.numberOfFrames;
          const mono = new Float32Array(carry.length + n);
          mono.set(carry);
          const plane = new Float32Array(n);
          for (let c = 0; c < sample.numberOfChannels; c++) {
            sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let k = 0; k < n; k++) mono[carry.length + k] = (mono[carry.length + k] as number) + (plane[k] as number) / sample.numberOfChannels;
          }
          let off = 0;
          for (; off + windowLen <= mono.length; off += windowLen) windowDb.push(rmsDb(mono, off, off + windowLen));
          carry = mono.slice(off);
        } finally {
          sample.close();
        }
      }
      const perBin = Math.round(BIN_SEC / AUDIO_WINDOW_SEC);
      for (let b = 0; b < bins; b++) {
        const slice = windowDb.slice(b * perBin, (b + 1) * perBin);
        if (slice.length === 0) continue;
        // Average power, back to dB.
        a.audioDb[b] = 10 * Math.log10(mean(slice.map((db) => 10 ** (db / 10))) || 1e-10);
        let jump = 0;
        for (let k = b * perBin; k < b * perBin + slice.length; k++) {
          jump = Math.max(jump, (windowDb[k] ?? -100) - (windowDb[k - 1] ?? windowDb[k] ?? -100));
        }
        a.onset[b] = jump;
      }
    }
    post({ type: 'progress', assetId, progress: 1 });
    post({ type: 'done', assetId, analysis: a, ms: performance.now() - started });
  } finally {
    input.dispose();
  }
}

let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const job = e.data;
  queue = queue.then(() =>
    analyze(job).catch((err: unknown) =>
      post({ type: 'error', assetId: job.assetId, message: err instanceof Error ? err.message : String(err) }),
    ),
  );
};
