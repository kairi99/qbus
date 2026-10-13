import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';

test('menu offers the articulated bus for shifts and free roam, and it drives and bends', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 });
  // Route shifts and free roam both list it.
  await expect(page.locator('[data-bus="articulado"]')).toBeVisible();
  await page.locator('[data-mode="free"]').click();
  await page.locator('[data-bus="articulado"]').click();
  await expect(page.locator('.mn-summary')).toHaveText('Articulado BRT, La Mariscal, Paseo libre');
  await page.screenshot({ path: `${shots}/80-setup-articulated.png`, fullPage: true });

  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  const info = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { id: q.bus.preset.id, bodies: q.bus.bodies.length, wheels: q.bus.wheelCount };
  });
  expect(info).toEqual({ id: 'articulado', bodies: 2, wheels: 6 });

  const state = () =>
    page.evaluate(() => {
      const { bus } = (window as any).__qbus;
      return { speed: bus.speed as number, bend: bus.bend as number, on: bus.wheelsOnGround as number, front: bus.body.translation(), rear: bus.rear.body.translation() };
    });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await state()).speed, { timeout: 45_000 }).toBeGreaterThan(6);
  await page.screenshot({ path: `${shots}/81-articulated-driving.png` });
  await page.keyboard.down('KeyA');
  await expect.poll(async () => Math.abs((await state()).bend), { timeout: 45_000 }).toBeGreaterThan(0.05);
  await page.screenshot({ path: `${shots}/82-articulated-bending.png` });
  const s = await state();
  // The rear section trails the front one by the length of the bus, in a bend.
  expect(Math.hypot(s.front.x - s.rear.x, s.front.z - s.rear.z)).toBeGreaterThan(8);
  expect(s.on).toBeGreaterThanOrEqual(4);
  await page.keyboard.up('KeyA');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/83-articulated-cockpit.png` });
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('a route shift in the articulated bus starts and moves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&city=mariscal&bus=articulado&tutorial=0');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__qbus.bus.preset.id)).toBe('articulado');
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 45_000 }).toBeGreaterThan(6);
  await expect(page.locator('.gh-timer')).toBeVisible();
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
