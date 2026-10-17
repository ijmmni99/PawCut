import { Sheet } from '../../app/ui/Sheet';
import { useEditor } from '../store';
import { MAX_SPEED, MIN_SPEED, setSpeed } from '../timeline/model';

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

/** Constant speed for the target clips. The slider is logarithmic so 1× sits in the middle. */
export function SpeedSheet({ open, onClose, clipIds }: { open: boolean; onClose(): void; clipIds: string[] }) {
  const project = useEditor((s) => s.project);
  const apply = useEditor((s) => s.apply);
  const beginGesture = useEditor((s) => s.beginGesture);
  const endGesture = useEditor((s) => s.endGesture);
  const ids = new Set(clipIds);
  const current = project?.main.find((c) => ids.has(c.id))?.speed ?? 1;

  const set = (speed: number) => apply((p) => setSpeed(p, ids, speed));

  return (
    <Sheet open={open} onClose={onClose} title={`Speed · ${+current.toFixed(2)}×`}>
      <input
        type="range"
        aria-label="Speed"
        min={Math.log2(MIN_SPEED)}
        max={Math.log2(MAX_SPEED)}
        step={0.01}
        value={Math.log2(current)}
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onChange={(e) => set(Math.round(2 ** Number(e.target.value) * 100) / 100)}
        className="h-11 w-full accent-pink-500"
      />
      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => set(s)}
            className={`min-h-11 rounded-xl text-sm font-semibold ${
              Math.abs(current - s) < 0.001 ? 'bg-pink-500 text-white' : 'bg-zinc-800 text-zinc-200'
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-500">Applies to {clipIds.length === 1 ? 'the selected clip' : `${clipIds.length} clips`}. Pitch follows speed.</p>
    </Sheet>
  );
}
