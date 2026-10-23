import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '../../app/share';
import { Sheet } from '../../app/ui/Sheet';
import { useAssets, useEditor, usePlayback } from '../../editor/store';
import { refitMusic, snapCutsToBeats, timelineBeats } from '../../editor/timeline/audio';
import { type Asset, newId } from '../../editor/timeline/model';
import { useLibrary } from '../../library/audioLibrary';
import { getAnalyses } from './analysisClient';
import {
  type Segment,
  type SourceRange,
  type Style,
  clipsDuration,
  keepRegions,
  pickHighlights,
  scoreAnalysis,
  segmentAt,
  segmentsToClips,
} from './score';

type Mode = 'highlights' | 'deadAir' | 'silence';

const TARGETS = [15, 30, 45, 60];
const HEAT_H = 44;

const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'highlights', label: 'Highlights' },
  { id: 'deadAir', label: 'Remove dead air' },
  { id: 'silence', label: 'Cut silences' },
];

function computeSegments(sources: SourceRange[], mode: Mode, target: number, style: Style): Segment[] {
  if (mode === 'highlights') return pickHighlights(sources, target, style);
  if (mode === 'deadAir') return keepRegions(sources, 'dead', 1.0, 0.15);
  return keepRegions(sources, 'silent', 0.4, 0.1);
}

/** Score 0..1 → indigo → pink → yellow. */
function heatColor(v: number): string {
  const stops: Array<[number, number, number]> = [
    [30, 27, 75],
    [219, 39, 119],
    [250, 204, 21],
  ];
  const x = Math.min(Math.max(v, 0), 1) * 2;
  const i = Math.min(1, Math.floor(x));
  const f = x - i;
  const a = stops[i] as [number, number, number];
  const b = stops[i + 1] as [number, number, number];
  return `rgb(${a.map((c, k) => Math.round(c + ((b[k] as number) - c) * f)).join(',')})`;
}

function Heatmap({
  source,
  index,
  segments,
  onTap,
}: {
  source: SourceRange;
  index: number;
  segments: Segment[];
  onTap(sourceIndex: number, sec: number): void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEAT_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const span = source.outSec - source.inSec;
    const x = (t: number) => ((t - source.inSec) / span) * w;
    const { binSec, score } = source.scored;
    ctx.clearRect(0, 0, w, HEAT_H);
    for (let b = Math.floor(source.inSec / binSec); b * binSec < source.outSec; b++) {
      ctx.fillStyle = heatColor(score[b] ?? 0);
      const x0 = Math.max(0, x(b * binSec));
      ctx.fillRect(x0, 0, Math.max(1, x((b + 1) * binSec) - x0 + 0.5), HEAT_H);
    }
    // Dim what's cut, outline what's kept.
    const mine = segments.filter((s) => s.source === index).sort((a, b) => a.start - b.start);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    let cursor = source.inSec;
    for (const s of mine) {
      ctx.fillRect(x(cursor), 0, x(s.start) - x(cursor), HEAT_H);
      cursor = s.end;
    }
    ctx.fillRect(x(cursor), 0, w - x(cursor), HEAT_H);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    for (const s of mine) ctx.strokeRect(x(s.start) + 1, 1, Math.max(2, x(s.end) - x(s.start) - 2), HEAT_H - 2);
  }, [source, index, segments]);

  return (
    <canvas
      ref={ref}
      className="block h-11 w-full touch-manipulation rounded-lg"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onTap(index, source.inSec + ((e.clientX - r.left) / r.width) * (source.outSec - source.inSec));
      }}
    />
  );
}

/**
 * Auto Highlight / Auto-Cut. Analyses every clip on the main track (cached per asset), proposes segments,
 * lets the user tap the heatmap to add/remove pieces, then replaces the main track in one undoable step.
 */
