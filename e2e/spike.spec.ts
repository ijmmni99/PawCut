import { expect, test } from '@playwright/test';

// Smoke test for the Phase 0 pipeline. Desktop Chromium only stands in for the engine;
// real acceptance happens on an iPhone. Set PAWCUT_SPIKE_VIDEO to a local video file.
// Playwright's Chromium has no H.264/AAC, so the run uses the VP9/Opus engine-test preset.
const video = process.env.PAWCUT_SPIKE_VIDEO;

test('imports a video and exports a 1080x1920 MP4', async ({ page }) => {
  test.skip(!video, 'PAWCUT_SPIKE_VIDEO not set');
  await page.goto('/?codec=vp9');
  await expect(page.getByText('Cross-origin isolated')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(video ?? '');
  await expect(page.getByText(/Save \/ Share|Export failed/)).toBeVisible({ timeout: 170_000 });
  await expect(page.getByText('Export failed')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy report' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download instead' }).click();
  const file = await download;
  const out = test.info().outputPath('export.mp4');
  await file.saveAs(out);
  console.log(`EXPORTED ${out}\n${await page.locator('section').first().innerText()}`);
});
