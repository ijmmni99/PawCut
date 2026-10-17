/** Opens the iOS/Android share sheet (Save Video, TikTok, Files…). Falls back to a download. */
export async function shareFile(file: File): Promise<void> {
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
  }
  downloadFile(file);
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatDuration(sec: number, precise = false): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${precise ? s.toFixed(1).padStart(4, '0') : Math.floor(s).toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
