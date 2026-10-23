import { type Page, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 3: music library import (BPM), "Use" in ≤3 taps (fitted to the video + fade-out), SFX at the playhead,
// and the export actually containing the music with its fade. Fixtures: scripts/make-fixtures.sh.
const video = fileURLToPath(new URL('./fixtures/portrait.mp4', import.meta.url));
const music = fileURLToPath(new URL('./fixtures/music.mp3', import.meta.url));

type AudioClip = { track: string; start: number; inSec: number; outSec: number; fadeOut: number; sourceId: string };

const audio = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pawcut: { editor: { getState(): { project: { audio?: AudioClip[] } | null } } } };
    return w.__pawcut.editor.getState().project?.audio ?? [];
  });

/** Mean volume (dB) of a time range of a media file's audio. */
function meanDb(file: string, from: number, to: number): number {
  // volumedetect reports on stderr.
  const out = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-to', String(to), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  }).stderr;
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)?.[1] ?? '-99');
}

test('music library → use → sfx → export', async ({ page }, info) => {
  test.skip(!existsSync(video) || !existsSync(music), 'run scripts/make-fixtures.sh first');
  await page.goto('/?codec=vp9');
  await page.locator('input[type=file]').setInputFiles([video]);
  await expect(page.getByRole('button', { name: 'Music' })).toBeEnabled({ timeout: 60_000 });
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
  // The video's own sound is measured for ducking.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __pawcut: { assets: { getState(): { assets: Record<string, { loudness?: { db: number[] } }> } } } };
          return Object.values(w.__pawcut.assets.getState().assets)[0]?.loudness?.db.length ?? 0;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(10);

  // Import a track into the library; tempo is detected.
  await page.getByRole('button', { name: 'Music' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.locator('input[type=file][accept^="audio"]').setInputFiles([music]);
  await expect(sheet.getByText('music', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText(/120 BPM/)).toBeVisible();
  // PawCut's own tracks are composed on first open.
  await expect(sheet.getByText('Zoomies', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(sheet.getByText(/140 BPM/)).toBeVisible();
  await expect(sheet.getByText('Golden Hour', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.mouse.click(5, 5); // dismiss via backdrop

  // Taps to add: Music → Use (2 taps).
  await page.getByRole('button', { name: 'Music' }).click();
  await sheet
    .locator('li')
    .filter({ has: page.getByText('music', { exact: true }) })
    .getByRole('button', { name: 'Use' })
    .click();
  let clips = await audio(page);
  expect(clips).toHaveLength(1);
  expect(clips[0]).toMatchObject({ track: 'music', start: 0, inSec: 0 });
  expect(clips[0]!.outSec).toBeCloseTo(8, 0); // fitted to the 8s video
  expect(clips[0]!.fadeOut).toBeGreaterThan(1.5);

  // SFX: tap twice to drop a pop at the playhead (2s).
  await page.evaluate(() => {
    const w = window as unknown as { __pawcut: { playback: { getState(): { setTime(t: number): void } } } };
    w.__pawcut.playback.getState().setTime(2);
  });
  await page.getByRole('button', { name: 'SFX' }).click();
  const pop = sheet.getByRole('button', { name: 'Pop', exact: true });
  await expect(pop).toBeVisible({ timeout: 30_000 });
  await pop.click();
  await sheet.getByRole('button', { name: 'Tap to add' }).click();
  clips = await audio(page);
  expect(clips.find((c) => c.track === 'sfx')).toMatchObject({ start: 2 });
  await page.mouse.click(5, 5);

  // Mute the video's own sound so the measurement below hears only the music.
  await page.getByRole('button', { name: 'Volume', exact: true }).click();
  await sheet.getByRole('button', { name: 'Mute original sound' }).click();
  await page.mouse.click(5, 5);

  // Export and check the mix: music present, fading out at the end.
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 300_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const out = info.outputPath('export.mp4');
  await (await download).saveAs(out);
  const body = meanDb(out, 2.5, 5);
  const tail = meanDb(out, 7.6, 8);
  console.log(`mix levels: body ${body} dB, last 0.4s ${tail} dB`);
  expect(body).toBeGreaterThan(-30); // the music is there
  expect(tail).toBeLessThan(body - 6); // and fades out
});
