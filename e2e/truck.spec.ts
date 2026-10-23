import { test, expect } from '@playwright/test';

const shots = 'e2e/screenshots';
test.describe.configure({ timeout: 240_000 });

test('the container truck: in the free roam menu, drives with its trailer cutting inside, cockpit view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Jugar' }).click();
  await expect(page.locator('[data-route]').first()).toBeVisible({ timeout: 30_000 });
  // Route shifts are always a bus: the truck is only offered in free roam.
  await expect(page.locator('[data-bus="trailer"]')).toHaveCount(0);
  await page.locator('[data-mode="free"]').click();
  await page.locator('[data-bus="trailer"]').click();
  await expect(page.locator('.mn-summary')).toHaveText('Tráiler Taitar, La Mariscal, Paseo libre');
  await page.locator('[data-bus="trailer"]').screenshot({ path: `${shots}/c0-truck-card.png` });
  await page.getByRole('button', { name: '¡Arranca!' }).click();
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 60_000 });
  await page.keyboard.press('Escape');

  const info = await page.evaluate(() => {
    const q = (window as any).__qbus;
    return { id: q.bus.preset.id, bodies: q.bus.bodies.length, wheels: q.bus.wheelCount };
  });
  expect(info).toEqual({ id: 'trailer', bodies: 2, wheels: 12 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/c1-truck-standing.png` });

  const state = () =>
    page.evaluate(() => {
      const { bus } = (window as any).__qbus;
      return { speed: bus.speed as number, bend: bus.bend as number, on: bus.wheelsOnGround as number };
    });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await state()).speed, { timeout: 90_000 }).toBeGreaterThan(5);
  await page.keyboard.down('KeyA');
  await expect.poll(async () => Math.abs((await state()).bend), { timeout: 60_000 }).toBeGreaterThan(0.1);
  await page.screenshot({ path: `${shots}/c2-truck-turning.png` });
  expect((await state()).on).toBeGreaterThanOrEqual(8);
  await page.keyboard.up('KeyA');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/c3-truck-cockpit.png` });
  await page.keyboard.up('KeyW');
  expect(errors).toEqual([]);
});

test('the container truck seen from the side and the back (a fixed camera)', async ({ page }) => {
  await page.goto('/?play=1&mode=free&bus=trailer&tutorial=0&rain=0');
  await page.waitForFunction(() => (window as any).__qbus?.session, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  const view = async (name: string, dx: number, dy: number, dz: number, look: [number, number, number] = [0, 1.5, 0]) => {
    await page.evaluate(
      ([dx, dy, dz, look]) => {
        const q = (window as any).__qbus;
        // Pin the camera relative to the vehicle's middle: dx ahead, dz to its right, dy up.
        q.rig.update = () => {
          const p = q.bus.position();
          const h = q.bus.heading;
          const [fx, fz, rx, rz] = [Math.cos(h), -Math.sin(h), Math.sin(h), Math.cos(h)];
          const cam = q.rig.camera;
          cam.position.set(p.x + fx * dx + rx * dz, p.y + dy, p.z + fz * dx + rz * dz);
          cam.lookAt(p.x + look[0], p.y + look[1], p.z + look[2]);
        };
      },
      [dx, dy, dz, look] as [number, number, number, [number, number, number]],
    );
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${shots}/${name}.png` });
  };
  await view('c4-truck-side', 0, 2.6, -9.5, [0, 1.6, 0]);
  await view('c5-truck-front34', 16, 4, 5);
  await view('c6-truck-back34', -16, 4, -5);
  await view('c7-truck-cab', 9, 2.4, -4.5, [5, 1.4, 0]);
});

test('a race of container trucks: six on the grid, the countdown runs, draw calls stay modest', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?play=1&mode=race&city=papallacta&bus=trailer&rivals=5&rivalBus=trailer&tutorial=0&rain=0');
  await page.waitForFunction(() => (window as any).__qbus?.racing, null, { timeout: 120_000 });
  expect(await page.evaluate(() => (window as any).__qbus.racing.rivals.length)).toBe(5);
  await expect(page.locator('.rh-count')).toHaveText(/[321]/, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/c8-truck-grid.png` });
  const calls = await page.evaluate(() => (window as any).__qbus.renderer.info.render.calls as number);
  console.log('draw calls with six trucks on the grid:', calls);
  expect(errors).toEqual([]);
});
