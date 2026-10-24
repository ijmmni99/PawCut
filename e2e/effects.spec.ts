import { type Page, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 5: a transition on the cut and a filter on a clip, in the paused preview and in the export.
// Clip 1 = colourful test pattern (8s), clip 2 = plain dark blue (11s, speech fixture).
const first = fileURLToPath(new URL('./fixtures/portrait.mp4', import.meta.url));
const second = fileURLToPath(new URL('./fixtures/speech.mp4', import.meta.url));

type Clip = { transition?: { kind: string; duration: number }; look?: { filter: string } };

const clips = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pawcut: { editor: { getState(): { project: { main: Clip[] } | null } } } };
    return w.__pawcut.editor.getState().project?.main ?? [];
  });

const setTime = (page: Page, t: number) =>
  page.evaluate((time) => {
    const w = window as unknown as { __pawcut: { playback: { getState(): { setTime(t: number): void } } } };
    w.__pawcut.playback.getState().setTime(time);
  }, t);

/** Average RGB of an image file (ffmpeg scales it to one pixel). */
function avgRgb(file: string, at?: number): [number, number, number] {
  const args = ['-v', 'error', ...(at !== undefined ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const out = spawnSync('ffmpeg', args).stdout;
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

test('transition + filter in preview and export', async ({ page }, info) => {
  test.skip(!existsSync(first) || !existsSync(second), 'run scripts/make-fixtures.sh first');
  test.setTimeout(600_000);
  await page.goto('/?codec=vp9');
  await page.locator('input[type=file]').setInputFiles([first, second]);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __pawcut: { assets: { getState(): { assets: Record<string, { status: string }> } } } };
          const all = Object.values(w.__pawcut.assets.getState().assets);
          return all.length === 2 && all.every((a) => a.status === 'ready');
        }),
      { timeout: 300_000 },
    )
    .toBe(true);

  // Transition: nearest cut to the playhead (8s) → Dip white, 1s.
  await setTime(page, 7.5);
  await page.getByRole('button', { name: 'Transition', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('slider', { name: 'Transition length' }).fill('1');
  await sheet.getByRole('button', { name: /Dip white/ }).click();
  await expect.poll(async () => (await clips(page))[0]?.transition).toEqual({ kind: 'dipWhite', duration: 1 });
  await page.mouse.click(5, 5);
  // Picking a transition replays the cut (7.0–9.0s); let it finish.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as { __pawcut: { playback: { getState(): { playing: boolean; time: number } } } };
        const s = w.__pawcut.playback.getState();
        return !s.playing && s.time > 8.9;
      }),
    { timeout: 20_000 })
    .toBe(true);

  // Filter: B&W on the blue clip.
  await setTime(page, 12);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'B&W' }).click();
  await expect.poll(async () => (await clips(page))[1]?.look?.filter).toBe('bw');
  await page.mouse.click(5, 5);

  // Paused preview at the middle of the cut is (nearly) white; inside clip 2 it's grey, not blue.
  await setTime(page, 8);
  const preview = page.getByTestId('preview');
  await expect
    .poll(async () => {
      await preview.screenshot({ path: info.outputPath('cut.png') });
      return avgRgb(info.outputPath('cut.png'))[0];
    }, { timeout: 20_000 })
    .toBeGreaterThan(200);
  await setTime(page, 12);
  await expect
    .poll(async () => {
      await preview.screenshot({ path: info.outputPath('bw.png') });
      const [r, , b] = avgRgb(info.outputPath('bw.png'));
      return Math.abs(b - r);
    }, { timeout: 20_000 })
    .toBeLessThan(4);

  // Export.
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 300_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const file = info.outputPath('effects.mp4');
  await (await download).saveAs(file);
  const atCut = avgRgb(file, 8.0);
  const before = avgRgb(file, 6.0);
  const blue = avgRgb(file, 12.0);
  console.log(`export: cut ${atCut}, before ${before}, clip2 ${blue}`);
  expect(atCut[0]).toBeGreaterThan(200);
  expect(Math.abs(blue[2] - blue[0])).toBeLessThan(4);
  expect(Math.abs(before[0] - atCut[0])).toBeGreaterThan(40);
});
