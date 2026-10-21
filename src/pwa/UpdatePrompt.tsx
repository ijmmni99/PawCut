import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { parseHash } from '../app/router';
import { watchForUpdates } from './updates';

/** Updates found this soon after launch are applied straight away: nothing is being edited yet. */
const AUTO_APPLY_WINDOW_MS = 20_000;

/** Safe to reload without asking: just launched, or sitting on the projects list (no edit or export running). */
function safeToApply(): boolean {
  return performance.now() < AUTO_APPLY_WINDOW_MS || parseHash(location.hash).name === 'projects';
}

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) watchForUpdates(reg);
    },
  });

  useEffect(() => {
    if (needRefresh && safeToApply()) void updateServiceWorker(true);
  }, [needRefresh, updateServiceWorker]);

  if (!needRefresh) return null;

  return (
    <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+16px)] z-40 flex items-center gap-3 rounded-2xl bg-zinc-800 p-3 shadow-xl">
      <span className="flex-1 text-sm">New version available</span>
      <button type="button" onClick={() => setNeedRefresh(false)} className="min-h-11 px-3 text-sm text-zinc-400">
        Later
      </button>
      <button
        type="button"
        onClick={() => void updateServiceWorker(true)}
        className="min-h-11 rounded-xl bg-pink-500 px-4 text-sm font-bold"
      >
        Update
      </button>
    </div>
  );
}
