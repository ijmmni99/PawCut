import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../app/router';
import { formatDuration } from '../app/share';
import { Icon, type IconName } from '../app/ui/Icon';
import { importFiles } from '../engine/media/importClient';
import { closeProject, openProject, renameProject } from '../library/projects';
import { ExportSheet } from './ExportSheet';
import { PreviewPlayer } from './preview/player';
import { useEditor, usePlayback } from './store';
import { TimelineView } from './timeline/TimelineView';
import { duplicateClip, locate, projectDuration, removeClips, splitAt } from './timeline/model';
import { SpeedSheet } from './tools/SpeedSheet';

/** Clips a tool acts on: the selection, or the clip under the playhead. */
function targetClipIds(): string[] {
  const { project, selection } = useEditor.getState();
  if (selection.length > 0) return selection;
  if (!project) return [];
  const hit = locate(project, usePlayback.getState().time);
  return hit ? [hit.clip.id] : [];
}

function TimeReadout() {
  const time = usePlayback((s) => s.time);
  const total = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  return (
    <span className="font-mono text-xs tabular-nums text-zinc-400">
      <span className="text-zinc-100">{formatDuration(time, true)}</span> / {formatDuration(total, true)}
    </span>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-14 min-w-16 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-zinc-200 active:bg-zinc-800 disabled:opacity-30"
    >
      <Icon name={icon} size={22} />
      {label}
    </button>
  );
}

/** Two-finger tap anywhere in the editor = undo. */
function useTwoFingerUndo(ref: React.RefObject<HTMLElement | null>, undo: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { t: number; pts: Array<[number, number]> } | null = null;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        start = { t: e.timeStamp, pts: [...e.touches].map((t) => [t.clientX, t.clientY]) };
      } else if (e.touches.length > 2) start = null;
    };
    const onMove = (e: TouchEvent) => {
      const pts = start?.pts;
      if (!pts) return;
      const moved = [...e.touches].some((t, i) => {
        const p = pts[i];
        return p !== undefined && Math.hypot(t.clientX - p[0], t.clientY - p[1]) > 12;
      });
      if (moved) start = null;
    };
    const onEnd = (e: TouchEvent) => {
      if (start && e.touches.length === 0) {
        if (e.timeStamp - start.t < 300) undo();
        start = null;
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [ref, undo]);
}

