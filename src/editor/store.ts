import { create } from 'zustand';
import type { Asset, Project } from './timeline/model';

/** Persisted undo depth per project. In-session history is unlimited. */
export const PERSISTED_HISTORY = 100;

type EditorState = {
  project: Project | null;
  past: Project[];
  future: Project[];
  /** Selected clip ids on the main track. */
  selection: string[];
  /** Project state when the current drag gesture started; edits during a gesture don't create undo steps. */
  gestureBase: Project | null;
  /** Bumped on every project change; persistence watches it. */
  revision: number;

  open(project: Project, past: Project[], future: Project[]): void;
  close(): void;
  apply(edit: (p: Project) => Project): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(ids: string[]): void;
};

function pruneSelection(selection: string[], project: Project): string[] {
  const ids = new Set(project.main.map((c) => c.id));
  return selection.filter((id) => ids.has(id));
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  past: [],
  future: [],
  selection: [],
  gestureBase: null,
  revision: 0,

  open: (project, past, future) => set({ project, past, future, selection: [], gestureBase: null, revision: 0 }),
  close: () => set({ project: null, past: [], future: [], selection: [], gestureBase: null }),

  apply: (edit) => {
    const { project, gestureBase, past, revision } = get();
    if (!project) return;
    const next = edit(project);
    if (next === project) return;
    const stamped = { ...next, updatedAt: Date.now() };
    set({
      project: stamped,
      // Inside a gesture the undo step is recorded once, in endGesture.
      past: gestureBase ? past : [...past, project],
      future: gestureBase ? get().future : [],
      selection: pruneSelection(get().selection, stamped),
      revision: revision + 1,
    });
  },

  beginGesture: () => {
    const { project } = get();
    if (project) set({ gestureBase: project });
  },

  endGesture: () => {
    const { gestureBase, project, past } = get();
    if (!gestureBase) return;
    if (project && project !== gestureBase) set({ gestureBase: null, past: [...past, gestureBase], future: [] });
    else set({ gestureBase: null });
  },

  undo: () => {
    const { past, project, future, revision } = get();
    const prev = past[past.length - 1];
    if (!prev || !project) return;
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future],
      selection: pruneSelection(get().selection, prev),
      revision: revision + 1,
    });
  },

  redo: () => {
    const { past, project, future, revision } = get();
    const next = future[0];
    if (!next || !project) return;
    set({
      project: next,
      past: [...past, project],
      future: future.slice(1),
      selection: pruneSelection(get().selection, next),
      revision: revision + 1,
    });
  },

  select: (ids) => set({ selection: ids }),
}));

type AssetsState = {
  assets: Record<string, Asset>;
  setAll(list: Asset[]): void;
  upsert(asset: Asset): void;
  patch(id: string, patch: Partial<Asset>): void;
  remove(ids: string[]): void;
};

export const useAssets = create<AssetsState>()((set) => ({
  assets: {},
  setAll: (list) => set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) }),
  upsert: (asset) => set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),
  patch: (id, patch) =>
    set((s) => {
      const current = s.assets[id];
      return current ? { assets: { ...s.assets, [id]: { ...current, ...patch } } } : s;
    }),
  remove: (ids) =>
    set((s) => {
      const assets = { ...s.assets };
      for (const id of ids) delete assets[id];
      return { assets };
    }),
}));

type PlaybackState = {
  /** Playhead, timeline seconds. */
  time: number;
  playing: boolean;
  setTime(time: number): void;
  setPlaying(playing: boolean): void;
};

export const usePlayback = create<PlaybackState>()((set) => ({
  time: 0,
  playing: false,
  setTime: (time) => set({ time }),
  setPlaying: (playing) => set({ playing }),
}));
