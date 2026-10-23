import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadFile, formatDuration, shareFile } from '../../app/share';
import { Sheet } from '../../app/ui/Sheet';
import {
  deleteLibraryItem,
  ensureBuiltinMusic,
  importAudioFiles,
  markUsed,
  updateLibraryItem,
  useLibrary,
} from '../../library/audioLibrary';
import { stopPreview, togglePreview, usePreview } from '../../library/audioPreview';
import { MOODS, MUSIC_TAGS, type LibraryItem } from '../../library/audioTypes';
import { exportLibraryZip, importLibraryZip } from '../../library/backup';
import { useEditor } from '../store';
import { addAudioClip, fittedMusicClip } from '../timeline/audio';
import { projectDuration } from '../timeline/model';
import { OffsetPicker } from './OffsetPicker';

type Filter = 'all' | 'fav' | 'recent' | 'slow' | 'mid' | 'fast' | (typeof MUSIC_TAGS)[number];

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fav', label: '⭐ Favourites' },
  { id: 'recent', label: 'Recent' },
  ...MUSIC_TAGS.map((t) => ({ id: t as Filter, label: `#${t}` })),
  { id: 'slow', label: '< 100 BPM' },
  { id: 'mid', label: '100–130' },
  { id: 'fast', label: '> 130' },
];

function matches(item: LibraryItem, filter: Filter, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q && !`${item.title} ${item.tags.join(' ')} ${item.mood ?? ''}`.toLowerCase().includes(q)) return false;
  const bpm = item.bpm ?? 0;
  switch (filter) {
    case 'all':
      return true;
    case 'fav':
      return item.favorite;
    case 'recent':
      return item.lastUsedAt !== null;
    case 'slow':
      return bpm > 0 && bpm < 100;
    case 'mid':
      return bpm >= 100 && bpm <= 130;
    case 'fast':
      return bpm > 130;
    default:
      return item.tags.includes(filter);
  }
}

