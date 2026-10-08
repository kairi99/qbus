import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const open = (page: Page) => page.evaluate(() => (window as any).__qbus.tutorial.open as boolean);

test('a shift opens with the how-to-play card, and the clock waits for it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus?.session?.game, null, { timeout: 60_000 });
  const card = page.locator('.tut');
  await expect(card).toBeVisible();
  // The start prompt waits behind it; the card has the job, the stop speed and the star targets.
  await expect(page.locator('.gh-prompt')).toBeHidden();
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Tu turno, ñaño');
  // From routeGame's STOP_SPEED.
  await expect(card).toContainText('baja de 25 km/h');
  await expect(card.locator('.tut-stars')).toHaveText(/★ \$\d+\.\d\d · ★★ \$\d+\.\d\d · ★★★ \$\d+\.\d\d/);
  await expect(page.locator('[data-next]')).toBeFocused();
  await page.screenshot({ path: `${shots}/90-tutorial-route.png` });

  // Throttle while it's open: the bus stays put and the clock doesn't run.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  const held = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { time: q.session.game.timeLeft, speed: Math.abs(q.bus.speed) };
  });
  await page.keyboard.up('KeyW');
  expect(held.time).toBe(90);
  expect(held.speed).toBeLessThan(0.5);

  // Enter/Space/→ page through; ← goes back.
  await page.keyboard.press('Enter');
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Nitro y acrobacias');
  await expect(card).toContainText('derrapando');
  await page.keyboard.press('ArrowLeft');
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Tu turno, ñaño');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Los controles');
  // Keyboard keys on a desktop, the touch ones hidden.
  await expect(card.locator('.tut-keys.keys-only')).toBeVisible();
  await expect(card.locator('.tut-keys.touch-only')).toBeHidden();
  await expect(card.locator('.tut-keys.keys-only')).toContainText('Volver a la calle');
  await expect(page.locator('[data-next]')).toHaveText(/¡Dale!/);
  await page.screenshot({ path: `${shots}/91-tutorial-keys.png` });
  await page.locator('[data-next]').click();
  await expect(card).toBeHidden();
  expect(await open(page)).toBe(false);

  // Now the usual start: throttle starts the clock.
  await expect(page.locator('.gh-prompt')).toBeVisible();
  await page.keyboard.down('KeyW');
  await expect(page.locator('.gh-prompt')).toBeHidden({ timeout: 20_000 });
  await page.keyboard.up('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.session.game.timeLeft), { timeout: 20_000 }).toBeLessThan(90);
  // Restarting the shift doesn't bring the card back.
  await page.evaluate(() => (window as any).__qbus.session.restart());
  expect(await open(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('free roam opens with its own card; "No mostrar otra vez" turns it off', async ({ page }) => {
  await page.goto('/?city=grid&play=1&mode=free');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  const card = page.locator('.tut');
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Paseo libre');
  await expect(card).toContainText('no hay paradas, reloj ni pasajes');
  await expect(card).toContainText('derrapando');
  await page.screenshot({ path: `${shots}/92-tutorial-free.png` });
  await page.getByLabel('No mostrar otra vez').check();
  await page.keyboard.press('Enter');
  await expect(card.locator('.tut-page:not([hidden]) h2')).toHaveText('Los controles');
  await page.keyboard.press('Enter');
  await expect(card).toBeHidden();
  // Driving works right away.
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 20_000 }).toBeGreaterThan(2);
  await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qbus') ?? '{}').tutorial)).toBe(false);
  await page.reload();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  expect(await open(page)).toBe(false);
  await expect(card).toBeHidden();
});
