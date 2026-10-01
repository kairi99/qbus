import type { CityData } from './cityData';
import { generateCity } from './procCity';

/** Imported zones, loaded on demand so each stays its own chunk. */
const ZONES: Record<string, () => Promise<{ default: unknown }>> = {
  mariscal: () => import('../../data/cities/mariscal.json'),
};

/** Zones shown in the menu. */
export const ZONE_LIST = [
  { id: 'mariscal', name: 'La Mariscal', blurb: 'Calles reales de Quito, con sus cuestas y sus una-vía' },
  { id: 'grid', name: 'Ciudad de prueba', blurb: 'Cuadrícula plana con rampas, para practicar' },
];

export const DEFAULT_ZONE = 'mariscal';
/** True to life (the menu also offers 1.3, "un poquito más", and 2, "Quito extremo"). */
export const DEFAULT_HILLS = 1;

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

/** City for a menu zone id, without touching the URL. */
export function loadZone(zone: string, hills = DEFAULT_HILLS): Promise<CityData> {
  return loadCity(new URLSearchParams({ city: zone, hills: String(hills) }));
}