/** Music library: shared across projects. "Use" adds the track fitted to the video with a fade-out. */
export function MusicSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const items = useLibrary((s) => s.items);
  const playingId = usePreview((s) => s.playingId);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const videoSec = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  const [composing, setComposing] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void ensureBuiltinMusic((done, total) => {
      setComposing(done < total ? `Composing PawCut tracks… ${done}/${total}` : null);
    })
      .then(() => setComposing(null))
      .catch((err: unknown) => setComposing(`Couldn't compose built-in tracks: ${String(err)}`));
  }, [open]);

  const music = useMemo(
    () =>
      Object.values(items)
        .filter((i) => i.kind === 'music' && matches(i, filter, query))
        .sort((a, b) =>
          filter === 'recent' ? (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) : Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt,
        ),
    [items, filter, query],
  );

  const close = () => {
    stopPreview();
    onClose();
  };

  const use = (item: LibraryItem) => {
    const inSec = offsets[item.id] ?? 0;
    useEditor.getState().apply((p) => addAudioClip(p, fittedMusicClip(item.id, item.durationSec, projectDuration(p), inSec)));
    void markUsed(item.id);
    close();
  };

  const onImport = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(`Adding ${files.length} track${files.length > 1 ? 's' : ''}…`);
    const { failed } = await importAudioFiles(files, 'music');
    setBusy(failed.length ? `Couldn't read: ${failed.join(', ')}` : null);
  };

  const backup = async () => {
    setMenu(false);
    setBusy('Packing library…');
    try {
      const file = await exportLibraryZip();
      setBusy(null);
      await shareFile(file).catch(() => downloadFile(file));
    } catch (err) {
      setBusy(`Backup failed: ${String(err)}`);
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    setBusy('Restoring…');
    try {
      setBusy(`Restored ${await importLibraryZip(file)} item(s).`);
    } catch (err) {
      setBusy(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleTag = (item: LibraryItem, tag: string) =>
    void updateLibraryItem(item.id, {
      tags: item.tags.includes(tag) ? item.tags.filter((t) => t !== tag) : [...item.tags, tag],
    });

  return (
    <Sheet open={open} onClose={close} title="♫ Music">
      <div className="flex max-h-[68vh] flex-col gap-3">
        <div className="flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, tag, mood"
            className="min-h-11 min-w-0 flex-1 rounded-xl bg-zinc-800 px-3 text-sm outline-none"
          />
          <button type="button" onClick={() => fileInput.current?.click()} className="min-h-11 rounded-xl bg-pink-500 px-3 text-sm font-bold">
            Import
          </button>
          <button type="button" aria-label="Library options" onClick={() => setMenu(!menu)} className="min-h-11 w-11 rounded-xl bg-zinc-800">
            ⋯
          </button>
        </div>
        {menu && (
          <div className="flex gap-2">
            <button type="button" onClick={() => void backup()} className="min-h-10 flex-1 rounded-xl bg-zinc-800 text-sm font-semibold">
              Back up library (.zip)
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                zipInput.current?.click();
              }}
              className="min-h-10 flex-1 rounded-xl bg-zinc-800 text-sm font-semibold"
            >
              Restore backup
            </button>
          </div>
        )}
        {busy && <p className="text-xs text-zinc-400">{busy}</p>}
        {composing && <p className="text-xs text-zinc-400">{composing}</p>}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`min-h-9 shrink-0 rounded-full px-3 text-xs font-semibold ${filter === f.id ? 'bg-zinc-100 text-black' : 'bg-zinc-800 text-zinc-300'}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {music.length === 0 && (
            <li className="py-8 text-center text-sm text-zinc-500">
              {Object.values(items).some((i) => i.kind === 'music')
                ? 'Nothing matches.'
                : 'No music yet. Tap Import to add mp3, m4a or wav files — they stay in your library for every project.'}
            </li>
          )}
          {music.map((item) => (
            <li key={item.id} className="border-b border-zinc-800 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={playingId === item.id ? 'Stop preview' : 'Preview'}
                  onClick={() => void togglePreview(item.id, offsets[item.id] ?? 0)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full bg-zinc-800"
                >
                  {playingId === item.id ? '■' : '▶'}
                </button>
                <button type="button" onClick={() => setExpanded(expanded === item.id ? null : item.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-semibold">{item.title}</div>
                  <div className="truncate text-xs text-zinc-500">
                    {formatDuration(item.durationSec)}
                    {item.bpm ? ` · ${Math.round(item.bpm)} BPM` : ''}
                    {item.mood ? ` · ${item.mood}` : ''}
                    {item.tags.length ? ` · ${item.tags.map((t) => `#${t}`).join(' ')}` : ''}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={item.favorite ? 'Unfavourite' : 'Favourite'}
                  onClick={() => void updateLibraryItem(item.id, { favorite: !item.favorite })}
                  className="size-11 shrink-0 text-lg"
                >
                  {item.favorite ? '⭐' : '☆'}
                </button>
                <button type="button" onClick={() => use(item)} className="min-h-10 shrink-0 rounded-full bg-pink-500 px-4 text-sm font-bold">
                  Use
                </button>
              </div>
              {expanded === item.id && (
                <div className="mt-3 space-y-3 rounded-xl bg-zinc-800/60 p-3">
                  <OffsetPicker
                    item={item}
                    windowSec={videoSec || item.durationSec}
                    value={offsets[item.id] ?? 0}
                    onChange={(v) => setOffsets({ ...offsets, [item.id]: v })}
                  />
                  <input
                    defaultValue={item.title}
                    onBlur={(e) => void updateLibraryItem(item.id, { title: e.target.value.trim() || item.title })}
                    className="min-h-10 w-full rounded-lg bg-zinc-900 px-3 text-sm"
                    aria-label="Title"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {MUSIC_TAGS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleTag(item, t)}
                        className={`min-h-9 rounded-full px-3 text-xs font-semibold ${item.tags.includes(t) ? 'bg-pink-500' : 'bg-zinc-900'}`}
                      >
                        #{t}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {MOODS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => void updateLibraryItem(item.id, { mood: item.mood === m ? null : m })}
                        className={`min-h-9 rounded-full px-3 text-xs ${item.mood === m ? 'bg-zinc-100 text-black' : 'bg-zinc-900'}`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {item.builtin ? (
                    <p className="text-xs text-zinc-500">{item.licenseNote}</p>
                  ) : (
                    <>
                      <input
                        defaultValue={item.licenseNote}
                        placeholder="License note (e.g. Pixabay — commercial OK)"
                        onBlur={(e) => void updateLibraryItem(item.id, { licenseNote: e.target.value })}
                        className="min-h-10 w-full rounded-lg bg-zinc-900 px-3 text-sm"
                        aria-label="License note"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Remove “${item.title}” from your library?`)) void deleteLibraryItem(item.id);
                        }}
                        className="min-h-10 w-full rounded-lg bg-red-950 text-sm font-semibold text-red-300"
                      >
                        Remove from library
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.aac,.caf"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void onImport(files);
        }}
      />
      <input
        ref={zipInput}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void restore(file);
        }}
      />
    </Sheet>
  );
}
