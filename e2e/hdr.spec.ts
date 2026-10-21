import { type Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// iPhone HDR (HLG, BT.2020) must not look washed out: a flat 75% HLG grey (reference white) should come out near
// white in the proxy and the export, not mid-grey. Chromium converts HDR on upload itself, so here this mainly guards
// against double conversion; Safari (raw upload) takes the tone-mapping shader path. Fixture: scripts/make-fixtures.sh.
const clip = fileURLToPath(new URL('./fixtures/hlg.mp4', import.meta.url));

async function readOpfs(page: Page, path: string): Promise<Buffer> {
  const b64 = await page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split('/');
    const name = parts.pop() as string;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const bytes = new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, path);
  return Buffer.from(b64, 'base64');
}

/** Mean grey level (0–255) of the centre of the first frame, via ffmpeg. */
function centreLevel(file: string): number {
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'crop=iw/4:ih/4,scale=1:1,format=gray', '-f', 'rawvideo', '-',
  ]);
  return out[0] ?? 0;
}

test('HLG footage is tone-mapped, not washed out', async ({ page }, info) => {
  test.skip(!existsSync(clip), 'run scripts/make-fixtures.sh first');
  await page.goto('/?codec=vp9');
  await page.locator('input[type=file]').setInputFiles([clip]);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __pawcut: { assets: { getState(): { assets: Record<string, { status: string }> } } } };
          const all = Object.values(w.__pawcut.assets.getState().assets);
          return all.length > 0 && all.every((a) => a.status === 'ready');
        }),
      { timeout: 300_000 },
    )
    .toBe(true);
  const asset = await page.evaluate(() => {
    const w = window as unknown as { __pawcut: { assets: { getState(): { assets: Record<string, { proxyPath: string; proxyVersion?: number; prepStats?: { scaler: string } }> } } } };
    return Object.values(w.__pawcut.assets.getState().assets)[0];
  });
  expect(asset?.proxyVersion).toBe(3);

  const proxyFile = info.outputPath('proxy.mp4');
  (await import('node:fs')).writeFileSync(proxyFile, await readOpfs(page, asset?.proxyPath ?? ''));
  const proxyLevel = centreLevel(proxyFile);

  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 300_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const exportFile = info.outputPath('export.mp4');
  await (await download).saveAs(exportFile);
  const exportLevel = centreLevel(exportFile);

  console.log(`HDR levels: proxy ${proxyLevel}, export ${exportLevel} (raw signal would be ~191)`);
  expect(proxyLevel).toBeGreaterThan(225);
  expect(exportLevel).toBeGreaterThan(225);
  expect(Math.abs(proxyLevel - exportLevel)).toBeLessThan(12);
});
