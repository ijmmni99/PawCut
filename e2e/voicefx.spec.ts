import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Voice changer: Chipmunk (+8 semitones) on a clip whose sound is a 330 Hz tone → the export's tone is ~524 Hz.
const video = fileURLToPath(new URL('./fixtures/portrait.mp4', import.meta.url));

/** Dominant frequency of the export's audio between `from` and `to` (zero crossings of a pure tone). */
function toneHz(file: string, from: number, to: number): number {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-to', String(to), '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], {
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  let crossings = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) crossings++;
  return crossings / (x.length / 48000);
}

test('voice changer: chipmunk raises the pitch in the export', async ({ page }, info) => {
  test.skip(!existsSync(video), 'run scripts/make-fixtures.sh first');
  test.setTimeout(300_000);
  await page.goto('/?codec=vp9');
  await page.locator('input[type=file]').setInputFiles([video]);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __pawcut: { assets: { getState(): { assets: Record<string, { status: string }> } } } };
          const all = Object.values(w.__pawcut.assets.getState().assets);
          return all.length > 0 && all.every((a) => a.status === 'ready');
        }),
      { timeout: 200_000 },
    )
    .toBe(true);

  await page.getByRole('button', { name: 'Voice FX' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Chipmunk/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as { __pawcut: { editor: { getState(): { project: { main: Array<{ voiceFx?: string }> } | null } } } };
        return w.__pawcut.editor.getState().project?.main[0]?.voiceFx;
      }),
    )
    .toBe('chipmunk');
  await page.mouse.click(5, 5);
  await page.waitForTimeout(3500); // the 3 s audition

  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 200_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const file = info.outputPath('chipmunk.mp4');
  await (await download).saveAs(file);
  const hz = toneHz(file, 2, 6);
  console.log(`export tone ${hz.toFixed(0)} Hz (source 330, chipmunk ≈ 524)`);
  expect(Math.abs(hz - 524)).toBeLessThan(20);
});
