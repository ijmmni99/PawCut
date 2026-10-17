import { useSyncExternalStore } from 'react';

export type Route = { name: 'projects' } | { name: 'editor'; id: string } | { name: 'diagnostics' };

export function parseHash(hash: string): Route {
  const editor = /^#\/p\/([\w-]+)$/.exec(hash);
  if (editor?.[1]) return { name: 'editor', id: editor[1] };
  if (hash === '#/diagnostics') return { name: 'diagnostics' };
  return { name: 'projects' };
}

export function hashFor(route: Route): string {
  switch (route.name) {
    case 'editor':
      return `#/p/${route.id}`;
    case 'diagnostics':
      return '#/diagnostics';
    case 'projects':
      return '#/';
  }
}

export function navigate(route: Route, replace = false): void {
  const hash = hashFor(route);
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}
