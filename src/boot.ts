import { Menu } from './menu/menu';
import { loadSettings } from './menu/settings';
import { loadCity } from './world/loadCity';

/**
 * Entry point. The menu is light (no three.js or Rapier): the game (`main.ts`, with the
 * engine) is its own chunk, fetched in parallel with the city data when a shift starts, and
 * prefetched while the player is still in the menu.
 */
const params = new URLSearchParams(location.search);
// Without a shift to play (?play=1 from the menu, or ?city= / ?seed= directly), show the menu.
if (!params.has('play') && !params.has('city') && !params.has('seed')) {
  new Menu(document.body);
  // Warm the cache with the game while the player picks: a shift then starts from cache.
  setTimeout(() => void import('./main').catch(() => {}), 1500);
} else {
  const settings = loadSettings();
  if (!params.has('hills')) params.set('hills', String(settings.hills));
  const city = loadCity(params);
  void import('./main').then(({ main }) => main(params, city));
}
