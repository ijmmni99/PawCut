// Music / SFX / voiceover library: shared by every project. Files live in OPFS (audio/<id>.<ext>), metadata in Dexie.
// Importing decodes once on the main thread (decodeAudioData handles mp3/m4a/wav/caf natively) to measure duration,
// draw a waveform and — for music — detect tempo and beats.
import { create } from 'zustand';
import { detectTempo, encodeWav, mixToMono, waveformPeaks } from '../engine/audio/analysis';
import { SFX_RECIPES, SFX_SAMPLE_RATE, SFX_VERSION, renderSfx } from '../engine/audio/sfx';
import { writeFile } from '../engine/storage/fileClient';
import { readFile, removeEntry } from '../engine/storage/opfs';
import { newId } from '../editor/timeline/model';
import type { LibraryItem, LibraryKind } from './audioTypes';
import { db, getSetting, setSetting } from './db';

type LibraryState = {
  items: Record<string, LibraryItem>;
  setAll(list: LibraryItem[]): void;
  upsert(item: LibraryItem): void;
  remove(id: string): void;
};

export const useLibrary = create<LibraryState>()((set) => ({
  items: {},
  setAll: (list) => set({ items: Object.fromEntries(list.map((i) => [i.id, i])) }),
  upsert: (item) => set((s) => ({ items: { ...s.items, [item.id]: item } })),
  remove: (id) =>
    set((s) => {
      const items = { ...s.items };
      delete items[id];
      return { items };
    }),
}));

export async function loadLibrary(): Promise<void> {
  useLibrary.getState().setAll(await db.library.toArray());
}

async function save(item: LibraryItem): Promise<void> {
  await db.library.put(item);
  useLibrary.getState().upsert(item);
}

export async function updateLibraryItem(id: string, patch: Partial<LibraryItem>): Promise<void> {
  const item = useLibrary.getState().items[id];
  if (item) await save({ ...item, ...patch });
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const item = useLibrary.getState().items[id];
  if (!item) return;
  await db.library.delete(id);
  useLibrary.getState().remove(id);
  await removeEntry(item.path);
  decoded.delete(id);
}

export async function markUsed(id: string): Promise<void> {
  await updateLibraryItem(id, { lastUsedAt: Date.now() });
}

// ---- decoding ----

let decodeCtx: OfflineAudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer>>();

async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  decodeCtx ??= new OfflineAudioContext(1, 1, 48_000);
  return decodeCtx.decodeAudioData(await blob.arrayBuffer());
}

/** Decoded audio of a library item (cached for the session). */
export function getAudioBuffer(id: string): Promise<AudioBuffer> {
  const cached = decoded.get(id);
  if (cached) return cached;
  const item = useLibrary.getState().items[id];
  if (!item) return Promise.reject(new Error('Audio not found in library'));
  const p = readFile(item.path).then(decodeBlob);
  p.catch(() => decoded.delete(id));
  decoded.set(id, p);
  return p;
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

function extensionOf(name: string, fallback: string): string {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? fallback;
}

function titleOf(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

/** Adds audio files to the library. Unreadable files are skipped and reported. */
export async function importAudioFiles(
  files: File[],
  kind: Exclude<LibraryKind, 'voice'>,
): Promise<{ added: LibraryItem[]; failed: string[] }> {
  const added: LibraryItem[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      added.push(await addAudio(file, kind, titleOf(file.name), file.name));
    } catch {
      failed.push(file.name);
    }
  }
  return { added, failed };
}

/** Stores and analyses one audio blob as a library item. */
export async function addAudio(
  blob: Blob,
  kind: LibraryKind,
  title: string,
  fileName: string,
  extra: Partial<LibraryItem> = {},
): Promise<LibraryItem> {
  const buffer = await decodeBlob(blob);
  const id = extra.id ?? newId();
  const path = `audio/${id}.${extensionOf(fileName, 'm4a')}`;
  await writeFile(path, blob);
  const channels = channelsOf(buffer);
  const tempo = kind === 'music' ? detectTempo(mixToMono(channels), buffer.sampleRate) : { bpm: null, beats: [] };
  const item: LibraryItem = {
    id,
    kind,
    title,
    fileName,
    path,
    durationSec: buffer.duration,
    waveform: waveformPeaks(channels, kind === 'music' ? 240 : 48),
    bpm: tempo.bpm,
    beats: tempo.beats,
    tags: [],
    mood: null,
    category: kind === 'sfx' ? 'Mine' : null,
    favorite: false,
    licenseNote: '',
    builtin: false,
    createdAt: Date.now(),
    lastUsedAt: null,
    ...extra,
  };
  decoded.set(id, Promise.resolve(buffer));
  await save(item);
  return item;
}

const SFX_KEY = 'builtinSfxVersion';

/** Renders the built-in sound effects into the library once (and again when the recipes change). */
export async function ensureBuiltinSfx(): Promise<void> {
  if ((await getSetting<number>(SFX_KEY)) === SFX_VERSION && SFX_RECIPES.every((r) => useLibrary.getState().items[`sfx:${r.id}`])) {
    return;
  }
  for (const recipe of SFX_RECIPES) {
    const id = `sfx:${recipe.id}`;
    const existing = useLibrary.getState().items[id];
    const channels = await renderSfx(recipe);
    const blob = new Blob([encodeWav(channels, SFX_SAMPLE_RATE)], { type: 'audio/wav' });
    decoded.delete(id);
    await addAudio(blob, 'sfx', recipe.name, `${recipe.id}.wav`, {
      id,
      category: recipe.category,
      builtin: true,
      licenseNote: 'Generated by PawCut — free to use',
      favorite: existing?.favorite ?? false,
      lastUsedAt: existing?.lastUsedAt ?? null,
    });
  }
  await setSetting(SFX_KEY, SFX_VERSION);
}
