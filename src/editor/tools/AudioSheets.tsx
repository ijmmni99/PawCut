import { useState } from 'react';
import { Sheet } from '../../app/ui/Sheet';
import { useLibrary } from '../../library/audioLibrary';
import { useEditor } from '../store';
import { audioDuration, mixOf, setMix, updateAudioClip } from '../timeline/audio';
import { type AudioClip, setClipVolume } from '../timeline/model';
import { OffsetPicker } from './OffsetPicker';

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
  onChange(v: number): void;
}) {
  const { beginGesture, endGesture } = useEditor.getState();
  return (
    <label className="block">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-400">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 w-full accent-pink-500"
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => `${v.toFixed(1)}s`;

/** Volume, fades and (music) ducking + start offset for the selected audio clip. */
export function AudioClipSheet({ open, onClose, clipId }: { open: boolean; onClose(): void; clipId: string | null }) {
  const project = useEditor((s) => s.project);
  const apply = useEditor((s) => s.apply);
  const clip = project?.audio?.find((c) => c.id === clipId);
  const item = useLibrary((s) => (clip ? s.items[clip.sourceId] : undefined));
  const [showOffset, setShowOffset] = useState(false);
  if (!clip || !project) return null;
  const mix = mixOf(project);
  const set = (patch: Partial<AudioClip>) => apply((p) => updateAudioClip(p, clip.id, patch));
  const len = audioDuration(clip);

  return (
    <Sheet open={open} onClose={onClose} title={`${clip.track === 'music' ? '♫' : clip.track === 'sfx' ? '✦' : '🎙'} ${item?.title ?? 'Audio'}`}>
      <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pb-1">
        <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={pct} onChange={(v) => set({ volume: v })} />
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(5, len / 2)} step={0.1} format={secs} onChange={(v) => set({ fadeIn: v })} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(5, len / 2)} step={0.1} format={secs} onChange={(v) => set({ fadeOut: v })} />
        {clip.track === 'music' && (
          <>
            <label className="flex min-h-11 items-center justify-between text-sm">
              <span>Lower music under voice & video sound</span>
              <input
                type="checkbox"
                checked={mix.duck}
                onChange={(e) => apply((p) => setMix(p, { duck: e.target.checked }))}
                className="size-5 accent-pink-500"
              />
            </label>
            {mix.duck && (
              <div className="grid grid-cols-3 gap-1.5">
                {[-6, -12, -18].map((db) => (
                  <button
                    key={db}
                    type="button"
                    onClick={() => apply((p) => setMix(p, { duckDb: db }))}
                    className={`min-h-10 rounded-xl text-sm font-semibold ${mix.duckDb === db ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
                  >
                    {db === -6 ? 'Light' : db === -12 ? 'Medium' : 'Strong'}
                  </button>
                ))}
              </div>
            )}
            {item && (
              <>
                <button type="button" onClick={() => setShowOffset(!showOffset)} className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold">
                  {showOffset ? 'Hide' : 'Change which part plays'}
                </button>
                {showOffset && (
                  <OffsetPicker
                    item={item}
                    windowSec={len}
                    value={clip.inSec}
                    onChange={(v) => set({ inSec: v, outSec: v + len })}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Original-sound volume / mute for the video clips the tools target. */
export function ClipVolumeSheet({ open, onClose, clipIds }: { open: boolean; onClose(): void; clipIds: string[] }) {
  const project = useEditor((s) => s.project);
  const apply = useEditor((s) => s.apply);
  const allIds = project?.main.map((c) => c.id) ?? [];
  const [scope, setScope] = useState<'these' | 'all'>('these');
  const ids = new Set(scope === 'all' ? allIds : clipIds);
  const first = project?.main.find((c) => ids.has(c.id));
  const volume = first?.volume ?? 1;
  const theseLabel = clipIds.length === 1 ? 'This clip' : `${clipIds.length} selected`;
  return (
    <Sheet open={open} onClose={onClose} title="Original sound">
      <div className="flex flex-col gap-3 pb-1">
        {allIds.length > 1 && (
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-800 p-1">
            {(
              [
                ['these', theseLabel],
                ['all', `All clips (${allIds.length})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setScope(id)}
                className={`min-h-10 rounded-lg text-xs font-semibold ${scope === id ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <Slider label="Volume" value={volume} min={0} max={2} step={0.01} format={pct} onChange={(v) => apply((p) => setClipVolume(p, ids, v))} />
        <button
          type="button"
          onClick={() => apply((p) => setClipVolume(p, ids, volume > 0 ? 0 : 1))}
          className="min-h-11 rounded-xl bg-zinc-800 text-sm font-semibold"
        >
          {volume > 0 ? (scope === 'all' ? 'Mute all clips' : 'Mute original sound') : scope === 'all' ? 'Unmute all clips' : 'Unmute'}
        </button>
      </div>
    </Sheet>
  );
}
