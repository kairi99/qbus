import type { CityData } from './cityData';
import { generateCity } from './procCity';

/** Imported zones, loaded on demand so each stays its own chunk. */
const ZONES: Record<string, () => Promise<{ default: unknown }>> = {
  mariscal: () => import('../../data/cities/mariscal.json'),
};

export const DEFAULT_ZONE = 'mariscal';
/** Mild exaggeration: the steepest street (Francisco Salazar, 14% for real) becomes ~19%. */
export const DEFAULT_HILLS = 1.3;

/**
 * Picks the city from the URL: `?city=mariscal` (default), `?city=grid` or `?seed=N` for the
 * generated test city. `?hills=N` scales real elevation (1 = true to life).
 */
export async function loadCity(params: URLSearchParams): Promise<CityData> {
  const zone = params.get('city') ?? (params.has('seed') ? 'grid' : DEFAULT_ZONE);
  if (zone === 'grid' || !ZONES[zone]) return generateCity({ seed: Number(params.get('seed') ?? 42) });
  const city = (await ZONES[zone]()).default as CityData;
  if (city.terrain) city.terrain.scale = Number(params.get('hills') ?? DEFAULT_HILLS);
  return city;
}
