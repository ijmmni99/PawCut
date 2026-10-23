/// <reference lib="webworker" />
// Writes blobs into OPFS for the main thread (sync access handles only exist in workers on iOS Safari).
import { writeBlobToOpfs } from './opfsSync';

declare const self: DedicatedWorkerGlobalScope;

export type FileWriteRequest = { id: number; path: string; blob: Blob };
export type FileWriteResult = { id: number; error: string | null };

let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<FileWriteRequest>) => {
  const { id, path, blob } = e.data;
  queue = queue.then(async () => {
    try {
      await writeBlobToOpfs(blob, path);
      self.postMessage({ id, error: null } satisfies FileWriteResult);
    } catch (err) {
      self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies FileWriteResult);
    }
  });
};
