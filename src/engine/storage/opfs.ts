// OPFS helpers usable from both the main thread and workers. Paths are '/'-separated, relative to the OPFS root.

async function dirFor(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory();
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

function split(path: string): { dirs: string[]; name: string } {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid OPFS path: ${path}`);
  return { dirs: parts, name };
}

export async function getFileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const { dirs, name } = split(path);
  const dir = await dirFor(dirs, create);
  return dir.getFileHandle(name, { create });
}

export async function readFile(path: string): Promise<File> {
  return (await getFileHandle(path)).getFile();
}

export async function removeEntry(path: string): Promise<void> {
  const { dirs, name } = split(path);
  try {
    const dir = await dirFor(dirs, false);
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // Already gone.
  }
}

export const assetDir = (assetId: string) => `media/${assetId}`;
