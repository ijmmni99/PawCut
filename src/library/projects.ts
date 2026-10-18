// Project + asset persistence. The open project autosaves on every change (debounced) and flushes when the app is
// hidden, so a killed PWA loses at most the last few hundred milliseconds.
import { PERSISTED_HISTORY, useAssets, useEditor } from '../editor/store';
import {
  type Asset,
  type Project,
  appendClip,
  clipForAsset,
  createProject,
  newId,
  projectDuration,
  referencedAssets,
} from '../editor/timeline/model';
import { assetDir, removeEntry } from '../engine/storage/opfs';
import { db, setSetting } from './db';

export const LAST_PROJECT_KEY = 'lastProjectId';

export async function loadAssets(): Promise<void> {
  useAssets.getState().setAll(await db.assets.toArray());
}

export async function listProjects(): Promise<Project[]> {
  return db.projects.orderBy('updatedAt').reverse().toArray();
}

export async function createNewProject(): Promise<Project> {
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const count = await db.projects.count();
  const project = createProject(`Project ${count + 1} · ${date}`);
  await db.projects.put(project);
  return project;
}

export async function openProject(id: string): Promise<boolean> {
  const [project, history] = await Promise.all([db.projects.get(id), db.history.get(id)]);
  if (!project) return false;
  useEditor.getState().open(project, history?.past ?? [], history?.future ?? []);
  await setSetting(LAST_PROJECT_KEY, id);
  return true;
}

export async function closeProject(): Promise<void> {
  await flushSave();
  useEditor.getState().close();
  await setSetting(LAST_PROJECT_KEY, null);
}

export async function renameProject(id: string, name: string): Promise<void> {
  await db.projects.update(id, { name, updatedAt: Date.now() });
}

export async function duplicateProject(id: string): Promise<void> {
  const source = await db.projects.get(id);
  if (!source) return;
  const now = Date.now();
  // Assets are shared between projects; they're only deleted once nothing references them.
  await db.projects.put({ ...source, id: newId(), name: `${source.name} copy`, createdAt: now, updatedAt: now });
}

export async function deleteProject(id: string): Promise<void> {
  const doomed = await db.projects.get(id);
  if (!doomed) return;
  await db.transaction('rw', db.projects, db.history, async () => {
    await db.projects.delete(id);
    await db.history.delete(id);
  });
  await collectUnusedAssets(referencedAssets(doomed));
}

/** Deletes assets (rows + OPFS files) from `candidates` that no project references any more. */
export async function collectUnusedAssets(candidates: Set<string>): Promise<void> {
  if (candidates.size === 0) return;
  const inUse = new Set<string>();
  for (const p of await db.projects.toArray()) for (const a of referencedAssets(p)) inUse.add(a);
  const editing = useEditor.getState().project;
  if (editing) for (const a of referencedAssets(editing)) inUse.add(a);
  const unused = [...candidates].filter((a) => !inUse.has(a));
  await db.assets.bulkDelete(unused);
  await db.analyses.bulkDelete(unused);
  useAssets.getState().remove(unused);
  await Promise.all(unused.map((a) => removeEntry(assetDir(a))));
}

export function projectSummary(project: Project): { durationSec: number; posterAssetId: string | null } {
  return { durationSec: projectDuration(project), posterAssetId: project.main[0]?.assetId ?? null };
}

/** Adds a clip for a freshly probed asset to the end of a project, whether or not it's open. */
export async function appendAssetClip(projectId: string, asset: Asset): Promise<void> {
  const editor = useEditor.getState();
  if (editor.project?.id === projectId) {
    editor.apply((p) => appendClip(p, clipForAsset(asset)));
    return;
  }
  const project = await db.projects.get(projectId);
  if (project) await db.projects.put({ ...appendClip(project, clipForAsset(asset)), updatedAt: Date.now() });
}

// ---- autosave ----

let timer: number | undefined;
let pending: { project: Project; past: Project[]; future: Project[] } | null = null;

async function writePending(): Promise<void> {
  const job = pending;
  pending = null;
  if (!job) return;
  await db.transaction('rw', db.projects, db.history, async () => {
    await db.projects.put(job.project);
    await db.history.put({
      projectId: job.project.id,
      past: job.past.slice(-PERSISTED_HISTORY),
      future: job.future.slice(0, PERSISTED_HISTORY),
    });
  });
}

export async function flushSave(): Promise<void> {
  window.clearTimeout(timer);
  await writePending();
}

export function startAutosave(): () => void {
  const unsubscribe = useEditor.subscribe((state, prev) => {
    if (!state.project || state.revision === prev.revision) return;
    pending = { project: state.project, past: state.past, future: state.future };
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void writePending(), 300);
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flushSave();
  };
  const onPageHide = () => void flushSave();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  };
}
