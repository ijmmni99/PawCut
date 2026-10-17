import type { ExportEvent, ExportPreset, RenderEvent, RenderRequest } from './protocol';

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

/** Renders a project timeline in a dedicated worker. */
export function startRender(
  request: Extract<RenderRequest, { type: 'start' }>,
  onEvent: (e: RenderEvent) => void,
): ExportHandle {
  const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      worker.terminate();
      resolve();
    };
    worker.onmessage = (e: MessageEvent<RenderEvent>) => {
      onEvent(e.data);
      if (e.data.type !== 'progress') finish();
    };
    worker.onerror = (e) => {
      onEvent({ type: 'error', message: e.message || 'Export worker crashed' });
      finish();
    };
  });
  worker.postMessage(request);
  return { cancel: () => worker.postMessage({ type: 'cancel' }), done };
}
