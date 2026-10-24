// Transition between two clips: pick one (it plays right away around the cut), set its length, or apply to every
// cut / give each cut a random hype transition. One undo step per visit.
import { useEffect, useState } from 'react';
import { Sheet } from '../../app/ui/Sheet';
import { useEditor } from '../store';
import { type TransitionKind, clipStarts } from '../timeline/model';
import {
  DEFAULT_TRANSITION_SEC,
  MAX_TRANSITION_SEC,
  MIN_TRANSITION_SEC,
  TRANSITIONS,
  randomHype,
  setTransition,
} from '../timeline/transitions';

type Props = { open: boolean; onClose(): void; cutIndex: number; onPreview(from: number, to: number): void };

export function TransitionSheet({ open, onClose, cutIndex, onPreview }: Props) {
  const clip = useEditor((s) => s.project?.main[cutIndex]);
  const cutTime = useEditor((s) => (s.project ? (clipStarts(s.project)[cutIndex + 1] ?? 0) : 0));
  const clipCount = useEditor((s) => s.project?.main.length ?? 0);
  const [duration, setDuration] = useState(clip?.transition?.duration ?? DEFAULT_TRANSITION_SEC);

  useEffect(() => {
    if (!open) return;
    useEditor.getState().beginGesture();
    return () => useEditor.getState().endGesture();
  }, [open]);

  if (!clip || cutIndex >= clipCount - 1) return null;
  const current = clip.transition?.kind ?? null;
  const preview = (d: number) => onPreview(cutTime - d / 2 - 0.5, cutTime + d / 2 + 0.5);

  const pick = (kind: TransitionKind | null) => {
    useEditor.getState().apply((p) => setTransition(p, new Set([clip.id]), kind ? { kind, duration } : null));
    if (kind) preview(duration);
  };
  const setLength = (d: number) => {
    setDuration(d);
    if (current) useEditor.getState().apply((p) => setTransition(p, new Set([clip.id]), { kind: current, duration: d }));
  };
  const applyAll = () => {
    if (!current) return;
    useEditor.getState().apply((p) => setTransition(p, new Set(p.main.slice(0, -1).map((c) => c.id)), { kind: current, duration }));
  };
  const random = () => {
    useEditor.getState().apply((p) => randomHype(p, duration));
    preview(duration);
  };

  return (
    <Sheet open={open} onClose={onClose} title={`Transition · cut ${cutIndex + 1}`}>
      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto pb-1">
        <label className="flex items-center gap-3 text-sm">
          <span className="w-16 text-zinc-400">Length</span>
          <input
            type="range"
            min={MIN_TRANSITION_SEC}
            max={MAX_TRANSITION_SEC}
            step={0.1}
            value={duration}
            onChange={(e) => setLength(Number(e.target.value))}
            onPointerUp={() => current && preview(duration)}
            aria-label="Transition length"
            className="flex-1 accent-pink-500"
          />
          <span className="w-10 text-right font-mono text-xs">{duration.toFixed(1)}s</span>
        </label>
        {(['hype', 'classic'] as const).map((group) => (
          <div key={group}>
            <div className="mb-1 text-xs font-semibold text-zinc-400">{group === 'hype' ? 'TikTok style' : 'Classic'}</div>
            <div className="grid grid-cols-4 gap-1.5">
              {group === 'classic' && (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className={`flex min-h-16 flex-col items-center justify-center rounded-xl text-[11px] font-semibold ${current === null ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
                >
                  <span className="text-lg">✕</span>
                  None
                </button>
              )}
              {TRANSITIONS.filter((t) => t.group === group).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t.id)}
                  className={`flex min-h-16 flex-col items-center justify-center rounded-xl text-[11px] font-semibold ${current === t.id ? 'bg-pink-500' : 'bg-zinc-800'}`}
                >
                  <span className="text-lg">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={applyAll} disabled={!current} className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold disabled:opacity-40">
            Apply to all cuts
          </button>
          <button type="button" onClick={random} className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold">
            🎲 Random hype
          </button>
        </div>
      </div>
    </Sheet>
  );
}
