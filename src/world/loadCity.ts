import type { CityData } from './cityData';
import { generateCity } from './procCity';
import { circuitTrack } from './circuitTrack';

/** Imported zones, loaded on demand so each stays its own chunk. */
const ZONES: Record<string, () => Promise<{ default: unknown }>> = {
  mariscal: () => import('../../data/cities/mariscal.json'),
  // A street circuit (`city.circuits`) of Mariscal, raced as its own zone: see `loadCity`.
  zonarosa: () => import('../../data/cities/mariscal.json'),
  papallacta: () => import('../../data/cities/papallacta.json'),
  silante: () => import('../../data/cities/silante.json'),
  rioverde: () => import('../../data/cities/rioverde.json'),
};

/** Zones shown in the menu. */
export const ZONE_LIST = [
  { id: 'mariscal', name: 'La Mariscal', blurb: 'Calles reales de Quito, con sus cuestas y sus una-vía' },
  { id: 'grid', name: 'Ciudad de prueba', blurb: 'Cuadrícula plana con rampas, para practicar' },
];

/** Race tracks shown in the menu (zones with `city.race`). */
export const TRACK_LIST = [
  { id: 'papallacta', name: 'Paso de la Muerte', blurb: 'Vía Interoceánica, de Papallacta a Cuyuja: barrancos, neblina y curvas cerradas' },
  { id: 'silante', name: 'Bajada del Silante', blurb: 'Vía Alóag–Santo Domingo: bosque nublado, quebradas profundas, derrumbes y curvas sin fin hasta el río' },
  { id: 'rioverde', name: 'Bajada de Río Verde', blurb: 'Ruta de las Cascadas (Baños–Puyo): cañón del Pastaza, cuatro túneles de roca, cascadas y precipicios' },
  { id: 'zonarosa', name: 'Circuito Zona Rosa', blurb: 'La Mariscal cerrada: tres vueltas por Amazonas, la Foch y la Reina Victoria entre barreras y público' },
];

/** Zones that are a circuit of another zone's city (race only): their id is the circuit's, the city is `of`'s. */
export const CIRCUIT_ZONES: Record<string, { of: string }> = { zonarosa: { of: 'mariscal' } };

/** The circuit cities built so far (a shallow copy of the zone's city with `race`), by zone id. */
const circuitCities = new Map<string, CityData>();

export const DEFAULT_ZONE = 'mariscal';
/** True to life (the menu also offers 1.3, "un poquito más", and 2, "Quito extremo"). */
export const DEFAULT_HILLS = 1;

/**
 * Picks the city from the URL: `?city=mariscal` (default), `?city=grid` or `?seed=N` for the
 * generated test city. `?hills=N` scales real elevation (1 = true to life).
 * A circuit zone (`?city=zonarosa`) is its city with the circuit as `race` (a copy: the cached city is never
 * touched, terrain included), at true-to-life hills, but only for a race (`mode=race|online`, or the menu's
 * `loadZone`): free roam and route shifts there get the plain city.
 */
export async function loadCity(params: URLSearchParams): Promise<CityData> {
  let zone = params.get('city') ?? (params.has('seed') ? 'grid' : DEFAULT_ZONE);
  const circuit = CIRCUIT_ZONES[zone];
  if (circuit) {
    const mode = params.get('mode');
    if (mode === 'race' || mode === 'online') return circuitCity(zone);
    zone = circuit.of;
  }
  if (zone === 'grid' || !ZONES[zone]) return generateCity({ seed: Number(params.get('seed') ?? 42) });
  const city = (await ZONES[zone]()).default as CityData;
  // A race track's mountains are true to life: its road and cuts are graded for them.
  if (city.terrain) city.terrain.scale = city.race ? 1 : Number(params.get('hills') ?? DEFAULT_HILLS);
  return city;
}

async function circuitCity(zone: string): Promise<CityData> {
  let city = circuitCities.get(zone);
  if (!city) {
    const base = (await ZONES[zone]()).default as CityData;
    const c = base.circuits?.find((k) => k.id === zone);
    if (!c) throw new Error(`no circuit ${zone}`);
    // Its own terrain object: the cached zone's scale follows the hills setting.
    const flat = { ...base, terrain: base.terrain && { ...base.terrain, scale: 1 } };
    city = { ...flat, race: circuitTrack(flat, c) };
    circuitCities.set(zone, city);
  }
  return city;
}

/** City for a menu zone id, without touching the URL (a circuit zone comes with its race). */
export function loadZone(zone: string, hills = DEFAULT_HILLS): Promise<CityData> {
  return loadCity(new URLSearchParams({ city: zone, hills: String(hills), ...(CIRCUIT_ZONES[zone] ? { mode: 'race' } : {}) }));
}
