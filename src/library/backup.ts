// Whole-library backup as one zip: manifest.json + the audio files. Built-in SFX and voiceovers are left out
// (built-ins are regenerated; voiceovers belong to projects).
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { writeFile } from '../engine/storage/fileClient';
import { readFile } from '../engine/storage/opfs';
import { useLibrary } from './audioLibrary';
import type { LibraryItem } from './audioTypes';
import { db } from './db';

type Manifest = { version: 1; items: LibraryItem[] };

export async function exportLibraryZip(): Promise<File> {
  const items = Object.values(useLibrary.getState().items).filter((i) => !i.builtin && i.kind !== 'voice');
  const files: Record<string, Uint8Array> = {};
  for (const item of items) files[item.path] = new Uint8Array(await (await readFile(item.path)).arrayBuffer());
  files['manifest.json'] = strToU8(JSON.stringify({ version: 1, items } satisfies Manifest));
  // Audio is already compressed: store, don't deflate.
  const zip = zipSync(files, { level: 0 });
  const date = new Date().toISOString().slice(0, 10);
  return new File([zip], `pawcut-library-${date}.zip`, { type: 'application/zip' });
}

/** Restores a backup. Items already in the library (same id) are kept as they are. Returns how many were added. */
export async function importLibraryZip(file: File): Promise<number> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) throw new Error('Not a PawCut library backup.');
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  const existing = useLibrary.getState().items;
  let added = 0;
  for (const item of manifest.items) {
    const bytes = entries[item.path];
    if (existing[item.id] || !bytes) continue;
    await writeFile(item.path, new Blob([bytes as Uint8Array<ArrayBuffer>]));
    await db.library.put(item);
    useLibrary.getState().upsert(item);
    added++;
  }
  return added;
}
