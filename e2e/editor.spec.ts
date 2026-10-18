import { type Page, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Full Phase 1 flow on Chromium with the VP9/Opus engine-test profile (Chromium has no H.264/AAC).
// Fixtures: run scripts/make-fixtures.sh first.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const files = [fixture('portrait.mp4'), fixture('rotated.mp4')];

type Snapshot = {
  clips: Array<{ inSec: number; outSec: number; speed: number }>;
  assets: Array<{ status: string; proxyPath: string | null; thumbsPath: string | null; width: number; height: number }>;
  time: number;
  playing: boolean;
  canUndo: boolean;
};

async function snap(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    type Store<T> = { getState(): T };
    const w = window as unknown as {
      __pawcut: {
        editor: Store<{ project: { main: Snapshot['clips'] } | null; past: unknown[] }>;
        assets: Store<{ assets: Record<string, Snapshot['assets'][number]> }>;
        playback: Store<{ time: number; playing: boolean }>;
      };
    };
    const { editor, assets, playback } = w.__pawcut;
    return {
      clips: editor.getState().project?.main ?? [],
      assets: Object.values(assets.getState().assets),
      time: playback.getState().time,
      playing: playback.getState().playing,
      canUndo: editor.getState().past.length > 0,
    };
  });
}

async function setTime(page: Page, t: number): Promise<void> {
  await page.evaluate((time) => {
    const w = window as unknown as { __pawcut: { playback: { getState(): { setTime(t: number): void } } } };
    w.__pawcut.playback.getState().setTime(time);
  }, t);
}

const total = (s: Snapshot) => s.clips.reduce((t, c) => t + (c.outSec - c.inSec) / c.speed, 0);

test('import → edit → export → reload', async ({ page }) => {
  test.skip(!files.every(existsSync), 'run scripts/make-fixtures.sh first');
  page.on('pageerror', (err) => console.log('PAGE ERROR', err.message));

  await page.goto('/?codec=vp9');
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByTestId('timeline')).toBeVisible();

  // Import: both clips appended in order; proxies + thumbnails built.
  await expect.poll(async () => (await snap(page)).clips.length, { timeout: 30_000 }).toBe(2);
  await expect
    .poll(async () => (await snap(page)).assets.filter((a) => a.status === 'ready').length, { timeout: 90_000 })
    .toBe(2);
  let s = await snap(page);
  expect(s.assets.every((a) => a.proxyPath && a.thumbsPath)).toBe(true);
  expect(s.assets.map((a) => `${a.width}x${a.height}`).sort()).toEqual(['720x1280', '720x1280']);
  expect(total(s)).toBeCloseTo(14, 0);

  // Split at 3s, then undo/redo.
  await setTime(page, 3);
  await page.getByRole('button', { name: 'Split' }).click();
  expect((await snap(page)).clips.length).toBe(3);
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await snap(page)).clips.length).toBe(2);
  await page.getByRole('button', { name: 'Redo' }).click();
  s = await snap(page);
  expect(s.clips.length).toBe(3);
  expect(s.clips[0]?.outSec).toBeCloseTo(3, 1);

  // Speed 2× on the clip under the playhead (the second piece of clip A, 3s–8s → 2.5s).
  await page.getByRole('button', { name: 'Speed' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '2×', exact: true }).click();
  await page.mouse.click(10, 10);
  s = await snap(page);
  expect(s.clips[1]?.speed).toBe(2);
  expect(total(s)).toBeCloseTo(3 + 2.5 + 6, 1);

  // Tap the first clip on the timeline to select it, then drag its right handle left to trim.
  const tl = page.getByTestId('timeline');
  const box = (await tl.boundingBox())!;
  await setTime(page, 1.5);
  const cx = box.x + box.width / 2;
  const trackY = box.y + 30 + 32;
  await page.mouse.click(cx, trackY);
  // Default zoom is 60px/s: clip 0 spans 0–3s, its out edge sits 1.5s right of the playhead.
  const edgeX = cx + 1.5 * 60 - 6;
  await page.mouse.move(edgeX, trackY);
  await page.mouse.down();
  await page.mouse.move(edgeX - 30, trackY, { steps: 5 });
  await page.mouse.up();
  s = await snap(page);
  expect(s.clips[0]?.outSec).toBeCloseTo(2.5, 1);

  // Playback advances the playhead.
  await setTime(page, 0);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(3500);
  s = await snap(page);
  const stats = await page.evaluate(
    () => (window as unknown as { __pawcut: { previewStats: { shown: number; dropped: number; maxGapMs: number } } }).__pawcut.previewStats,
  );
  console.log(`after 3.5s: time ${s.time.toFixed(2)} playing=${s.playing} stats ${JSON.stringify(stats)}`);
  expect(s.time).toBeGreaterThan(2.6); // crossed at least one cut
  // Smooth through the cut: ~30fps shown, no long freeze.
  expect(stats.shown).toBeGreaterThan(80);
  expect(stats.maxGapMs).toBeLessThan(200);
  await page.getByRole('button', { name: 'Pause' }).click();

  // Export.
  const expected = total(await snap(page));
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 120_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const out = test.info().outputPath('export.mp4');
  await (await download).saveAs(out);
  console.log(`EXPORTED ${out} expected ${expected.toFixed(2)}s`);

  // Autosave + relaunch: the open project comes back with its edits and undo history.
  await page.waitForTimeout(600);
  await page.goto('/');
  await expect.poll(async () => (await snap(page)).clips.length, { timeout: 10_000 }).toBe(3);
  expect((await snap(page)).canUndo).toBe(true);
});