export function AutoCutSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [phase, setPhase] = useState<'analyzing' | 'ready' | 'error'>('analyzing');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [tookSec, setTookSec] = useState<number | null>(null);
  const [sources, setSources] = useState<SourceRange[]>([]);
  const [mode, setMode] = useState<Mode>('highlights');
  const [target, setTarget] = useState(30);
  const [style, setStyle] = useState<Style>('chill');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    const project = useEditor.getState().project;
    const assets = useAssets.getState().assets;
    if (!project || project.main.length === 0) return;
    const clipAssets = project.main.map((c) => assets[c.assetId]);
    if (clipAssets.some((a) => !a?.proxyPath)) {
      setPhase('error');
      setError('Some clips are still being prepared. Try again when “Preparing” has finished.');
      return;
    }
    let alive = true;
    setPhase('analyzing');
    setProgress(0);
    const unique = [...new Map(clipAssets.map((a) => [(a as Asset).id, a as Asset])).values()];
    const started = performance.now();
    getAnalyses(unique, (p) => alive && setProgress(p)).then(
      (analyses) => {
        if (!alive) return;
        const scored = new Map(analyses.map((a) => [a.assetId, scoreAnalysis(a)]));
        const srcs = project.main.map((c) => ({
          assetId: c.assetId,
          inSec: c.inSec,
          outSec: c.outSec,
          scored: scored.get(c.assetId) as SourceRange['scored'],
        }));
        setSources(srcs);
        setNames(project.main.map((c) => assets[c.assetId]?.name ?? 'Clip'));
        setTookSec((performance.now() - started) / 1000);
        setPhase('ready');
      },
      (err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      },
    );
    return () => {
      alive = false;
    };
  }, [open]);

  // Re-propose whenever the controls change (manual taps are layered on top until then).
  useEffect(() => {
    if (phase === 'ready') setSegments(computeSegments(sources, mode, target, style));
  }, [phase, sources, mode, target, style]);

  const rampStyle: Style = mode === 'highlights' ? style : 'chill';
  const project = useEditor((s) => s.project);
  const library = useLibrary((s) => s.items);
  const beats = useMemo(() => (project ? timelineBeats(project, (id) => library[id]?.beats) : []), [project, library]);
  const [beatSync, setBeatSync] = useState(true);
  const clips = useMemo(() => {
    const raw = segmentsToClips(sources, segments, rampStyle);
    if (!beatSync || beats.length < 2) return raw;
    const assets = useAssets.getState().assets;
    return snapCutsToBeats(raw, beats, (c) => assets[c.assetId]?.durationSec ?? c.outSec);
  }, [sources, segments, rampStyle, beatSync, beats]);
  const sourceTotal = sources.reduce((t, s) => t + s.outSec - s.inSec, 0);

  const onTap = (sourceIndex: number, sec: number) => {
    const hit = segments.find((s) => s.source === sourceIndex && sec >= s.start && sec <= s.end);
    if (hit) {
      setSegments(segments.filter((s) => s !== hit));
      return;
    }
    let added: Segment | null;
    if (mode === 'highlights') added = segmentAt(sources, sourceIndex, sec, style, segments);
    else {
      // Keep-modes: tapping a cut puts that whole gap back.
      const src = sources[sourceIndex];
      const mine = segments.filter((s) => s.source === sourceIndex);
      const before = Math.max(src?.inSec ?? 0, ...mine.filter((s) => s.end <= sec).map((s) => s.end));
      const after = Math.min(src?.outSec ?? 0, ...mine.filter((s) => s.start >= sec).map((s) => s.start));
      added = { source: sourceIndex, start: before, end: after, score: 1 };
    }
    if (added) setSegments([...segments, added].sort((a, b) => a.source - b.source || a.start - b.start));
  };

  const apply = () => {
    if (clips.length === 0) return;
    const { apply: edit, select } = useEditor.getState();
    const durations = Object.fromEntries(Object.values(library).map((i) => [i.id, i.durationSec]));
    // Music laid under the old cut follows the new length (and keeps its fade-out).
    edit((p) => refitMusic({ ...p, main: clips.map((c) => ({ id: newId(), ...c })) }, durations));
    select([]);
    usePlayback.getState().setTime(0);
    onClose();
  };

  const customTarget = () => {
    const v = Number(window.prompt('Target length in seconds', String(target)));
    if (Number.isFinite(v) && v >= 3) setTarget(Math.round(v));
  };

  return (
    <Sheet open={open} onClose={onClose} title="✨ Auto-Cut">
      {phase === 'analyzing' && (
        <div className="pb-2">
          <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-pink-500 transition-[width]" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          </div>
          <p className="mt-2 text-sm text-zinc-400">Finding the best moments… {Math.round(progress * 100)}%</p>
        </div>
      )}
      {phase === 'error' && <p className="rounded-xl bg-red-950 p-3 text-sm text-red-300">{error}</p>}
      {phase === 'ready' && (
        <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pb-1">
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-800 p-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`min-h-10 rounded-lg text-xs font-semibold ${mode === m.id ? 'bg-zinc-100 text-black' : 'text-zinc-300'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'highlights' && (
            <>
              <div className="flex gap-1.5">
                {TARGETS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTarget(t)}
                    className={`min-h-11 flex-1 rounded-xl text-sm font-semibold ${target === t ? 'bg-pink-500' : 'bg-zinc-800'}`}
                  >
                    {t}s
                  </button>
                ))}
                <button
                  type="button"
                  onClick={customTarget}
                  className={`min-h-11 flex-1 rounded-xl text-sm font-semibold ${TARGETS.includes(target) ? 'bg-zinc-800' : 'bg-pink-500'}`}
                >
                  {TARGETS.includes(target) ? 'Custom' : `${target}s`}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {(['chill', 'hype'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStyle(s)}
                    className={`min-h-11 rounded-xl text-sm font-semibold ${style === s ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}
                  >
                    {s === 'chill' ? '😌 Chill' : '⚡ Hype + slow-mo'}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="flex flex-col gap-2">
            {sources.map((src, i) => (
              <div key={i}>
                <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
                  <span className="truncate">{names[i]}</span>
                  <span>{formatDuration(src.outSec - src.inSec)}</span>
                </div>
                <Heatmap source={src} index={i} segments={segments} onTap={onTap} />
              </div>
            ))}
            <p className="text-[11px] text-zinc-500">
              Brighter = more action. Tap a white box to drop it, tap elsewhere to add that moment.
            </p>
          </div>

          {beats.length >= 2 && (
            <label className="flex min-h-11 items-center justify-between rounded-xl bg-zinc-800 px-3 text-sm">
              <span>🎵 Cut on the beat</span>
              <input
                type="checkbox"
                checked={beatSync}
                onChange={(e) => setBeatSync(e.target.checked)}
                className="h-5 w-5 accent-pink-500"
              />
            </label>
          )}

          <div className="flex items-baseline justify-between text-sm">
            <span>
              <b className="text-lg">{formatDuration(clipsDuration(clips), true)}</b>
              <span className="text-zinc-400"> from {formatDuration(sourceTotal)} · {clips.length} clips</span>
            </span>
            {tookSec !== null && <span className="text-[11px] text-zinc-500">analysed in {tookSec.toFixed(0)}s</span>}
          </div>
          <button
            type="button"
            onClick={apply}
            disabled={clips.length === 0}
            className="min-h-12 rounded-xl bg-pink-500 text-base font-bold disabled:opacity-40"
          >
            Apply to timeline
          </button>
        </div>
      )}
    </Sheet>
  );
}
