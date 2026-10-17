import { useRegisterSW } from 'virtual:pwa-register/react';

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

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
