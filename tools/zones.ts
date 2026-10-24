import type { ZoneCircuit } from '../src/world/osm/circuit';
import type { TrackEnd } from '../src/world/osm/track';

/** Real-city zones that can be imported. bbox = [south, west, north, east]. */
export const ZONES: Record<
  string,
  {
    id: string;
    name: string;
    bbox: [number, number, number, number];
    osm: string;
    dem: string;
    /** OSM ways to leave out: mapping errors confirmed on the ground (why, in a comment). */
    dropWays?: number[];
    /**
     * One-way OSM ways drawn backwards (a divided avenue's carriageway running the same way as
     * its twin): confirmed on the ground, with the evidence in a comment. Report them upstream.
     */
    reverseWays?: number[];
    /** Famous monuments modeled by hand, at their real position. */
    monuments?: { kind: 'relojSolar'; name: string; lat: number; lon: number }[];
    /**
     * A race track instead of a city: the stretch of highway `ref` from `from` to `to` (see
     * src/world/osm/track.ts). Only its ways are fetched (`track` query).
     */
    track?: { ref: string; from: TrackEnd; to: TrackEnd; biome?: 'paramo' | 'cloudforest' | 'canyon'; road?: string; minRadius?: number; structures?: boolean };
    /** Closed street circuits raced inside a city (see src/world/osm/circuit.ts). */
    circuits?: ZoneCircuit[];
  }
> = {
  mariscal: {
    id: 'mariscal',
    name: 'La Mariscal',
    bbox: [-0.2125, -78.502, -0.195, -78.485],
    osm: 'data/raw/mariscal.osm.json',
    dem: 'data/raw/copernicus-S01-W079.tif',
    // No dropWays: the south-to-north link from 12 de Octubre through its own tunnel up to Av.
    // Patria (ways 24650066, 425195365, 420861081, 24650067) was once dropped as a mapping error,
    // but it is real (confirmed by a local).
    // Av. América's northbound (east) carriageway from the Universidad Central up to Fray Antonio
    // de Marchena, way 24652213, was reversed by mistake on 2026-08-29 (changeset 188174395, a
    // first edit moving a bus platform node, "MOvido"; iD flagged impossible_oneway twice): for
    // versions 1-23 (2008-2023) it ran north, and now both carriageways run south there, with
    // dead ends at both of its ends. A local playtester confirmed traffic runs north on that side.
    reverseWays: [24652213],
    // The Jesuits' stone sundial (1766/1786) in Plaza Indoamérica, at the Universidad Central's
    // entrance on Av. América: OSM node 2907866129 ("Plaza Indoamerica", historic=monument).
    // Just past the roadworks at the map edge, in view from Av. América.
    monuments: [{ kind: 'relojSolar', name: 'Reloj Solar de la Universidad Central', lat: -0.2013468, lon: -78.5017621 }],
    // Zona Rosa street circuit (city metres of the street crossings, in driving order; the first is
    // the start/finish line's street, the line itself 120 m after it). Twisty: Amazonas straight,
    // Calama / Mera / García chicane, Reina Victoria past Plaza Foch, Foch, Almagro, Wilson, back
    // along Reina Victoria and Carrión.
    circuits: [
      {
        id: 'zonarosa',
        name: 'Circuito Zona Rosa',
        laps: 3,
        via: [[-141, 1], [214, -286], [268, -209], [324, -243], [384, -161], [272, -94], [333, -12], [237, 43], [180, -36], [28, 153]],
      },
    ],
  },
  // "Paso de la Muerte": the E20 (Vía Interoceánica) from Papallacta down the Papallacta river's
  // gorge toward Cuyuja and Baeza: its first ~4.5 km raced (3120 to 2900 m, the windiest stretch),
  // all inside the W079 DEM tile.
  papallacta: {
    id: 'papallacta',
    name: 'Paso de la Muerte',
    bbox: [-0.3842, -78.1425, -0.3672, -78.1010],
    osm: 'data/raw/papallacta.osm.json',
    dem: 'data/raw/copernicus-S01-W079.tif',
    track: { ref: 'E20', from: { lat: -0.3796, lon: -78.139, name: 'Papallacta' }, to: { lat: -0.3697, lon: -78.106, name: 'Cuyuja' } },
  },
  // E20 Alóag to Santo Domingo, the cloud-forest descent past Río Silante: 5 km raced from Arrayán
  // (2590 m) down to the bridge at the river (2320 m), single carriageway all the way, very twisty.
  silante: {
    id: 'silante',
    name: 'Bajada del Silante',
    bbox: [-0.4505, -78.7165, -0.434, -78.685],
    osm: 'data/raw/silante.osm.json',
    dem: 'data/raw/copernicus-S01-W079.tif',
    track: { ref: 'E20', from: { lat: -0.4463, lon: -78.6882, name: 'Arrayán' }, to: { lat: -0.4418, lon: -78.7127, name: 'Río Silante' }, biome: 'cloudforest', road: 'Vía Alóag–Santo Domingo (E20)', minRadius: 24 },
  },
  // E30 "Ruta de las Cascadas" (Baños to Puyo) down the Pastaza gorge to Río Verde: a cliff road
  // through four real tunnels and past the waterfalls of the Ruta de las Cascadas, single carriageway.
  rioverde: {
    id: 'rioverde',
    name: 'Bajada de Río Verde',
    bbox: [-1.4125, -78.3375, -1.394, -78.27],
    osm: 'data/raw/rioverde.osm.json',
    dem: 'data/raw/copernicus-S02-W079.tif',
    track: { ref: 'E30', from: { lat: -1.40278, lon: -78.3272, name: 'Río Pastaza' }, to: { lat: -1.40516, lon: -78.27286, name: 'Río Verde' }, biome: 'canyon', road: 'Vía Baños–Puyo (E30)', minRadius: 24, structures: true },
  },
};
