// Main-thread side of the import pipeline. Creates the asset row immediately so the UI can show progress,
// adds the clip to the project as soon as the file is probed, and records proxy/thumbnail paths when ready.
import { useAssets } from '../../editor/store';
import type { Asset } from '../../editor/timeline/model';
import { newId } from '../../editor/timeline/model';
import { db } from '../../library/db';
import { appendAssetClip } from '../../library/projects';
import { codecProfile } from '../codecProfile';
import { removeEntry } from '../storage/opfs';
import { PROXY_VERSION, type ImportEvent, type ImportRequest } from './protocol';

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
      // Progress is UI-only; not worth an IndexedDB write per tick. Background upgrades of ready assets stay silent.
      if (useAssets.getState().assets[e.assetId]?.status === 'importing') {
        useAssets.getState().patch(e.assetId, { progress: e.progress });
      }
      break;
    case 'probed': {
      const { durationSec, width, height, hasAudio, originalPath, color } = e.probe;
      await patchAsset(e.assetId, { durationSec, width, height, hasAudio, originalPath, color });
      const asset = useAssets.getState().assets[e.assetId];
      const projectId = targets.get(e.assetId);
      if (asset && projectId) await appendAssetClip(projectId, asset);
      break;
    }
    case 'ready': {
      targets.delete(e.assetId);
      const old = useAssets.getState().assets[e.assetId];
      await patchAsset(e.assetId, { ...e.proxy, status: 'ready', progress: 1, proxyVersion: PROXY_VERSION });
      if (e.upgrade && old) {
        // Drop the superseded files and the Auto-Cut analysis made from them.
        for (const path of [old.proxyPath, old.posterPath, old.thumbsPath]) {
          if (path && !Object.values(e.proxy).includes(path)) await removeEntry(path);
        }
        await db.analyses.delete(e.assetId);
      }
      break;
    }
    case 'unchanged':
      await patchAsset(e.assetId, { proxyVersion: PROXY_VERSION, progress: 1 });
      break;
    case 'error':
      targets.delete(e.assetId);
      // A failed background upgrade keeps the old (usable) proxy.
      if (useAssets.getState().assets[e.assetId]?.status === 'ready') break;
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

/** Rebuilds proxies made before the current PROXY_VERSION (only HDR sources actually change), in the background. */
export async function upgradeOldProxies(): Promise<void> {
  const old = (await db.assets.toArray()).filter(
    (a) => a.status === 'ready' && a.originalPath && (a.proxyVersion ?? 1) < PROXY_VERSION,
  );
  for (const a of old) {
    const request: ImportRequest = {
      type: 'import',
      assetId: a.id,
      source: { opfsPath: a.originalPath as string },
      profile: codecProfile,
      upgrade: true,
    };
    getWorker().postMessage(request);
  }
}

/** Re-runs preparation for an asset whose import failed, from the original already copied into OPFS. */
export async function retryImport(assetId: string): Promise<void> {
  const asset = useAssets.getState().assets[assetId];
  if (!asset?.originalPath) return;
  await patchAsset(assetId, { status: 'importing', progress: 0, error: null });
  const request: ImportRequest = {
    type: 'import',
    assetId,
    source: { opfsPath: asset.originalPath },
    profile: codecProfile,
  };
  getWorker().postMessage(request);
}
