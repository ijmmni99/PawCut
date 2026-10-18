import { type Page, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Auto-Cut on a 60s clip that is static + silent except for two bursts: 10–14s (moving pattern + tone) and
// 40–44s (a cat moving across + tone). Fixtures: scripts/make-fixtures.sh.
const clip = fileURLToPath(new URL('./fixtures/autocut.mp4', import.meta.url));

type Clip = { inSec: number; outSec: number; speed: number };

const clips = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pawcut: { editor: { getState(): { project: { main: Clip[] } | null } } } };
    return w.__pawcut.editor.getState().project?.main ?? [];
  });

const inBurst = (t: number) => (t >= 9.3 && t <= 14.8) || (t >= 39.3 && t <= 44.8);

async function readAnalysis(page: Page): Promise<{ detector: string; subject: number[] }> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('pawcut');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('analyses').objectStore('analyses').getAll();
          all.onsuccess = () => resolve(all.result[0]);
        };
      }),
  );
}

test('auto-cut finds the action and removes dead air', async ({ page }) => {
  test.skip(!existsSync(clip), 'run scripts/make-fixtures.sh first');
  test.setTimeout(600_000);
  page.on('console', (m) => m.text().includes('Auto-Cut') && console.log(m.text()));

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
      { timeout: 400_000 },
    )
    .toBe(true);

  // Highlights, 15s, Chill.
  await page.getByRole('button', { name: 'Auto-Cut' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Apply to timeline' })).toBeVisible({ timeout: 180_000 });
  console.log(await dialog.locator('text=analysed in').innerText());
  const analysis = await readAnalysis(page);
  const subjectAt = (sec: number) => analysis.subject[Math.floor(sec / 0.25)] ?? 0;
  console.log(`detector=${analysis.detector} subject@42s=${subjectAt(42).toFixed(2)} subject@20s=${subjectAt(20).toFixed(2)}`);
  expect(analysis.detector).toBe('ok');
  expect(Math.max(...[40.5, 41, 41.5, 42, 42.5, 43].map(subjectAt))).toBeGreaterThan(0.3); // the cat
  expect(subjectAt(20)).toBe(0);

  await dialog.getByRole('button', { name: '15s' }).click();
  await dialog.getByRole('button', { name: 'Apply to timeline' }).click();
  let result = await clips(page);
  const total = result.reduce((t, c) => t + (c.outSec - c.inSec) / c.speed, 0);
  console.log('highlights', JSON.stringify(result.map((c) => [c.inSec, c.outSec])));
  expect(total).toBeGreaterThan(13);
  expect(total).toBeLessThanOrEqual(15.1);
  // Both bursts are covered, padded with context around them rather than unrelated footage.
  expect(result.some((c) => c.inSec < 13 && c.outSec > 11)).toBe(true);
  expect(result.some((c) => c.inSec < 43 && c.outSec > 41)).toBe(true);
  expect(result.length).toBe(2);
  // Undo restores the original clip in one step.
  await page.getByRole('button', { name: 'Undo' }).click();
  expect((await clips(page)).length).toBe(1);

  // Remove dead air: only the two bursts (plus small padding) survive, in order.
  await page.getByRole('button', { name: 'Auto-Cut' }).click();
  await dialog.getByRole('button', { name: 'Remove dead air' }).click();
  await dialog.getByRole('button', { name: 'Apply to timeline' }).click();
  result = await clips(page);
  console.log('dead air', JSON.stringify(result.map((c) => [c.inSec, c.outSec])));
  expect(result.length).toBe(2);
  for (const c of result) {
    expect(inBurst(c.inSec)).toBe(true);
    expect(inBurst(c.outSec)).toBe(true);
  }
  await page.getByRole('button', { name: 'Undo' }).click();

  // Hype adds slow-motion ramps.
  await page.getByRole('button', { name: 'Auto-Cut' }).click();
  await dialog.getByRole('button', { name: /Hype/ }).click();
  await dialog.getByRole('button', { name: 'Apply to timeline' }).click();
  result = await clips(page);
  expect(result.some((c) => c.speed === 0.5)).toBe(true);
});
