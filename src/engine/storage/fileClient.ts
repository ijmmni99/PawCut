import type { FileWriteRequest, FileWriteResult } from './file.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(): void; reject(e: Error): void }>();

/** Saves a blob to an OPFS path (via a worker; writes are serialised). */
export function writeFile(path: string, blob: Blob): Promise<void> {
  if (!worker) {
    worker = new Worker(new URL('./file.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FileWriteResult>) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error) job?.reject(new Error(e.data.error));
      else job?.resolve();
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker?.postMessage({ id, path, blob } satisfies FileWriteRequest);
  });
}
