import { expect, test } from '@playwright/test';

// Software WebGL is always slow, so with ?adaptive=1 the renderer must step its resolution down.
test('adaptive quality lowers the resolution when the frame rate stays low', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?tutorial=0&play=1&city=mariscal&adaptive=1');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  const full = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('#game')!.width);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.quality.level), { timeout: 180_000, intervals: [2000] }).toBeGreaterThan(0);
  const lower = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('#game')!.width);
  expect(lower).toBeLessThan(full);
});

test('automation keeps full resolution by default', async ({ page }) => {
  await page.goto('/?tutorial=0&play=1&city=mariscal');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 120_000 });
  await page.waitForTimeout(15_000);
  expect(await page.evaluate(() => (window as any).__qbus.quality.level)).toBe(0);
});
