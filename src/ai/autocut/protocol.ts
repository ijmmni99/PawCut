import type { AssetAnalysis } from './score';

export type AnalyzeRequest = { type: 'analyze'; assetId: string; path: string };

export type AnalyzeEvent =
  | { type: 'progress'; assetId: string; progress: number }
  | { type: 'done'; assetId: string; analysis: AssetAnalysis; ms: number }
  | { type: 'error'; assetId: string; message: string };
