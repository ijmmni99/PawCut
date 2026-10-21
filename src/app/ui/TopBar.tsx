import type { ReactNode } from 'react';

const BAR_H = 52;

/**
 * Solid header pinned to the top edge (under the status bar), plus a spacer that reserves its height in the flow.
 * iOS 26 blurs plain page content near the top edge of home-screen web apps; a fixed, opaque bar touching the
 * edge gets treated as the app's top bar instead, so the title stays sharp.
 */
export function TopBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <>
      <div aria-hidden="true" className="shrink-0" style={{ height: `calc(env(safe-area-inset-top) + ${BAR_H}px)` }} />
      <header className="fixed inset-x-0 top-0 z-20 bg-[var(--bg)] pt-[env(safe-area-inset-top)]">
        <div className={`flex items-center ${className}`} style={{ height: BAR_H }}>
          {children}
        </div>
      </header>
    </>
  );
}
