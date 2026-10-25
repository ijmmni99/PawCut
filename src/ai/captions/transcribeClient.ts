// Main-thread side of captions: collects the speech on the timeline (video clips' own sound + voiceovers) and runs
// Whisper in a worker that stays alive, so the model loads once per session.
import { useLibrary } from '../../library/audioLibrary';
import { useAssets } from '../../editor/store';
import { audioClips } from '../../editor/timeline/audio';
import { type Project, clipStarts } from '../../editor/timeline/model';
import type { CaptionLanguage, SpeechSource, TimedWord, TranscribeEvent, TranscribeRequest } from './protocol';

let worker: Worker | null = null;

/** Speech to transcribe: unmuted video clips (from their proxy) and voiceover clips, placed on the timeline. */
export function speechSources(p: Project): SpeechSource[] {
  const assets = useAssets.getState().assets;
  const library = useLibrary.getState().items;
  const starts = clipStarts(p);
  const out: SpeechSource[] = [];
  p.main.forEach((clip, i) => {
    const asset = assets[clip.assetId];
    const path = asset?.proxyPath ?? asset?.originalPath;
    if (!asset?.hasAudio || !path || (clip.volume ?? 1) <= 0) return;
    out.push({ path, inSec: clip.inSec, outSec: clip.outSec, timelineStart: starts[i] ?? 0, speed: clip.speed });
  });
  for (const c of audioClips(p)) {
    const item = library[c.sourceId];
    if (c.track !== 'voice' || !item || c.volume <= 0) continue;
    out.push({ path: item.path, inSec: c.inSec, outSec: c.outSec, timelineStart: c.start, speed: 1 });
  }
  return out;
}

export type CaptionQuality = 'fast' | 'best';

/** Tests pass ?whisper=tiny for a quicker model. */
const TEST_TINY = new URLSearchParams(location.search).get('whisper') === 'tiny';
const QUALITY_KEY = 'pawcut.captionQuality';

export function savedQuality(): CaptionQuality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'best' ? 'best' : 'fast';
  } catch {
    return 'fast';
  }
}

export function saveQuality(q: CaptionQuality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    // Private mode: just not remembered.
  }
}

export function transcribe(
  sources: SpeechSource[],
  language: CaptionLanguage,
  quality: CaptionQuality,
  onProgress: (stage: 'download' | 'audio' | 'transcribe', progress: number) => void,
): Promise<TimedWord[]> {
  worker ??= new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<TranscribeEvent>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.stage, m.progress);
      else if (m.type === 'done') resolve(m.words);
      else reject(new Error(m.message));
    };
    w.onerror = (e) => {
      // A crashed worker (e.g. out of memory) is replaced next time.
      worker = null;
      reject(new Error(e.message || 'Speech recognition stopped unexpectedly.'));
    };
    const model = TEST_TINY ? 'tiny' : quality === 'best' ? 'small' : 'base';
    const request: TranscribeRequest = { type: 'transcribe', sources, language, model };
    w.postMessage(request);
  });
}
