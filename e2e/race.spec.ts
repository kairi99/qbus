import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 300_000 });

test('a race on the Papallacta track: countdown, a perfect launch, a rival, the finish and results', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=race&city=papallacta&tutorial=0&rain=0&rivals=1');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 90_000 });
  // The throttle moves the needle on the grid (the launch's input; its grading is unit-tested).
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.launch.rpm), { timeout: 30_000 }).toBeGreaterThan(0.4);
  // Then the needle is held in the green window from inside the page, every frame, until GO
  // (a few frames a second here: feathering by key events can't hold a window that small).
  await page.evaluate(() => {
    const q = (window as any).__qbus;
    const tick = () => {
      if (q.racing.game.green) return;
      q.racing.launch.rpm = 0.66;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await expect(page.locator('.rh-count')).toHaveText(/[321]/, { timeout: 30_000 });
  await page.screenshot({ path: `${shots}/b0-race-countdown.png` });
  // Held on the brakes during the countdown.
  expect(await page.evaluate(() => Math.abs((window as any).__qbus.bus.speed))).toBeLessThan(0.5);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.game.green), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__qbus.racing.grade)).toBe('perfect');
  await page.screenshot({ path: `${shots}/b1-race-go.png` });
  // Both buses get going.
  await expect
    .poll(() => page.evaluate(() => { const q = (window as any).__qbus; return Math.min(q.bus.speed, q.racing.rivals[0].bus.speed); }), { timeout: 60_000 })
    .toBeGreaterThan(5);
  await expect(page.locator('.rh-place')).toContainText('/ 2');
  await page.screenshot({ path: `${shots}/b2-race-running.png` });
  // Close to the finish: drive over the line, the results come up with the track's record.
  await page.evaluate(() => {
    const q = (window as any).__qbus;
    const r = q.city.race;
    const i = Math.round((r.finish - 60) / 3);
    const [a, b] = [r.points[i], r.points[i + 1]];
    q.bus.reset({ x: a.x, y: r.y[i], z: a.z, heading: Math.atan2(-(b.z - a.z), b.x - a.x) });
  });
  // Over the line: the trackside camera first, then the results.
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.finishView !== null), { timeout: 90_000 }).toBe(true);
  expect(await page.locator('.rh-results').isVisible()).toBe(false);
  await page.screenshot({ path: `${shots}/b3-race-finish-cam.png` });
  await expect(page.locator('.rh-results')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.rh-results')).toContainText(/GANASTE|Llegaste/);
  await expect(page.locator('.rh-results')).toContainText('Récord');
  await page.screenshot({ path: `${shots}/b4-race-results.png` });
  // Another race: back on the grid, counting down again.
  await page.locator('.rh-results [data-act="again"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.game.phase), { timeout: 30_000 }).not.toBe('over');
  await expect(page.locator('.rh-results')).toBeHidden();
  expect(errors).toEqual([]);
});

test('R in a race puts the bus back on the road and holds it there a few seconds', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=race&city=papallacta&tutorial=0&rain=0&rivals=1');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 90_000 });
  // On the grid R does nothing (it would only lose the slot).
  await page.keyboard.press('KeyR');
  expect(await page.evaluate(() => (window as any).__qbus.racing.wait)).toBe(0);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.racing.game.green), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 60_000 }).toBeGreaterThan(4);
  await page.keyboard.press('KeyR');
  await expect(page.locator('.rh-wait')).toBeVisible();
  await expect(page.locator('.rh-wait b')).toHaveText(/[123]/);
  await page.screenshot({ path: `${shots}/b4-race-reset-wait.png` });
  // Put back on the road, it is a ghost (see-through, passes through the others) for a while.
  expect(await page.evaluate(() => (window as any).__qbus.bus.ghost)).toBe(true);
  expect(await page.evaluate(() => (window as any).__qbus.racing.ghostFade)).toBeLessThan(1);
  await page.screenshot({ path: `${shots}/race-ghost.png` });
  // Throttle held all along: the bus stays put until the wait is over, then drives on.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => Math.abs((window as any).__qbus.bus.speed))).toBeLessThan(1);
  await expect(page.locator('.rh-wait')).toBeHidden({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.speed), { timeout: 60_000 }).toBeGreaterThan(3);
  // ...and solid again once the ghost time is up.
  await expect.poll(() => page.evaluate(() => (window as any).__qbus.bus.ghost), { timeout: 60_000 }).toBe(false);
  expect(await page.evaluate(() => (window as any).__qbus.racing.ghostFade)).toBe(1);
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('a race on the Silante track: the grid, the countdown and the cloud-forest road', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=race&city=silante&tutorial=0&rain=0&rivals=1');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 90_000 });
  await expect(page.locator('.rh-count')).toHaveText(/[321]/, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__qbus.city.race.to)).toBe('Río Silante');
  await expect(page.locator('.rh-place')).toContainText('/ 2');
  await page.screenshot({ path: `${shots}/b9-silante-grid.png` });
  expect(errors).toEqual([]);
});

test('a race with five rivals: six on the grid, the countdown runs, nobody starts early', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=race&city=papallacta&tutorial=0&rain=0&rivals=9&rivalBus=gusanito');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 90_000 });
  await expect(page.locator('.rh-count')).toHaveText(/[321]/, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).__qbus.racing.rivals.length)).toBe(5);
  await expect(page.locator('.rh-place')).toContainText('/ 6');
  await page.screenshot({ path: `${shots}/b10-six-on-the-grid.png` });
  expect(errors).toEqual([]);
});
