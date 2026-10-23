import { type Page, expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Phase 4: speech video → word-pop captions in 2 taps (Captions → Generate), text overlay, both burnt into the
// export. Uses whisper-tiny (?whisper=tiny) to keep the run short; needs network for the model on first run.
const video = fileURLToPath(new URL('./fixtures/speech.mp4', import.meta.url));

type Project = {
  captions?: { preset: string; words: Array<{ text: string; start: number; end: number }> };
  texts?: Array<{ text: string; start: number; duration: number }>;
};

const project = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pawcut: { editor: { getState(): { project: Project | null } } } };
    return w.__pawcut.editor.getState().project;
  });

/** Fraction of near-white pixels in the lower-middle band of the overlay canvas. */
const overlayInk = (page: Page) =>
  page.getByTestId('overlay').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, Math.round(c.height * 0.5), c.width, Math.round(c.height * 0.35));
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i + 3] as number) > 200 && (data[i] as number) > 220) ink++;
    return ink / (data.length / 4);
  });

/** Fraction of near-white pixels in a band of an exported frame (the background is dark blue). */
function frameInk(file: string, at: number, yFrom: number, yTo: number): number {
  const h = 1920;
  const band = Math.round((yTo - yFrom) * h);
  const raw = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=1080:${band}:0:${Math.round(yFrom * h)},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  ).stdout;
  let ink = 0;
  for (const v of raw) if (v > 200) ink++;
  return ink / Math.max(1, raw.length);
}

test('speech → word-pop captions in 2 taps → text → export', async ({ page }, info) => {
  test.skip(!existsSync(video), 'run scripts/make-fixtures.sh first');
  test.setTimeout(600_000);
  await page.goto('/?codec=vp9&whisper=tiny');
  await page.locator('input[type=file]').setInputFiles([video]);
  await expect(page.getByRole('button', { name: 'Captions' })).toBeEnabled({ timeout: 60_000 });
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

  // Two taps.
  await page.getByRole('button', { name: 'Captions' }).click();
  await page.getByRole('button', { name: 'Generate captions' }).click();
  await expect.poll(async () => (await project(page))?.captions?.words.length ?? 0, { timeout: 300_000 }).toBeGreaterThan(10);
  const caps = (await project(page))!.captions!;
  expect(caps.preset).toBe('wordPop');
  const text = caps.words.map((w) => w.text.toLowerCase()).join(' ');
  expect(text).toContain('country');
  expect(caps.words[0]!.start).toBeGreaterThan(0.1);
  expect(caps.words[0]!.start).toBeLessThan(1.2);
  // Transcript editor lists the captions; restyle in one tap.
  await expect(page.getByRole('textbox', { name: 'Caption 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Karaoke/ }).click();
  expect((await project(page))?.captions?.preset).toBe('karaoke');
  await page.mouse.click(5, 5);

  // Captions show on the preview at a spoken moment.
  await page.evaluate(() => {
    const w = window as unknown as { __pawcut: { playback: { getState(): { setTime(t: number): void } } } };
    w.__pawcut.playback.getState().setTime(4.4);
  });
  await expect.poll(() => overlayInk(page), { timeout: 15_000 }).toBeGreaterThan(0.002);

  // A text overlay.
  await page.evaluate(() => {
    const w = window as unknown as { __pawcut: { playback: { getState(): { setTime(t: number): void } } } };
    w.__pawcut.playback.getState().setTime(0);
  });
  // Captions stay selected after generating (their toolbar is showing); Done returns to the main tools.
  await page.getByRole('navigation').getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text' }).fill('Hello Luna');
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  const texts = (await project(page))?.texts ?? [];
  expect(texts).toHaveLength(1);
  expect(texts[0]).toMatchObject({ text: 'Hello Luna', start: 0 });
  await page.screenshot({ path: info.outputPath('captions-ui.png') });

  // Export burns both in: captions near the bottom while speaking, the text near the top at the start.
  await page.getByRole('navigation').getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Save / Share' })).toBeVisible({ timeout: 300_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  const file = info.outputPath('captions.mp4');
  await (await download).saveAs(file);
  const capInk = frameInk(file, 4.4, 0.6, 0.76);
  const textInk = frameInk(file, 1.0, 0.3, 0.46);
  const blankInk = frameInk(file, 1.0, 0.85, 1);
  console.log(`export ink: captions ${capInk.toFixed(4)}, text ${textInk.toFixed(4)}, blank ${blankInk.toFixed(4)}`);
  expect(capInk).toBeGreaterThan(0.01);
  expect(textInk).toBeGreaterThan(0.01);
  expect(blankInk).toBeLessThan(0.001);
});
