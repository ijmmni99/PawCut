import { lazy, Suspense, useEffect, useState } from 'react';
import { EditorScreen } from '../editor/EditorScreen';
import { resumeInterruptedImports } from '../engine/media/importClient';
import { getSetting } from '../library/db';
import { LAST_PROJECT_KEY, loadAssets, startAutosave } from '../library/projects';
import { UpdatePrompt } from '../pwa/UpdatePrompt';
import { ProjectsScreen } from './ProjectsScreen';
import { navigate, parseHash, useHash } from './router';

const SpikeScreen = lazy(() => import('./SpikeScreen').then((m) => ({ default: m.SpikeScreen })));

async function boot(): Promise<void> {
  void navigator.storage?.persist?.().catch(() => false);
  await loadAssets();
  void resumeInterruptedImports();
  // Relaunch after the app was killed: go straight back into the project that was open.
  if (parseHash(location.hash).name === 'projects') {
    const last = await getSetting<string | null>(LAST_PROJECT_KEY);
    if (last) navigate({ name: 'editor', id: last }, true);
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const route = parseHash(useHash());

  useEffect(() => {
    const stop = startAutosave();
    void boot().finally(() => setReady(true));
    return stop;
  }, []);

  return (
    <>
      {ready && route.name === 'projects' && <ProjectsScreen />}
      {ready && route.name === 'editor' && <EditorScreen key={route.id} projectId={route.id} />}
      {route.name === 'diagnostics' && (
        <Suspense fallback={null}>
          <SpikeScreen />
        </Suspense>
      )}
      <UpdatePrompt />
      <div className="landscape-guard fixed inset-0 z-50 items-center justify-center bg-black text-center text-lg font-semibold">
        Rotate to portrait 📱
      </div>
    </>
  );
}
