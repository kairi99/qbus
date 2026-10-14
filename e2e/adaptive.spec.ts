import { expect, test } from '@playwright/test';

// The stepping rules are unit-tested (tests/adaptiveQuality.test.ts); this checks the wiring. Under
// software WebGL the frame rate depends on the machine's load (GPU-bound when quiet: fewer pixels
// help and it steps down; CPU-bound or under a frame a second when busy: it tries one step and
// undoes it, or skips the frames as stalls), so the test accepts any of those and checks that
// whatever level it is at is the canvas's resolution.
test('adaptive quality is fed frames and applies its level to the canvas', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?tutorial=0&play=1&city=mariscal&adaptive=1');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  const full = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('#game')!.width);
  const state = () => page.evaluate(() => {
    const q = (window as any).__qbus.quality;
    return { level: q.level as number, disabled: q.disabled as boolean, settle: q.settle as number, width: document.querySelector<HTMLCanvasElement>('#game')!.width };
  });
  // Fed: its settle timer runs down (it starts at 5 s), or it already stepped.
  await expect.poll(async () => { const q = await state(); return q.level > 0 || q.disabled || q.settle < 4.5; }, { timeout: 180_000, intervals: [2000] }).toBe(true);
  const q = await state();
  if (q.level > 0) expect(q.width).toBeLessThan(full);
  else expect(q.width).toBe(full);
});

test('automation keeps full resolution by default', async ({ page }) => {
  await page.goto('/?tutorial=0&play=1&city=mariscal');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  await page.waitForTimeout(15_000);
  expect(await page.evaluate(() => (window as any).__qbus.quality.level)).toBe(0);
});
