// Filters (one-tap looks with an intensity slider) and Adjust (exposure … vignette) for the target clips or all
// clips. Changes show live on the paused preview; one undo step per visit.
import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '../../app/ui/Sheet';
import { ADJUST_KEYS, ADJUST_LABELS, ADJUST_POSITIVE, FILTERS, FILTER_IDS } from '../../engine/render/looks';
import { useEditor } from '../store';
import { type Adjust, type FilterId, type Look, setLook } from '../timeline/model';

const EMPTY: Look = { filter: 'none', amount: 1, adjust: {} };

export function FilterSheet({ open, onClose, clipIds }: { open: boolean; onClose(): void; clipIds: string[] }) {
  const main = useEditor((s) => s.project?.main);
  const allIds = useMemo(() => main?.map((c) => c.id) ?? [], [main]);
  const [scope, setScope] = useState<'these' | 'all'>('these');
  const [tab, setTab] = useState<'filters' | 'adjust'>('filters');
  const ids = scope === 'all' ? allIds : clipIds;
  const look = useEditor((s) => s.project?.main.find((c) => c.id === ids[0])?.look) ?? EMPTY;

  useEffect(() => {
    if (!open) return;
    useEditor.getState().beginGesture();
    return () => useEditor.getState().endGesture();
  }, [open]);

  const save = (next: Look) => {
    const neutral = next.filter === 'none' && Object.values(next.adjust).every((v) => !v);
    useEditor.getState().apply((p) => setLook(p, new Set(ids), neutral ? null : next));
  };
  const setAdjust = (key: keyof Adjust, v: number) => save({ ...look, adjust: { ...look.adjust, [key]: v } });

  return (
    <Sheet open={open} onClose={onClose} title="Filters">
      <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pb-1">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-800 p-1">
          {(
            [
              ['filters', 'Filters'],
              ['adjust', 'Adjust'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`min-h-9 rounded-lg text-xs font-semibold ${tab === id ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'filters' ? (
          <>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {FILTER_IDS.map((id: FilterId) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => save({ ...look, filter: id, amount: look.filter === id ? look.amount : 1 })}
                  className="flex w-16 shrink-0 flex-col items-center gap-1"
                >
                  <span
                    className={`size-14 rounded-xl border-2 ${look.filter === id ? 'border-pink-500' : 'border-transparent'}`}
                    style={{ background: `linear-gradient(135deg, ${FILTERS[id].swatch}, #18181b)` }}
                  />
                  <span className="text-[11px] font-semibold">{FILTERS[id].label}</span>
                </button>
              ))}
            </div>
            {look.filter !== 'none' && (
              <label className="flex items-center gap-3 text-sm">
                <span className="w-16 text-zinc-400">Intensity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={look.amount}
                  onChange={(e) => save({ ...look, amount: Number(e.target.value) })}
                  aria-label="Filter intensity"
                  className="flex-1 accent-pink-500"
                />
                <span className="w-10 text-right font-mono text-xs">{Math.round(look.amount * 100)}</span>
              </label>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            {ADJUST_KEYS.map((key) => {
              const v = look.adjust[key] ?? 0;
              return (
                <label key={key} className="flex items-center gap-3 text-sm">
                  <span className="w-20 shrink-0 text-zinc-400">{ADJUST_LABELS[key]}</span>
                  <input
                    type="range"
                    min={ADJUST_POSITIVE.has(key) ? 0 : -1}
                    max={1}
                    step={0.01}
                    value={v}
                    onChange={(e) => setAdjust(key, Number(e.target.value))}
                    onDoubleClick={() => setAdjust(key, 0)}
                    aria-label={ADJUST_LABELS[key]}
                    className="min-w-0 flex-1 accent-pink-500"
                  />
                  <span className="w-9 text-right font-mono text-xs">{Math.round(v * 100)}</span>
                </label>
              );
            })}
            <button type="button" onClick={() => save({ ...look, adjust: {} })} className="mt-1 min-h-10 rounded-xl bg-zinc-800 text-sm font-semibold">
              Reset adjustments
            </button>
          </div>
        )}

        {allIds.length > 1 && (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-800 p-1">
            {(
              [
                ['these', clipIds.length === 1 ? 'This clip' : `${clipIds.length} selected`],
                ['all', `All clips (${allIds.length})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setScope(id);
                  // Switching to "all" copies this clip's look to every clip.
                  if (id === 'all') useEditor.getState().apply((p) => setLook(p, new Set(allIds), look === EMPTY ? null : look));
                }}
                className={`min-h-10 rounded-lg text-xs font-semibold ${scope === id ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
