/// <reference lib="webworker" />
// Worker-only blob → OPFS writes via synchronous access handles (no Mediabunny dependency).
import { getFileHandle } from './opfs';

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
