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

export { copyBlobToOpfs, writeBlobToOpfs } from './opfsSync';
