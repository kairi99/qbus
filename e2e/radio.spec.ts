import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const radio = (page: Page) =>
  page.evaluate(() => {
    const r = (window as any).__qbus.radio;
    return { station: r.station as string, playing: r.playing as boolean, loaded: [...r.loaded].sort() as string[] };
  });

test('the radio tunes every station, downloading each song only when tuned', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const songs: string[] = [];
  page.on('requestfinished', async (req) => {
    if (req.url().includes('/music/') && (await req.response())?.ok()) songs.push(req.url().split('/').pop()!);
  });
  // Saved settings: the radio starts on La Buseta (chicha).
  await page.addInitScript(() => localStorage.setItem('qbus', JSON.stringify({ radio: 'chicha', musicVolume: 0.5, v: 2 })));
  await page.goto('/?city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  // Nothing plays (or downloads) before the first gesture starts the audio.
  expect((await radio(page)).playing).toBe(false);
  expect(songs).toEqual([]);

  await page.keyboard.press('KeyW');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 20_000 }).toBe(true);
  expect(await radio(page)).toMatchObject({ station: 'chicha', loaded: ['chicha'] });

  // M: next on the dial. The card names the station.
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'reggaeton', playing: true });
  await expect(page.locator('.radio-toast.on')).toContainText('Perreo FM');
  await page.screenshot({ path: `${shots}/90-radio.png` });
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page)).toMatchObject({ station: 'off', playing: false });
  await expect(page.locator('.radio-toast.on')).toContainText('Apagado');
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'sanjuanito', playing: true, loaded: ['chicha', 'reggaeton', 'sanjuanito'] });
  // Back on a station heard before: no second download.
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'chicha', playing: true });
  expect(songs.sort()).toEqual(['chicha.mp3', 'reggaeton.mp3', 'sanjuanito.mp3']);

  // The last station tuned is the next game's.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qbus')!).radio)).toBe('chicha');
  expect(errors).toEqual([]);
});
