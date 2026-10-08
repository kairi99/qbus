import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';

test('menu: choose bus, zone and route, play, pause, back to menu', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Jugar' })).toBeVisible();
  await page.screenshot({ path: `${shots}/60-title.png` });

  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 }); // La Mariscal routes loaded
  await page.screenshot({ path: `${shots}/61-setup-mariscal.png`, fullPage: true });

  await page.locator('[data-bus="buseta"]').click();
  await page.locator('[data-zone="grid"]').click();
  await expect(page.locator('[data-route="ruta-amazonas"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-route="ruta-amazonas"]').click();
  await expect(page.locator('.mn-summary')).toHaveText('Buseta, Ciudad de prueba, Ruta Amazonas');
  await page.screenshot({ path: `${shots}/62-setup-choice.png`, fullPage: true });

  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const game = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { bus: q.bus.preset.id, route: q.route.id, city: q.city.name, stop: q.session.game.activeStop.stop.name };
  });
  expect(game.bus).toBe('buseta');
  expect(game.route).toBe('ruta-amazonas');
  expect(game.stop).toMatch(/Amazonas/);
  await page.waitForTimeout(1500);
  await expect(page.locator('.gh-minimap')).toBeVisible();
  // The GPS path to the first stop exists and follows the lane graph.
  const path = await page.evaluate(() => (window as any).__qbus.session.path?.points.length ?? 0);
  expect(path).toBeGreaterThan(1);
  await page.screenshot({ path: `${shots}/63-playing-choice.png` });

  // Pause freezes the clock.
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.session.game.timeLeft), { timeout: 20_000 }).toBeLessThan(89.5);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Seguir/ })).toBeVisible();
  const t0 = await page.evaluate(() => (window as any).__qbus.session.game.timeLeft);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__qbus.session.game.timeLeft)).toBe(t0);
  await page.screenshot({ path: `${shots}/64-pause.png` });

  // Choices were remembered for next time.
  await page.getByRole('button', { name: 'Volver al menú' }).click();
  await expect(page.getByRole('button', { name: 'Jugar' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-bus="buseta"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-route="ruta-amazonas"]')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('settings are saved and applied', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByText('Conductor').click();
  await page.getByText('Quito extremo').click();
  await page.getByText('Noche').click();
  await page.screenshot({ path: `${shots}/65-settings.png` });
  await page.goto('/?play=1&city=mariscal');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const s = await page.evaluate(() => ({ cam: (window as any).__qbus.rig.mode, hills: (window as any).__qbus.city.terrain.scale, tod: (window as any).__qbus.timeOfDay }));
  expect(s).toEqual({ cam: 'cockpit', hills: 2, tod: 'night' });
});

test('free roam: pick the AE86, drive around with no route, clock or fares', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  // The AE86 is only offered in free roam.
  await expect(page.locator('[data-bus="ae86"]')).toHaveCount(0);
  await page.locator('[data-mode="free"]').click();
  await expect(page.locator('.mn-step-route')).toBeHidden();
  await page.locator('[data-bus="ae86"]').click();
  await expect(page.locator('.mn-summary')).toHaveText('Toyoya Sprinta Trueno AE86, La Mariscal, Paseo libre');
  await page.screenshot({ path: `${shots}/66-setup-free.png`, fullPage: true });

  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const state = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { bus: q.bus.preset.id, route: q.route, game: q.session.game };
  });
  expect(state).toEqual({ bus: 'ae86', route: null, game: null });
  await expect(page.locator('.gh-timer')).toBeHidden();
  await expect(page.locator('.gh-money')).toBeHidden();
  await expect(page.locator('.gh-minimap')).toBeVisible();

  await page.keyboard.down('KeyW');
  // Software WebGL runs the sim slower than real time: give it time rather than a fixed pace.
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 45_000 }).toBeGreaterThan(8);
  await page.screenshot({ path: `${shots}/67-free-ae86.png` });
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/68-free-ae86-cockpit.png` });
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('the route picker shows saved records and missions', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    const shift = (cents: number, stars: number) => ({ cents, delivered: 6, bestCombo: 4, stars, bus: 'popular', date: Date.now() });
    const routes = { 'mariscal/circuito': { top: [shift(600, 2), shift(120, 1)], stars: 2 } };
    localStorage.setItem('qbus.records', JSON.stringify({ v: 2, routes, missions: { nitro: 3, combo: 1 } }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  // Stars are the best money rated against the route's targets, shown on every placard.
  await expect(page.locator('[data-route="circuito"] .mn-placard-best')).toHaveText(/^[★☆]{3} \$6\.00$/, { timeout: 30_000 });
  await expect(page.locator('.mn-placard-best')).toHaveCount(1);
  await expect(page.locator('[data-route="circuito"] .mn-placard-goal')).toHaveText(/^★ \$\d+\.\d\d · ★★ \$\d+\.\d\d · ★★★ \$\d+\.\d\d$/);
  await expect(page.locator('[data-route="circuito"] .mn-placard-best .mn-stars')).toHaveText('★★☆');
  await expect(page.locator('.mn-missions-done')).toHaveText(/Misiones cumplidas: 2 de \d+/);
  await page.locator('.mn-step-route').screenshot({ path: `${shots}/69-setup-records.png` });
});

test('menu sounds: hover ticks, bus-flavored confirms, slider preview, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const played = () => page.evaluate(() => [...(window as any).__qbusMenu.sounds.played]);
  await page.getByRole('button', { name: 'Ajustes' }).hover();
  await page.getByRole('button', { name: 'Créditos' }).hover();
  await expect.poll(played).toContain('hover');
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByText('Noche').click();
  await page.locator('input[name="volume"]').fill('40');
  await page.getByRole('button', { name: 'Volver' }).click();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await page.locator('[data-zone="grid"]').click();
  await page.locator('[data-route="ruta-amazonas"]').click({ timeout: 30_000 });
  const s = await played();
  for (const k of ['confirm', 'toggle', 'slider', 'back', 'select', 'route']) expect(s).toContain(k);
  // The audio context is running after the clicks (headless Chrome has Web Audio too).
  expect(await page.evaluate(() => (window as any).__qbusMenu.sounds.ctx?.state)).toBe('running');
  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  expect(errors).toEqual([]);
});
