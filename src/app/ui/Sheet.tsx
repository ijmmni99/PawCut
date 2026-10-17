import { type ReactNode, useRef, useState } from 'react';

/** Bottom sheet. Tap the backdrop or swipe the grab bar down to close. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  dismissible = true,
}: {
  open: boolean;
  onClose(): void;
  title?: string;
  children: ReactNode;
  dismissible?: boolean;
}) {
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);
  if (!open) return null;

  const onDown = (e: React.PointerEvent) => {
    if (!dismissible) return;
    startY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (startY.current !== null) setDrag(Math.max(0, e.clientY - startY.current));
  };
  const onUp = () => {
    if (startY.current === null) return;
    startY.current = null;
    if (drag > 80) onClose();
    setDrag(0);
  };

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={dismissible ? onClose : undefined} />
      <div
        role="dialog"
        aria-label={title}
        className="relative rounded-t-3xl bg-zinc-900 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl"
        style={{ transform: `translateY(${drag}px)`, transition: drag ? 'none' : 'transform 160ms ease-out' }}
      >
        <div
          className="flex touch-none justify-center py-3"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div className="h-1.5 w-10 rounded-full bg-zinc-600" />
        </div>
        {title && <h2 className="px-5 pb-3 text-lg font-bold">{title}</h2>}
        <div className="px-5">{children}</div>
      </div>
    </div>
  );
}
