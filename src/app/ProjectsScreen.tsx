import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssets } from '../editor/store';
import type { Project } from '../editor/timeline/model';
import { importFiles } from '../engine/media/importClient';
import { readFile } from '../engine/storage/opfs';
import {
  createNewProject,
  deleteProject,
  duplicateProject,
  listProjects,
  projectSummary,
  renameProject,
} from '../library/projects';
import { navigate } from './router';
import { formatDuration } from './share';
import { Icon } from './ui/Icon';
import { Sheet } from './ui/Sheet';

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Poster({ assetId }: { assetId: string | null }) {
  const path = useAssets((s) => (assetId ? s.assets[assetId]?.posterPath : null));
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let objectUrl: string | null = null;
    let alive = true;
    void readFile(path).then(
      (f) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(f);
        setUrl(objectUrl);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return url ? (
    <img src={url} alt="" className="size-full object-cover" draggable={false} />
  ) : (
    <div className="flex size-full items-center justify-center text-3xl text-zinc-700">🐾</div>
  );
}

export function ProjectsScreen() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [menuFor, setMenuFor] = useState<Project | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => void listProjects().then(setProjects), []);
  useEffect(refresh, [refresh]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length === 0) return;
    const project = await createNewProject();
    navigate({ name: 'editor', id: project.id });
    await importFiles(project.id, files);
  };

  const act = async (action: 'rename' | 'duplicate' | 'delete') => {
    const p = menuFor;
    setMenuFor(null);
    if (!p) return;
    if (action === 'rename') {
      const name = window.prompt('Project name', p.name)?.trim();
      if (name) await renameProject(p.id, name);
    } else if (action === 'duplicate') {
      await duplicateProject(p.id);
    } else if (window.confirm(`Delete “${p.name}”? This can't be undone.`)) {
      await deleteProject(p.id);
    }
    refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top)+12px)]">
        <h1 className="text-2xl font-extrabold tracking-tight">🐾 PawCut</h1>
        <button
          type="button"
          aria-label="Diagnostics"
          onClick={() => navigate({ name: 'diagnostics' })}
          className="flex size-11 items-center justify-center text-zinc-500"
        >
          <Icon name="gear" size={22} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32">
        {projects && projects.length === 0 && (
          <p className="mt-16 text-center text-zinc-500">No projects yet. Tap New project to import videos.</p>
        )}
        <ul className="grid grid-cols-2 gap-3">
          {projects?.map((p) => {
            const { durationSec, posterAssetId } = projectSummary(p);
            return (
              <li key={p.id} className="relative">
                <button
                  type="button"
                  onClick={() => navigate({ name: 'editor', id: p.id })}
                  className="block w-full text-left active:opacity-80"
                >
                  <div className="aspect-[9/16] overflow-hidden rounded-2xl bg-zinc-900">
                    <Poster assetId={posterAssetId} />
                  </div>
                  <div className="mt-1.5 truncate pr-8 text-sm font-semibold">{p.name}</div>
                  <div className="text-xs text-zinc-500">
                    {formatDuration(durationSec)} · {timeAgo(p.updatedAt)}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label="Project options"
                  onClick={() => setMenuFor(p)}
                  className="absolute bottom-0 right-0 flex size-11 items-center justify-center text-zinc-400"
                >
                  <Icon name="more" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 bg-gradient-to-t from-[var(--bg)] via-[var(--bg)] px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-8">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="pointer-events-auto flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-pink-500 text-lg font-bold active:scale-[0.98]"
        >
          <Icon name="plus" /> New project
        </button>
      </div>
      <input ref={fileInput} type="file" accept="video/*" multiple className="hidden" onChange={(e) => void onPick(e)} />

      <Sheet open={menuFor !== null} onClose={() => setMenuFor(null)} title={menuFor?.name}>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => void act('rename')} className="min-h-12 rounded-xl bg-zinc-800 font-semibold">
            Rename
          </button>
          <button type="button" onClick={() => void act('duplicate')} className="min-h-12 rounded-xl bg-zinc-800 font-semibold">
            Duplicate
          </button>
          <button type="button" onClick={() => void act('delete')} className="min-h-12 rounded-xl bg-red-950 font-semibold text-red-300">
            Delete
          </button>
        </div>
      </Sheet>
    </div>
  );
}
