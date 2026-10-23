import { expect, test } from '@playwright/test';

const shots = 'e2e/screenshots';

test('two players meet in an online lobby', async ({ browser }) => {
  const errors: string[] = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/?tutorial=0');
    await page.getByRole('button', { name: 'En línea' }).click();
    return { ctx, page };
  };
  const a = await open();
  const b = await open();

  // A creates a room.
  await a.page.screenshot({ path: `${shots}/online-menu.png` });
  await a.page.locator('input[name="name"]').fill('Ana');
  await a.page.getByRole('button', { name: 'Crear sala' }).click();
  const codeEl = a.page.locator('[data-room-code]');
  await expect(codeEl).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  const code = (await codeEl.textContent())!;
  await expect(a.page.locator('.mn-seat')).toHaveCount(6);

  // B joins by code (a wrong one first).
  await b.page.locator('input[name="name"]').fill('Beto');
  await b.page.locator('input[name="code"]').fill('zzzz');
  await b.page.getByRole('button', { name: 'Unirse' }).click();
  await expect(b.page.locator('.mn-note')).toHaveText('No existe esa sala');
  await b.page.locator('input[name="code"]').fill(code.toLowerCase());
  await b.page.getByRole('button', { name: 'Unirse' }).click();
  await expect(b.page.locator('[data-room-code]')).toHaveText(code);

  for (const p of [a.page, b.page]) {
    await expect(p.locator('.mn-seat[data-seat]')).toHaveCount(2);
    await expect(p.locator('.mn-seat[data-seat]').filter({ hasText: 'Ana' })).toContainText('Anfitrión');
    await expect(p.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toBeVisible();
  }
  await expect(b.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('(tú)');

  // The host's options reach the guest.
  await a.page.locator('input[name="ai"][value="1"]').check();
  await expect(b.page.locator('.mn-box-ai')).toContainText('Cuántos1');
  await expect(b.page.locator('.mn-seat-empty').first()).toHaveText('IA');
  await expect(a.page.locator('.mn-seat-empty').nth(1)).toHaveText('Libre');

  // Ready gates the start.
  const start = a.page.getByRole('button', { name: '¡Arrancar!' });
  await expect(start).toBeDisabled();
  await b.page.getByRole('button', { name: '¡Listo!' }).click();
  await expect(start).toBeEnabled();
  await expect(a.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('Listo');
  await a.page.screenshot({ path: `${shots}/online-lobby-host.png`, fullPage: true });
  await b.page.screenshot({ path: `${shots}/online-lobby-guest.png`, fullPage: true });
  await a.page.setViewportSize({ width: 390, height: 780 });
  await a.page.screenshot({ path: `${shots}/online-lobby-host-phone.png`, fullPage: true });
  await a.page.setViewportSize({ width: 1280, height: 720 });

  // B, already ready, picks another vehicle: the room (and the host's seat list) show it, and it stays picked.
  const pickB = b.page.locator('select[name="vehicle"]');
  const other = await pickB.evaluate((el: HTMLSelectElement) => [...el.options].find((o) => o.value !== el.value)!.value);
  const otherName = await pickB.evaluate((el: HTMLSelectElement, v) => [...el.options].find((o) => o.value === v)!.text, other);
  await pickB.selectOption(other);
  await expect(a.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' }).locator('.mn-seat-bus')).toHaveText(otherName);
  await expect(b.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('Listo');
  await expect(pickB).toHaveValue(other);

  // B reloads the page: back in the same room, same seat (still ready), the host unchanged.
  await b.page.reload();
  await expect(b.page.locator('[data-room-code]')).toHaveText(code, { timeout: 20_000 });
  await expect(b.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('(tú)');
  await expect(b.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('Listo');
  await expect(a.page.locator('.mn-seat[data-seat]')).toHaveCount(2);
  await expect(a.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Ana' })).toContainText('Anfitrión');
  await expect(start).toBeEnabled();

  // B closes the tab and opens the link again (a new tab: no sessionStorage): "Volver a la sala" takes the seat back.
  const b2 = await b.ctx.newPage();
  b2.on('pageerror', (e) => errors.push(e.message));
  await b.page.close();
  await b2.goto('/?tutorial=0');
  await b2.getByRole('button', { name: 'En línea' }).click();
  await expect(a.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('Desconectado');
  await b2.getByRole('button', { name: `Volver a la sala ${code}` }).click();
  await expect(b2.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('(tú)');
  await expect(a.page.locator('.mn-seat[data-seat]')).toHaveCount(2);
  await expect(a.page.locator('.mn-seat[data-seat]').filter({ hasText: 'Beto' })).toContainText('Listo');
  b.page = b2;

  // B leaves: A sees one seat.
  await b.page.getByRole('button', { name: 'Salir de la sala' }).click();
  await expect(b.page.locator('input[name="code"]')).toBeVisible();
  await expect(a.page.locator('.mn-seat[data-seat]')).toHaveCount(1);

  expect(errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
