// Keeps the screen awake during long jobs. iOS releases the lock whenever the page is hidden,
// so it is re-acquired on visibilitychange until release() is called.

type Sentinel = { release(): Promise<void> };

export function holdWakeLock(): { release(): void } {
  let sentinel: Sentinel | null = null;
  let active = true;

  const acquire = async () => {
    if (!active || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
    } catch {
      sentinel = null;
    }
  };

  const onVisibility = () => void acquire();
  document.addEventListener('visibilitychange', onVisibility);
  void acquire();

  return {
    release() {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    },
  };
}
