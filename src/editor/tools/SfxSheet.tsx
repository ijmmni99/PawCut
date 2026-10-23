import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from '../../app/ui/Sheet';
import { ensureBuiltinSfx, importAudioFiles, markUsed, updateLibraryItem, useLibrary } from '../../library/audioLibrary';
import { stopPreview, togglePreview } from '../../library/audioPreview';
import type { LibraryItem } from '../../library/audioTypes';
import { useEditor, usePlayback } from '../store';
import { addAudioClip } from '../timeline/audio';
import { type AudioClip, type Project, clipStarts, newId } from '../timeline/model';

const CATEGORY_ORDER = ['Whoosh', 'Pop', 'Ding', 'Click', 'Boing', 'Riser', 'Impact', 'Cash', 'Camera', 'Mine'];

function sfxClip(item: LibraryItem, start: number): AudioClip {
  return {
    id: newId(),
    track: 'sfx',
    sourceId: item.id,
    start: Math.max(0, start),
    inSec: 0,
    outSec: item.durationSec,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

/** A whoosh centred just before every cut on the main track. */
function whooshOnCuts(p: Project, whoosh: LibraryItem): Project {
  const cuts = clipStarts(p).slice(1);
  return cuts.reduce((proj, t) => addAudioClip(proj, sfxClip(whoosh, t - whoosh.durationSec * 0.6)), p);
}

/** Sound effects: tap once to hear, tap the same one again to drop it at the playhead. */
export function SfxSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const items = useLibrary((s) => s.items);
  const [armed, setArmed] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    void ensureBuiltinSfx().catch((err: unknown) => setStatus(`Couldn't build sounds: ${String(err)}`));
  }, [open]);

  const sfx = useMemo(() => Object.values(items).filter((i) => i.kind === 'sfx'), [items]);
  const favorites = sfx.filter((i) => i.favorite);
  const groups = useMemo(() => {
    const by = new Map<string, LibraryItem[]>();
    for (const item of sfx) {
      const cat = item.category ?? 'Mine';
      by.set(cat, [...(by.get(cat) ?? []), item]);
    }
    return [...by.entries()].sort(
      ([a], [b]) => (CATEGORY_ORDER.indexOf(a) + 100) % 100 - ((CATEGORY_ORDER.indexOf(b) + 100) % 100),
    );
  }, [sfx]);

  const close = () => {
    stopPreview();
    setArmed(null);
    onClose();
  };

  const tap = (item: LibraryItem) => {
    if (armed === item.id) {
      const t = usePlayback.getState().time;
      useEditor.getState().apply((p) => addAudioClip(p, sfxClip(item, t)));
      void markUsed(item.id);
      stopPreview();
      setArmed(null);
      setStatus(`Added “${item.title}” at the playhead.`);
      return;
    }
    setArmed(item.id);
    void togglePreview(item.id);
  };

  const autoSfx = () => {
    const whoosh = items['sfx:whoosh'];
    const cuts = (useEditor.getState().project?.main.length ?? 1) - 1;
    if (!whoosh || cuts < 1) {
      setStatus('Auto-SFX needs at least one cut (split or Auto-Cut first).');
      return;
    }
    useEditor.getState().apply((p) => whooshOnCuts(p, whoosh));
    setStatus(`Added a whoosh on ${cuts} cut${cuts > 1 ? 's' : ''}.`);
  };

  const button = (item: LibraryItem) => (
    <div key={item.id} className="relative">
      <button
        type="button"
        onClick={() => tap(item)}
        className={`flex min-h-14 w-full items-center justify-center rounded-xl px-2 text-center text-xs font-semibold ${
          armed === item.id ? 'bg-pink-500 text-white ring-2 ring-white' : 'bg-zinc-800 text-zinc-100'
        }`}
      >
        {armed === item.id ? 'Tap to add' : item.title}
      </button>
      <button
        type="button"
        aria-label={item.favorite ? `Unfavourite ${item.title}` : `Favourite ${item.title}`}
        onClick={() => void updateLibraryItem(item.id, { favorite: !item.favorite })}
        className="absolute -right-1 -top-1 size-7 text-sm"
      >
        {item.favorite ? '⭐' : '☆'}
      </button>
    </div>
  );

  return (
    <Sheet open={open} onClose={close} title="✦ Sound effects">
      <div className="flex max-h-[66vh] flex-col gap-3 overflow-y-auto pb-1">
        <p className="text-xs text-zinc-400">Tap to hear it, tap again to add it at the playhead.</p>
        {status && <p className="text-xs text-emerald-300">{status}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={autoSfx} className="min-h-11 flex-1 rounded-xl bg-zinc-800 text-sm font-semibold">
            ⚡ Auto-SFX: whoosh on every cut
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} className="min-h-11 rounded-xl bg-zinc-800 px-3 text-sm font-semibold">
            Import
          </button>
        </div>
        {favorites.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Favourites</h3>
            <div className="grid grid-cols-3 gap-2">{favorites.map(button)}</div>
          </section>
        )}
        {sfx.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">Making sounds…</p>}
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{cat}</h3>
            <div className="grid grid-cols-3 gap-2">{list.map(button)}</div>
          </section>
        ))}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) {
            void importAudioFiles(files, 'sfx').then(({ failed }) =>
              setStatus(failed.length ? `Couldn't read: ${failed.join(', ')}` : 'Added to “Mine”.'),
            );
          }
        }}
      />
    </Sheet>
  );
}
