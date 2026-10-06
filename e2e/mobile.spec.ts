import { test, expect, type Locator, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
// A phone held sideways.
test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

const bus = (page: Page) =>
  page.evaluate(() => {
    const { bus } = (window as any).__qbus;
    return { speed: bus.speed as number, heading: bus.heading as number };
  });

/** A finger on `target` (pointer events, like a real touch); returns a function to lift it. */
async function press(target: Locator, id: number, dx = 0): Promise<() => Promise<void>> {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const ev = { pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true };
  await target.dispatchEvent('pointerdown', { ...ev, clientX: x, clientY: y });
  if (dx) await target.dispatchEvent('pointermove', { ...ev, clientX: x + dx, clientY: y });
  return () => target.dispatchEvent('pointerup', { ...ev, clientX: x + dx, clientY: y });
}

test('drives on a phone with the touch controls', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?city=mariscal&play=1&mode=free');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await expect(page.locator('.tc-gas')).toBeVisible();
  await expect(page.locator('.hud-help')).toBeHidden();
  await page.screenshot({ path: `${shots}/80-phone-start.png` });

  const liftGas = await press(page.locator('.tc-gas'), 2);
  await expect.poll(async () => (await bus(page)).speed, { timeout: 30_000 }).toBeGreaterThan(5);
  // Steer right with the other thumb while still on the gas.
  const before = (await bus(page)).heading;
  const liftSteer = await press(page.locator('.tc-steer'), 1, 70);
  await expect.poll(async () => Math.abs((await bus(page)).heading - before), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await page.screenshot({ path: `${shots}/81-phone-driving.png` });
  await liftSteer();
  await liftGas();
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.input.touch.gas)).toBe(false);

  // Pause from its button; the pause screen covers the pedals.
  await press(page.locator('[data-tap="pause"]'), 3).then((lift) => lift());
  await expect(page.locator('[data-act="resume"]')).toBeVisible();
  await page.screenshot({ path: `${shots}/82-phone-paused.png` });
  expect(errors).toEqual([]);
});

test('asks to turn the phone sideways when held upright', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?city=grid&play=1&mode=free');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await expect(page.locator('.tc-rotate')).toBeVisible();
});

test('the menu fits a phone', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: `${shots}/83-phone-menu.png`, fullPage: true });
  await page.getByRole('button', { name: 'Jugar' }).click();
  await page.screenshot({ path: `${shots}/85-phone-setup.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/84-phone-menu-upright.png`, fullPage: true });
});

test('a route shift on a phone', async ({ page }) => {
  // Loads La Mariscal, then plays out a shift: slow with software WebGL.
  test.setTimeout(180_000);
  await page.goto('/?city=mariscal&play=1');
  await page.waitForFunction(() => (window as any).__qbus?.session?.game, null, { timeout: 60_000 });
  await expect(page.locator('.tc-gas')).toBeVisible();
  await expect(page.locator('.gh-missions li')).toHaveCount(3);
  await expect(page.locator('.gh-targets')).toBeVisible();
  await page.screenshot({ path: `${shots}/86-phone-route.png` });

  // A mission done, then the end of the shift: the toast and results fit the small screen.
  await page.evaluate(() => {
    const { session } = (window as any).__qbus;
    session.start();
    const m = session.missions.list[0];
    m.done = false;
    m.progress = m.def.goal - 1e-6;
    const events = [{ type: 'nitro' }, { type: 'fare', rating: 'fast' }, { type: 'arrive', rating: 'fast' }, { type: 'trick', kind: 'drift', cents: 100, duration: 3, chain: 5 }];
    for (const k of ['nearMiss', 'knock', 'speed']) events.push({ type: 'trick', kind: k, cents: 100, chain: 5 } as any);
    for (const e of events) if (!m.done) session.mission(e);
  });
  await expect(page.locator('.gh-toast.on')).toBeVisible();
  // Money past the first target: the star meter beside the money fills one star.
  await page.evaluate(() => {
    const { session } = (window as any).__qbus;
    session.game.addCents(session.stars[0]);
  });
  await expect(page.locator('.gh-goal b')).toHaveText(/^★+$/);
  await page.screenshot({ path: `${shots}/87-phone-mission.png` });
  await page.evaluate(() => ((window as any).__qbus.session.game.timeLeft = 0.2));
  await expect(page.locator('[data-k="results"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-act="again"]').first()).toBeInViewport();
  await page.screenshot({ path: `${shots}/88-phone-results.png` });
});
