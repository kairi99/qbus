import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';

test('a BRT route selects the articulated bus, starts on the busway, shows the arrow and drives', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 });

  // An ordinary bus is selected first; the BRT placard carries the recommendation.
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'popular');
  const placard = page.locator('[data-route="linea-c4"]');
  await expect(placard).toContainText('Recomendado: Articulado');
  await placard.click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'articulado');
  await expect(page.locator('.mn-summary')).toContainText('Articulado BRT');

  // Another bus can still be picked for it; an ordinary route puts the first one back.
  await page.locator('[data-bus="buseta"]').click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'buseta');
  await page.locator('[data-route="circuito"]').click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'buseta');
  // Back on the BRT route the default applies again; a bus picked there stays while moving between BRT routes.
  await placard.click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'articulado');
  await page.locator('[data-bus="popular"]').click();
  await page.locator('[data-route="linea-e1"]').click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'popular');
  await page.screenshot({ path: `${shots}/85-menu-brt.png`, fullPage: true });
});

test('the Trolebús shift from the menu: articulated bus on the busway, guidance arrow, drives', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-route="linea-e3"]').click();
  await expect(page.locator('[data-bus][aria-checked="true"]')).toHaveAttribute('data-bus', 'articulado');
  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  // The tutorial card opens first (BRT line included); close it.
  await expect(page.locator('.tut')).toContainText('carril exclusivo');
  await page.keyboard.press('Escape');
  const info = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { id: q.bus.preset.id, route: q.route.id, system: q.route.system };
  });
  expect(info).toEqual({ id: 'articulado', route: 'linea-e3', system: 'ecovia' });
  // Guidance exists and runs along busway lanes (the lane graph's access class).
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__qbus.session.path), { timeout: 20_000 })
    .toBe(true);
  const onBusway = await page.evaluate(() => {
    const { session } = (window as any).__qbus;
    return session.path.edges.filter((id: number) => session.d.graph.edges[id].access === 'brt').length / session.path.edges.length;
  });
  expect(onBusway).toBeGreaterThan(0.5);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 90_000 }).toBeGreaterThan(5);
  await page.screenshot({ path: `${shots}/86-brt-shift.png` });
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});
