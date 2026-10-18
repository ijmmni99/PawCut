// Runs (or loads cached) Auto-Cut analyses. Results are cached in IndexedDB per asset, so analysing a clip once is
// enough no matter how many times Auto-Cut is opened.
import type { Asset } from '../../editor/timeline/model';
import { db } from '../../library/db';
import type { AnalyzeEvent, AnalyzeRequest } from './protocol';
import { ANALYSIS_VERSION, type AssetAnalysis } from './score';

let worker: Worker | null = null;
const waiting = new Map<
  string,
  { resolve(a: AssetAnalysis): void; reject(e: Error): void; onProgress(p: number): void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<AnalyzeEvent>) => {
    const msg = e.data;
    const job = waiting.get(msg.assetId);
    if (!job) return;
    if (msg.type === 'progress') job.onProgress(msg.progress);
    else if (msg.type === 'done') {
      waiting.delete(msg.assetId);
      console.info(`Auto-Cut analysis ${msg.assetId}: ${(msg.ms / 1000).toFixed(1)}s`);
      void db.analyses.put(msg.analysis);
      job.resolve(msg.analysis);
    } else {
      waiting.delete(msg.assetId);
      job.reject(new Error(msg.message));
    }
  };
  return worker;
}

function analyzeOne(asset: Asset, onProgress: (p: number) => void): Promise<AssetAnalysis> {
  const path = asset.proxyPath;
  if (!path) return Promise.reject(new Error(`“${asset.name}” is still being prepared.`));
  return new Promise((resolve, reject) => {
    waiting.set(asset.id, { resolve, reject, onProgress });
    const request: AnalyzeRequest = { type: 'analyze', assetId: asset.id, path };
    getWorker().postMessage(request);
  });
}

/** Analyses for `assets` (cached where possible). `onProgress` reports 0..1 across all of them. */
export async function getAnalyses(assets: Asset[], onProgress: (p: number) => void): Promise<AssetAnalysis[]> {
  const cached = await db.analyses.bulkGet(assets.map((a) => a.id));
  const results: AssetAnalysis[] = [];
  const todo = assets.filter((_, i) => cached[i]?.version !== ANALYSIS_VERSION);
  // Weight progress by duration so a long clip doesn't jump the bar.
  const totalSec = todo.reduce((s, a) => s + a.durationSec, 0) || 1;
  let doneSec = 0;
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i] as Asset;
    const hit = cached[i];
    if (hit && hit.version === ANALYSIS_VERSION) {
      results.push(hit);
      continue;
    }
    const analysis = await analyzeOne(asset, (p) => onProgress((doneSec + p * asset.durationSec) / totalSec));
    doneSec += asset.durationSec;
    results.push(analysis);
  }
  onProgress(1);
  return results;
}
