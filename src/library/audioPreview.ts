// One shared <audio> element for auditioning library items (music rows, SFX buttons). Starting a new preview stops
// the previous one. `usePreview` exposes which item is playing so lists can show play/pause state.
import { create } from 'zustand';
import { readFile } from '../engine/storage/opfs';
import { useLibrary } from './audioLibrary';

export const usePreview = create<{ playingId: string | null }>()(() => ({ playingId: null }));

let el: HTMLAudioElement | null = null;
let url: string | null = null;

function element(): HTMLAudioElement {
  if (el) return el;
  el = new Audio();
  el.addEventListener('ended', () => usePreview.setState({ playingId: null }));
  return el;
}

export function stopPreview(): void {
  el?.pause();
  usePreview.setState({ playingId: null });
}

/** Plays a library item from `fromSec` (call from a tap). Tapping the playing item again stops it. */
export async function togglePreview(id: string, fromSec = 0): Promise<void> {
  if (usePreview.getState().playingId === id) {
    stopPreview();
    return;
  }
  const item = useLibrary.getState().items[id];
  if (!item) return;
  const audio = element();
  // Start loading synchronously inside the tap so iOS allows playback.
  audio.pause();
  usePreview.setState({ playingId: id });
  const file = await readFile(item.path);
  if (usePreview.getState().playingId !== id) return;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  audio.src = url;
  audio.currentTime = fromSec;
  await audio.play().catch(() => usePreview.setState({ playingId: null }));
}
