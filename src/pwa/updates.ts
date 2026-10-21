// Service-worker update checks. An installed iOS web app can stay in memory for days, so checking only at cold start
// means updates are rarely noticed: also check whenever the app comes back to the foreground and every 30 minutes.

let registration: ServiceWorkerRegistration | null = null;

const CHECK_EVERY_MS = 30 * 60 * 1000;

export function watchForUpdates(reg: ServiceWorkerRegistration): void {
  registration = reg;
  const check = () => void reg.update().catch(() => undefined);
  window.setInterval(check, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

/** Asks the server for a new version now. Resolves true if one is downloading or waiting to be applied. */
export async function checkForUpdate(): Promise<boolean> {
  const reg = registration ?? (await navigator.serviceWorker?.getRegistration());
  if (!reg) return false;
  await reg.update();
  return reg.installing !== null || reg.waiting !== null;
}
