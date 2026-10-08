import { test, expect, type Page } from '@playwright/test';

const shots = 'e2e/screenshots';
const radio = (page: Page) =>
  page.evaluate(() => {
    const r = (window as any).__qbus.radio;
    return { station: r.station as string, playing: r.playing as boolean, loaded: [...r.loaded].sort() as string[], song: (r.nowPlaying?.title ?? null) as string | null };
  });

test('the radio tunes every station, downloading each song only when needed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const songs: string[] = [];
  page.on('requestfinished', async (req) => {
    if (req.url().includes('/music/') && (await req.response())?.ok()) songs.push(req.url().split('/').pop()!);
  });
  // Saved settings: the radio starts on La Buseta (chicha).
  await page.addInitScript(() => localStorage.setItem('qbus', JSON.stringify({ radio: 'chicha', musicVolume: 0.5, v: 2 })));
  await page.goto('/?tutorial=0&city=grid');
  await page.waitForFunction(() => (window as any).__qbus);
  // Nothing plays (or downloads) before the first gesture starts the audio.
  expect((await radio(page)).playing).toBe(false);
  expect(songs).toEqual([]);

  await page.keyboard.press('KeyW');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 20_000 }).toBe(true);
  // Each station starts early in its first song: only that one is downloaded.
  expect(await radio(page)).toMatchObject({ station: 'chicha', loaded: ['chicha.mp3'], song: 'Cumbia del Trole Perdido' });

  // M: next on the dial. The card names the station and the song.
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'reggaeton', playing: true });
  await expect(page.locator('.radio-toast.on')).toContainText('Perreo FM');
  await expect(page.locator('.radio-toast.on')).toContainText('Perreo en la Ecovía');
  await page.screenshot({ path: `${shots}/90-radio.png` });
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page)).toMatchObject({ station: 'off', playing: false });
  await expect(page.locator('.radio-toast.on')).toContainText('Apagado');
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'sanjuanito', playing: true, loaded: ['chicha.mp3', 'reggaeton.mp3', 'sanjuanito.mp3'] });
  // Back on a station heard before: no second download.
  await page.keyboard.press('KeyM');
  await expect.poll(async () => radio(page), { timeout: 20_000 }).toMatchObject({ station: 'chicha', playing: true });
  expect(songs.sort()).toEqual(['chicha.mp3', 'reggaeton.mp3', 'sanjuanito.mp3']);

  // The last station tuned is the next game's.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('qbus')!).radio)).toBe('chicha');

  // Jump the broadcast to twenty seconds before the end of the song: the station's next song is
  // fetched, follows on by itself, and a small card names it.
  await page.evaluate(() => {
    const r = (window as any).__qbus.radio;
    r.skew += r.onAir().remaining - 20;
    r.tune(r.station);
  });
  await expect.poll(async () => (await radio(page)).song, { timeout: 20_000 }).toBe('Cumbia del Trole Perdido');
  await expect.poll(async () => (await radio(page)).song, { timeout: 40_000 }).toBe('La Psicodélica del Playón');
  await expect(page.locator('.radio-toast.on.song')).toContainText('La Psicodélica del Playón');
  expect(await radio(page)).toMatchObject({ station: 'chicha', playing: true });
  expect(songs.filter((s) => s === 'chicha2.mp3')).toEqual(['chicha2.mp3']);
  expect(errors).toEqual([]);
});
