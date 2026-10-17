/// <reference lib="webworker" />
// Worker-only OPFS writers built on synchronous access handles (the fast path on iOS Safari).
import { StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { getFileHandle } from './opfs';

export type OpfsStreamTarget = { target: StreamTarget; close(): number };

/** A Mediabunny target that streams muxed bytes straight into an OPFS file. `close()` returns the file size. */
export async function createOpfsTarget(path: string): Promise<OpfsStreamTarget> {
  const handle = await getFileHandle(path, true);
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  let size = 0;
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      access.write(chunk.data, { at: chunk.position });
      size = Math.max(size, chunk.position + chunk.data.byteLength);
    },
  });
  return {
    target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    close() {
      access.flush();
      access.close();
      return size;
    },
  };
}

/** Copies a Blob into OPFS in chunks so large videos never sit in memory at once. */
export async function copyBlobToOpfs(blob: Blob, path: string, onProgress?: (fraction: number) => void): Promise<void> {
  const handle = await getFileHandle(path, true);
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    const chunk = 8 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunk) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunk).arrayBuffer());
      access.write(bytes, { at: offset });
      onProgress?.(Math.min(1, (offset + bytes.byteLength) / blob.size));
    }
    access.flush();
  } finally {
    access.close();
  }
}

export async function writeBlobToOpfs(blob: Blob, path: string): Promise<void> {
  await copyBlobToOpfs(blob, path);
}