export function EditorScreen({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const selection = useEditor((s) => s.selection);
  const playing = usePlayback((s) => s.playing);
  const { apply, undo, redo, select } = useEditor.getState();

  const [missing, setMissing] = useState(false);
  const [sheet, setSheet] = useState<'speed' | 'export' | null>(null);
  const [speedTargets, setSpeedTargets] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PreviewPlayer | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let alive = true;
    usePlayback.getState().setTime(0);
    void openProject(projectId).then((ok) => {
      if (alive && !ok) setMissing(true);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const player = new PreviewPlayer(canvas);
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, []);

  // Fit a 9:16 preview into the available stage.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const h = Math.min(height, (width * 16) / 9);
      const w = (h * 9) / 16;
      setBox({ w, h });
      playerRef.current?.resize(w, h);
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  // Show the first frame once the project and preview are ready.
  const projectLoaded = project?.id;
  useEffect(() => {
    if (projectLoaded) playerRef.current?.showTime(usePlayback.getState().time);
  }, [projectLoaded]);

  const undoSafe = useCallback(() => {
    playerRef.current?.pause();
    undo();
  }, [undo]);
  useTwoFingerUndo(rootRef, undoSafe);

  const back = async () => {
    playerRef.current?.pause();
    await closeProject();
    navigate({ name: 'projects' });
  };

  const rename = async () => {
    if (!project) return;
    const name = window.prompt('Project name', project.name)?.trim();
    if (!name || name === project.name) return;
    apply((p) => ({ ...p, name }));
    await renameProject(project.id, name);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length && project) void importFiles(project.id, files);
  };

  const split = () => {
    playerRef.current?.pause();
    apply((p) => splitAt(p, usePlayback.getState().time));
    select([]);
  };

  const remove = () => {
    const ids = new Set(targetClipIds());
    if (!project || ids.size === 0) return;
    playerRef.current?.pause();
    // Removed clips' media stays on disk so undo can bring them back; it's cleaned up when the project is deleted.
    apply((p) => removeClips(p, ids));
    select([]);
  };

  const duplicate = () => {
    const [id] = targetClipIds();
    if (!id) return;
    playerRef.current?.pause();
    apply((p) => duplicateClip(p, id));
  };

  const openSpeed = () => {
    const ids = targetClipIds();
    if (ids.length === 0) return;
    playerRef.current?.pause();
    setSpeedTargets(ids);
    setSheet('speed');
  };

  const openExport = () => {
    playerRef.current?.pause();
    setSheet('export');
  };
  const closeSheet = useCallback(() => setSheet(null), []);

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-zinc-400">This project no longer exists.</p>
        <button type="button" onClick={() => navigate({ name: 'projects' })} className="min-h-12 rounded-xl bg-zinc-800 px-6 font-semibold">
          Back to projects
        </button>
      </div>
    );
  }

  const empty = (project?.main.length ?? 0) === 0;
  const hasTarget = !empty;

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-[var(--bg)]">
      <header className="flex items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" aria-label="Back" onClick={() => void back()} className="flex size-11 items-center justify-center">
          <Icon name="back" />
        </button>
        <button type="button" onClick={() => void rename()} className="min-h-11 flex-1 truncate text-left text-sm font-semibold">
          {project?.name ?? ''}
        </button>
        <button type="button" aria-label="Undo" disabled={!canUndo} onClick={undoSafe} className="flex size-11 items-center justify-center disabled:opacity-30">
          <Icon name="undo" size={22} />
        </button>
        <button
          type="button"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => {
            playerRef.current?.pause();
            redo();
          }}
          className="flex size-11 items-center justify-center disabled:opacity-30"
        >
          <Icon name="redo" size={22} />
        </button>
        <button
          type="button"
          onClick={openExport}
          disabled={empty}
          className="ml-1 min-h-9 rounded-full bg-pink-500 px-4 text-sm font-bold disabled:opacity-40"
        >
          Export
        </button>
      </header>

      <div ref={stageRef} className="relative flex min-h-0 flex-[1_1_45%] items-center justify-center px-3 py-2">
        <canvas
          ref={canvasRef}
          data-testid="preview"
          onClick={() => playerRef.current?.toggle()}
          className="rounded-lg bg-black"
          style={{ width: box.w, height: box.h }}
        />
        {empty && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="absolute flex flex-col items-center gap-2 rounded-2xl bg-zinc-900/90 px-6 py-5 font-semibold"
          >
            <Icon name="plus" size={32} />
            Add videos
          </button>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-1">
        <TimeReadout />
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => playerRef.current?.toggle()}
          disabled={empty}
          className="flex size-12 items-center justify-center rounded-full bg-zinc-800 disabled:opacity-30"
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <span className="w-[92px] text-right text-xs text-zinc-500">{selection.length > 1 ? `${selection.length} selected` : ''}</span>
      </div>

      <TimelineView
        onInteract={() => playerRef.current?.pause()}
        onPeek={(assetId, sec) => playerRef.current?.peek(assetId, sec)}
        onPeekEnd={() => playerRef.current?.showTime(usePlayback.getState().time)}
      />

      <nav className="flex gap-1 overflow-x-auto border-t border-zinc-800 px-2 pb-[calc(env(safe-area-inset-bottom)+4px)] pt-1">
        <ToolButton icon="plus" label="Add" onClick={() => fileInput.current?.click()} />
        <ToolButton icon="split" label="Split" onClick={split} disabled={!hasTarget} />
        <ToolButton icon="speed" label="Speed" onClick={openSpeed} disabled={!hasTarget} />
        <ToolButton icon="copy" label="Duplicate" onClick={duplicate} disabled={!hasTarget} />
        <ToolButton icon="trash" label="Delete" onClick={remove} disabled={!hasTarget} />
      </nav>

      <input ref={fileInput} type="file" accept="video/*" multiple className="hidden" onChange={onPick} />
      <SpeedSheet open={sheet === 'speed'} onClose={closeSheet} clipIds={speedTargets} />
      <ExportSheet open={sheet === 'export'} onClose={closeSheet} />
    </div>
  );
}
