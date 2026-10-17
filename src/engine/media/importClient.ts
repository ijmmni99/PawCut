// Main-thread side of the import pipeline. Creates the asset row immediately so the UI can show progress,
// adds the clip to the project as soon as the file is probed, and records proxy/thumbnail paths when ready.
import { useAssets } from '../../editor/store';
import type { Asset } from '../../editor/timeline/model';
import { newId } from '../../editor/timeline/model';
import { db } from '../../library/db';
import { appendAssetClip } from '../../library/projects';
import { codecProfile } from '../codecProfile';
import type { ImportEvent, ImportRequest } from './protocol';

let worker: Worker | null = null;
const targets = new Map<string, string>(); // assetId -> projectId

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<ImportEvent>) => void handle(e.data);
  return worker;
}

async function patchAsset(id: string, patch: Partial<Asset>): Promise<void> {
  useAssets.getState().patch(id, patch);
  await db.assets.update(id, patch);
}

async function handle(e: ImportEvent): Promise<void> {
  switch (e.type) {
    case 'progress':
      // Progress is UI-only; not worth an IndexedDB write per tick.
      useAssets.getState().patch(e.assetId, { progress: e.progress });
      break;
    case 'probed': {
      const { durationSec, width, height, hasAudio, originalPath } = e.probe;
      await patchAsset(e.assetId, { durationSec, width, height, hasAudio, originalPath });
      const asset = useAssets.getState().assets[e.assetId];
      const projectId = targets.get(e.assetId);
      if (asset && projectId) await appendAssetClip(projectId, asset);
      break;
    }
    case 'ready':
      targets.delete(e.assetId);
      await patchAsset(e.assetId, { ...e.proxy, status: 'ready', progress: 1 });
      break;
    case 'error':
      targets.delete(e.assetId);
      await patchAsset(e.assetId, { status: 'error', error: e.message });
      break;
  }
}

/** Imports files in order and appends one clip per file to the project. */
export async function importFiles(projectId: string, files: File[]): Promise<void> {
  const w = getWorker();
  for (const file of files) {
    const asset: Asset = {
      id: newId(),
      kind: 'video',
      name: file.name,
      width: 0,
      height: 0,
      durationSec: 0,
      hasAudio: false,
      status: 'importing',
      progress: 0,
      error: null,
      originalPath: null,
      proxyPath: null,
      thumbsPath: null,
      posterPath: null,
      thumbInterval: 1,
      thumbCount: 0,
      thumbColumns: 1,
      thumbSize: 1,
      createdAt: Date.now(),
    };
    await db.assets.put(asset);
    useAssets.getState().upsert(asset);
    targets.set(asset.id, projectId);
    const request: ImportRequest = { type: 'import', assetId: asset.id, source: { file }, profile: codecProfile };
    w.postMessage(request);
  }
}

/**
 * Imports cut short by an app kill: if the original made it into OPFS, rebuild the proxy from it; otherwise the
 * picked file is gone and the asset is marked failed.
 */
export async function resumeInterruptedImports(): Promise<void> {
  const stuck = (await db.assets.toArray()).filter((a) => a.status === 'importing');
  for (const a of stuck) {
    if (!a.originalPath) {
      await patchAsset(a.id, { status: 'error', error: 'Import was interrupted. Please import the video again.' });
      continue;
    }
    const request: ImportRequest = {
      type: 'import',
      assetId: a.id,
      source: { opfsPath: a.originalPath },
      profile: codecProfile,
    };
    getWorker().postMessage(request);
  }
}
