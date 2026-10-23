import { useEffect, useRef, useState } from 'react';
import { downloadFile, formatBytes, formatDuration, shareFile } from '../app/share';
import { Sheet } from '../app/ui/Sheet';
import { codecProfile } from '../engine/codecProfile';
import { type ExportHandle, startRender } from '../engine/export/exportClient';
import { type RenderEvent, TIKTOK_1080P30 } from '../engine/export/protocol';
import { renderOverlay } from '../engine/audio/overlay';
import { getAudioBuffer } from '../library/audioLibrary';
import { buildPlan } from './overlay/plan';
import { rasterize } from './overlay/sprites';
import { audioClips, duckEnvelope } from './timeline/audio';
import { projectDuration } from './timeline/model';
import { readFile } from '../engine/storage/opfs';
import { holdWakeLock } from '../engine/wakeLock';
import { useAssets, useEditor } from './store';

type State =
  | { kind: 'running'; progress: number; elapsedMs: number }
  | { kind: 'done'; file: File; durationSec: number; elapsedMs: number }
  | { kind: 'error'; message: string };

function fileName(projectName: string): string {
  const slug = projectName.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pawcut';
  return `${slug}.mp4`;
}

/** Renders the open project with the TikTok preset as soon as it opens, then offers Save / Share. */
export function ExportSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [state, setState] = useState<State>({ kind: 'running', progress: 0, elapsedMs: 0 });
  const handle = useRef<ExportHandle | null>(null);

  useEffect(() => {
    if (!open) return;
    const project = useEditor.getState().project;
    if (!project) return;
    const assets = useAssets.getState().assets;
    const missing = project.main.some((c) => !assets[c.assetId]?.originalPath);
    if (missing) {
      setState({ kind: 'error', message: 'Some clips are still being copied in. Try again in a moment.' });
      return;
    }
    setState({ kind: 'running', progress: 0, elapsedMs: 0 });
    const lock = holdWakeLock();
    const preset = { ...TIKTOK_1080P30, videoCodec: codecProfile.video, audioCodec: codecProfile.audio };
    let alive = true;
    const onEvent = (e: RenderEvent) => {
      if (!alive) return;
      switch (e.type) {
        case 'progress':
          setState({ kind: 'running', progress: e.progress, elapsedMs: e.elapsedMs });
          break;
        case 'done':
          lock.release();
          void readFile(e.opfsPath).then(
            (f) => {
              if (!alive) return;
              const file = new File([f], fileName(project.name), { type: 'video/mp4' });
              setState({ kind: 'done', file, durationSec: e.durationSec, elapsedMs: e.elapsedMs });
            },
            (err: unknown) => setState({ kind: 'error', message: String(err) }),
          );
          break;
        case 'error':
          lock.release();
          setState({ kind: 'error', message: e.message });
          break;
        case 'canceled':
          lock.release();
          onClose();
          break;
      }
    };
    // Music / SFX / voice are mixed with Web Audio here (same scheduling as preview), then handed to the worker.
    void (async () => {
      let overlay: Float32Array[] | null = null;
      const clips = audioClips(project);
      if (clips.length > 0) {
        const buffers = new Map<string, AudioBuffer>();
        for (const id of new Set(clips.map((c) => c.sourceId))) {
          const buffer = await getAudioBuffer(id).catch(() => null);
          if (buffer) buffers.set(id, buffer);
        }
        const loudness = Object.fromEntries(Object.values(assets).map((a) => [a.id, a.loudness]));
        overlay = await renderOverlay(
          { project, buffers, duck: duckEnvelope(project, loudness) },
          projectDuration(project),
          preset.sampleRate,
        );
      }
      // Text and caption sprites (fonts are only reliable on the main thread).
      const sprites = [];
      for (const [key, spec] of buildPlan(project).specs) {
        const { bitmap, meta } = await rasterize(spec);
        sprites.push({ key, bitmap, meta });
      }
      if (!alive) {
        for (const s of sprites) s.bitmap.close();
        return;
      }
      handle.current = startRender({ type: 'start', project, assets, preset, overlay, sprites }, onEvent);
    })().catch((err: unknown) => {
      lock.release();
      if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      alive = false;
      lock.release();
      handle.current?.cancel();
      handle.current = null;
    };
  }, [open, onClose]);

  const running = state.kind === 'running';
  const eta =
    running && state.progress > 0.03 ? (state.elapsedMs / state.progress - state.elapsedMs) / 1000 : null;

  return (
    <Sheet open={open} onClose={onClose} title="Export · 1080×1920 30fps" dismissible={!running}>
      {state.kind === 'running' && (
        <div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-pink-500" style={{ width: `${(state.progress * 100).toFixed(1)}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-sm text-zinc-400">
            <span>{Math.round(state.progress * 100)}%</span>
            <span>{eta !== null ? `About ${Math.ceil(eta)}s left` : 'Starting…'}</span>
          </div>
          <p className="mt-3 text-sm text-amber-300">Keep PawCut open until it finishes.</p>
          <button
            type="button"
            onClick={() => handle.current?.cancel()}
            className="mt-4 min-h-12 w-full rounded-xl bg-zinc-800 font-semibold"
          >
            Cancel
          </button>
        </div>
      )}
      {state.kind === 'done' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <Stat label="Size" value={formatBytes(state.file.size)} />
            <Stat label="Length" value={formatDuration(state.durationSec, true)} />
            <Stat label="Took" value={`${(state.elapsedMs / 1000).toFixed(0)}s`} />
          </div>
          <button
            type="button"
            onClick={() => void shareFile(state.file)}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-pink-500 text-base font-bold"
          >
            Save / Share
          </button>
          <button
            type="button"
            onClick={() => downloadFile(state.file)}
            className="min-h-11 w-full rounded-xl bg-zinc-800 text-sm font-semibold"
          >
            Download file
          </button>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="space-y-3">
          <p className="rounded-xl bg-red-950 p-3 text-sm text-red-300">Export failed: {state.message}</p>
          <button type="button" onClick={onClose} className="min-h-11 w-full rounded-xl bg-zinc-800 font-semibold">
            Close
          </button>
        </div>
      )}
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-800 p-2">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="font-bold">{value}</div>
    </div>
  );
}
