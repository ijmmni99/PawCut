import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../app/router';
import { formatDuration } from '../app/share';
import { Icon, type IconName } from '../app/ui/Icon';
import { TopBar } from '../app/ui/TopBar';
import { importFiles, retryImport } from '../engine/media/importClient';
import { closeProject, openProject, renameProject } from '../library/projects';
import { ExportSheet } from './ExportSheet';
import { OverlayCanvas } from './overlay/OverlayCanvas';
import { CAPTIONS_ID, addText, duplicateText, newTextItem, setCaptions } from './overlay/textOps';
import { PreviewPlayer } from './preview/player';
import { useAssets, useEditor, usePlayback } from './store';
import { TimelineView } from './timeline/TimelineView';
import { clipStarts, duplicateClip, locate, projectDuration, removeClips, splitAt } from './timeline/model';
import { SpeedSheet } from './tools/SpeedSheet';

// Auto-Cut (analysis worker, MediaPipe) only loads when first opened.
const AutoCutSheet = lazy(() => import('../ai/autocut/AutoCutSheet').then((m) => ({ default: m.AutoCutSheet })));
// Audio panels load on first use too.
const MusicSheet = lazy(() => import('./tools/MusicSheet').then((m) => ({ default: m.MusicSheet })));
const SfxSheet = lazy(() => import('./tools/SfxSheet').then((m) => ({ default: m.SfxSheet })));
const RecordSheet = lazy(() => import('./tools/RecordSheet').then((m) => ({ default: m.RecordSheet })));
const AudioClipSheet = lazy(() => import('./tools/AudioSheets').then((m) => ({ default: m.AudioClipSheet })));
const TextSheet = lazy(() => import('./tools/TextSheet').then((m) => ({ default: m.TextSheet })));
// Captions pull in the speech-recognition client (the Whisper worker itself loads only on Generate).
const CaptionsSheet = lazy(() => import('./tools/CaptionsSheet').then((m) => ({ default: m.CaptionsSheet })));
const TransitionSheet = lazy(() => import('./tools/TransitionSheet').then((m) => ({ default: m.TransitionSheet })));
const FilterSheet = lazy(() => import('./tools/FilterSheet').then((m) => ({ default: m.FilterSheet })));
const ClipVolumeSheet = lazy(() => import('./tools/AudioSheets').then((m) => ({ default: m.ClipVolumeSheet })));

