import { useEffect, useRef } from 'react';
import { formatDuration } from '../../app/share';
import type { LibraryItem } from '../../library/audioTypes';

/**
 * Whole-track waveform with a draggable window the length of the video: drag it to choose where the music starts
 * ("pick the chorus"). Beats are marked so the window can start on one.
 */
export function OffsetPicker({
  item,
  windowSec,
  value,
  onChange,
}: {
  item: LibraryItem;
  windowSec: number;
  value: number;
  onChange(inSec: number): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; value: number } | null>(null);
  const span = Math.min(windowSec, item.durationSec);
  const max = Math.max(0, item.durationSec - span);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = item.waveform.length;
    ctx.fillStyle = '#a78bfa';
    item.waveform.forEach((peak, i) => {
      const bh = Math.max(1, peak * (h - 10));
      ctx.fillRect((i / n) * w, (h - bh) / 2, Math.max(1, w / n - 1), bh);
    });
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const b of item.beats) ctx.fillRect((b / item.durationSec) * w, h - 4, 1, 4);
  }, [item]);

  const pct = (sec: number) => `${(sec / item.durationSec) * 100}%`;
  const snapToBeat = (sec: number) => {
    let best = sec;
    for (const b of item.beats) if (Math.abs(b - sec) < Math.abs(best - sec) && Math.abs(b - sec) < 0.3) best = b;
    return best;
  };

  return (
    <div>
      <div
        className="relative h-16 touch-none select-none rounded-lg bg-zinc-800"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const width = e.currentTarget.getBoundingClientRect().width;
          const sec = drag.current.value + ((e.clientX - drag.current.x) / width) * item.durationSec;
          onChange(Math.min(max, Math.max(0, snapToBeat(sec))));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 size-full" />
        <div
          className="absolute inset-y-0 rounded-lg border-2 border-white bg-white/15"
          style={{ left: pct(value), width: pct(span) }}
        />
      </div>
      <div className="mt-1 flex justify-between text-xs text-zinc-400">
        <span>Starts at {formatDuration(value, true)}</span>
        <span>Drag to pick the part you want</span>
      </div>
    </div>
  );
}
