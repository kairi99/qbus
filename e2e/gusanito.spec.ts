import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 240_000 });

test('the gusanito: in the menu, drives with its wagons wagging behind, cockpit view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-mode="free"]').click();
  await page.locator('[data-bus="gusanito"]').click();
  await expect(page.locator('.mn-summary')).toHaveText('El Gusanito, La Mariscal, Paseo libre');
  await page.locator('[data-bus="gusanito"]').screenshot({ path: `${shots}/90-gusanito-card.png` });
  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.keyboard.press('Escape');

  const info = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { id: q.bus.preset.id, bodies: q.bus.bodies.length, wheels: q.bus.wheelCount };
  });
  expect(info).toEqual({ id: 'gusanito', bodies: 5, wheels: 12 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/91-gusanito-standing.png` });

  const state = () =>
    page.evaluate(() => {
      const { bus } = (window as any).__qbus;
      return { speed: bus.speed as number, bends: bus.rears.map((_: unknown, i: number) => bus.bendAt(i)) as number[], on: bus.wheelsOnGround as number };
    });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await state()).speed, { timeout: 60_000 }).toBeGreaterThan(5);
  await page.keyboard.down('KeyA');
  await expect.poll(async () => Math.max(...(await state()).bends.map(Math.abs)), { timeout: 30_000 }).toBeGreaterThan(0.05);
  await page.screenshot({ path: `${shots}/92-gusanito-turning.png` });
  expect((await state()).on).toBeGreaterThanOrEqual(8);
  await page.keyboard.up('KeyA');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/93-gusanito-cockpit.png` });
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