/** Video clips a tool acts on: the selected ones, or the clip under the playhead. */
function targetClipIds(): string[] {
  const { project, selection } = useEditor.getState();
  const mainIds = new Set(project?.main.map((c) => c.id));
  const selected = selection.filter((id) => mainIds.has(id));
  if (selected.length > 0) return selected;
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

/** Explains a clip whose preparation failed (selected clip, else the one under the playhead) and offers a retry. */
function ClipIssueBar() {
  const assetId = useEditor((s) => {
    const p = s.project;
    if (!p) return null;
    const id = s.selection[0];
    const clip = id ? p.main.find((c) => c.id === id) : undefined;
    return clip?.assetId ?? null;
  });
  const time = usePlayback((s) => Math.floor(s.time));
  const fallbackId = useEditor((s) => (s.project ? (locate(s.project, time)?.clip.assetId ?? null) : null));
  const asset = useAssets((s) => s.assets[assetId ?? fallbackId ?? '']);
  if (asset?.status !== 'error') return null;
  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-xl bg-red-950/80 px-3 py-2 text-xs text-red-200">
      <span className="min-w-0 flex-1">
        <b>Couldn't prepare “{asset.name}”.</b> <span className="text-red-300/80">{asset.error}</span>
      </span>
      {asset.originalPath ? (
        <button
          type="button"
          onClick={() => void retryImport(asset.id)}
          className="min-h-9 shrink-0 rounded-lg bg-red-200 px-3 font-bold text-red-950"
        >
          Retry
        </button>
      ) : (
        <span className="shrink-0 text-red-300">Delete & import again</span>
      )}
    </div>
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
  const [sheet, setSheet] = useState<
    'speed' | 'export' | 'autocut' | 'music' | 'sfx' | 'record' | 'audioClip' | 'volume' | 'text' | 'captions' | 'transition' | 'filters' | null
  >(null);
  const selectedAudioId = useEditor((s) =>
    s.selection.length === 1 && s.project?.audio?.some((c) => c.id === s.selection[0]) ? (s.selection[0] as string) : null,
  );
  const selectedTextId = useEditor((s) =>
    s.selection.length === 1 && s.project?.texts?.some((t) => t.id === s.selection[0]) ? (s.selection[0] as string) : null,
  );
  const captionsSelected = useEditor((s) => s.selection.length === 1 && s.selection[0] === CAPTIONS_ID);
  const [textFocus, setTextFocus] = useState(false);
  const [safeZone, setSafeZone] = useState(false);
  const [cutIndex, setCutIndex] = useState(0);
  const [filterTargets, setFilterTargets] = useState<string[]>([]);
  const [volumeTargets, setVolumeTargets] = useState<string[]>([]);
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

  const openSheet = (name: NonNullable<typeof sheet>) => {
    playerRef.current?.pause();
    setSheet(name);
  };

  const openVolume = () => {
    const ids = targetClipIds();
    if (ids.length === 0) return;
    setVolumeTargets(ids);
    openSheet('volume');
  };

  const removeAudio = () => {
    if (!selectedAudioId) return;
    apply((p) => removeClips(p, new Set([selectedAudioId])));
    select([]);
  };

  const newText = () => {
    if (!project) return;
    playerRef.current?.pause();
    const t = usePlayback.getState().time;
    const total = projectDuration(project);
    const item = newTextItem(Math.min(t, Math.max(0, total - 0.5)), Math.max(0.5, Math.min(3, total - t)));
    apply((p) => addText(p, item));
    select([item.id]);
    setTextFocus(true);
    setSheet('text');
  };

  const editText = () => {
    setTextFocus(false);
    openSheet('text');
  };

  const removeSelected = () => {
    const id = useEditor.getState().selection[0];
    if (!id) return;
    if (id === CAPTIONS_ID) apply((p) => setCaptions(p, null));
    else apply((p) => removeClips(p, new Set([id])));
    select([]);
  };

  const openTransition = (index: number) => {
    setCutIndex(index);
    openSheet('transition');
  };

  /** Toolbar: the cut nearest the playhead. */
  const openNearestTransition = () => {
    if (!project || project.main.length < 2) return;
    const t = usePlayback.getState().time;
    const starts = clipStarts(project);
    let best = 0;
    for (let i = 1; i < starts.length; i++) {
      if (Math.abs((starts[i] ?? 0) - t) < Math.abs((starts[best + 1] ?? 0) - t)) best = i - 1;
    }
    openTransition(best);
  };

  const openFilters = () => {
    const ids = targetClipIds();
    if (ids.length === 0) return;
    setFilterTargets(ids);
    openSheet('filters');
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
      <TopBar className="gap-1 px-2">
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
      </TopBar>

      <div ref={stageRef} className="relative flex min-h-0 flex-[1_1_45%] items-center justify-center px-3 py-2">
        <canvas ref={canvasRef} data-testid="preview" className="rounded-lg bg-black" style={{ width: box.w, height: box.h }} />
        <OverlayCanvas width={box.w} height={box.h} safeZone={safeZone} onTap={() => playerRef.current?.toggle()} />
        {!empty && (
          <button
            type="button"
            aria-label="TikTok safe zone"
            aria-pressed={safeZone}
            onClick={() => setSafeZone(!safeZone)}
            className={`absolute right-4 top-3 flex size-9 items-center justify-center rounded-full ${safeZone ? 'bg-pink-500' : 'bg-black/50'}`}
          >
            <Icon name="frame" size={18} />
          </button>
        )}
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
        onCutTap={openTransition}
      />

      <ClipIssueBar />
      <nav className="flex gap-1 overflow-x-auto border-t border-zinc-800 px-2 pb-[calc(env(safe-area-inset-bottom)+4px)] pt-1">
        {selectedTextId ? (
          <>
            <ToolButton icon="text" label="Edit text" onClick={editText} />
            <ToolButton
              icon="copy"
              label="Duplicate"
              onClick={() => apply((p) => duplicateText(p, selectedTextId))}
            />
            <ToolButton icon="trash" label="Delete" onClick={removeSelected} />
            <ToolButton icon="back" label="Done" onClick={() => select([])} />
          </>
        ) : captionsSelected ? (
          <>
            <ToolButton icon="captions" label="Edit captions" onClick={() => openSheet('captions')} />
            <ToolButton icon="trash" label="Remove" onClick={removeSelected} />
            <ToolButton icon="back" label="Done" onClick={() => select([])} />
          </>
        ) : selectedAudioId ? (
          <>
            <ToolButton icon="volume" label="Volume & fades" onClick={() => openSheet('audioClip')} />
            <ToolButton icon="trash" label="Delete" onClick={removeAudio} />
            <ToolButton icon="back" label="Done" onClick={() => select([])} />
          </>
        ) : (
          <>
            <ToolButton icon="plus" label="Add" onClick={() => fileInput.current?.click()} />
            <ToolButton icon="sparkle" label="Auto-Cut" onClick={() => openSheet('autocut')} disabled={!hasTarget} />
            <ToolButton icon="captions" label="Captions" onClick={() => openSheet('captions')} disabled={!hasTarget} />
            <ToolButton icon="text" label="Text" onClick={newText} disabled={!hasTarget} />
            <ToolButton icon="music" label="Music" onClick={() => openSheet('music')} disabled={!hasTarget} />
            <ToolButton icon="bolt" label="SFX" onClick={() => openSheet('sfx')} disabled={!hasTarget} />
            <ToolButton icon="filter" label="Filters" onClick={openFilters} disabled={!hasTarget} />
            <ToolButton
              icon="transition"
              label="Transition"
              onClick={openNearestTransition}
              disabled={(project?.main.length ?? 0) < 2}
            />
            <ToolButton icon="mic" label="Record" onClick={() => openSheet('record')} disabled={!hasTarget} />
            <ToolButton icon="split" label="Split" onClick={split} disabled={!hasTarget} />
            <ToolButton icon="speed" label="Speed" onClick={openSpeed} disabled={!hasTarget} />
            <ToolButton icon="volume" label="Volume" onClick={openVolume} disabled={!hasTarget} />
            <ToolButton icon="copy" label="Duplicate" onClick={duplicate} disabled={!hasTarget} />
            <ToolButton icon="trash" label="Delete" onClick={remove} disabled={!hasTarget} />
          </>
        )}
      </nav>

      <input ref={fileInput} type="file" accept="video/*" multiple className="hidden" onChange={onPick} />
      <SpeedSheet open={sheet === 'speed'} onClose={closeSheet} clipIds={speedTargets} />
      {sheet === 'autocut' && (
        <Suspense fallback={null}>
          <AutoCutSheet open onClose={closeSheet} />
        </Suspense>
      )}
      <ExportSheet open={sheet === 'export'} onClose={closeSheet} />
      <Suspense fallback={null}>
        {sheet === 'music' && <MusicSheet open onClose={closeSheet} />}
        {sheet === 'sfx' && <SfxSheet open onClose={closeSheet} />}
        {sheet === 'record' && (
          <RecordSheet
            open
            onClose={closeSheet}
            controls={{
              play: () => playerRef.current?.play(),
              pause: () => playerRef.current?.pause(),
              setMuted: (m) => playerRef.current?.setOutputMuted(m),
            }}
          />
        )}
        {sheet === 'audioClip' && <AudioClipSheet open onClose={closeSheet} clipId={selectedAudioId} />}
        {sheet === 'text' && <TextSheet open onClose={closeSheet} textId={selectedTextId} focus={textFocus} />}
        {sheet === 'captions' && <CaptionsSheet open onClose={closeSheet} />}
        {sheet === 'transition' && (
          <TransitionSheet
            open
            onClose={closeSheet}
            cutIndex={cutIndex}
            onPreview={(from, to) => {
              playerRef.current?.pause();
              playerRef.current?.play({ from, to });
            }}
          />
        )}
        {sheet === 'filters' && <FilterSheet open onClose={closeSheet} clipIds={filterTargets} />}
        {sheet === 'volume' && <ClipVolumeSheet open onClose={closeSheet} clipIds={volumeTargets} />}
      </Suspense>
    </div>
  );
}
