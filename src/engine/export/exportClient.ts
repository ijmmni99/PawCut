import type { ExportEvent, ExportPreset } from './protocol';

export type ExportHandle = { cancel(): void; done: Promise<void> };

/** Starts an export in a dedicated worker. Events are forwarded to `onEvent`. */
export function startExport(file: File, preset: ExportPreset, onEvent: (e: ExportEvent) => void): ExportHandle {
  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<void>((resolve) => {
    worker.onmessage = (e: MessageEvent<ExportEvent>) => {
      onEvent(e.data);
      if (e.data.type === 'done' || e.data.type === 'error') {
        worker.terminate();
        resolve();
      }
    };
    worker.onerror = (e) => {
      onEvent({ type: 'error', message: e.message || 'Export worker crashed', discarded: [] });
      worker.terminate();
      resolve();
    };
  });
  worker.postMessage({ type: 'start', file, preset });
  return {
    cancel: () => worker.postMessage({ type: 'cancel' }),
    done,
  };
}

export async function readOpfsFile(name: string, downloadName: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  // Re-wrap so the share sheet / Photos sees a friendly name and the right MIME type.
  return new File([file], downloadName, { type: 'video/mp4' });
}
