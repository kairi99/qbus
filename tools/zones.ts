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
    /** Famous monuments modeled by hand, at their real position. */
    monuments?: { kind: 'relojSolar'; name: string; lat: number; lon: number }[];
  }
> = {
  mariscal: {
    id: 'mariscal',
    name: 'La Mariscal',
    bbox: [-0.2125, -78.502, -0.195, -78.485],
    osm: 'data/raw/mariscal.osm.json',
    dem: 'data/raw/copernicus-S01-W079.tif',
    // Patria y 12 de Octubre: OSM has a south-to-north link from 12 de Octubre through its own
    // tunnel up to the roundabout that doesn't exist there. The underpass only allows 12 de
    // Octubre in both directions and north-to-south onto Queseras del Medio (checked by a local).
    dropWays: [24650066, 425195365, 420861081, 24650067],
    // The Jesuits' stone sundial (1766/1786) in Plaza Indoamérica, at the Universidad Central's
    // entrance on Av. América: OSM node 2907866129 ("Plaza Indoamerica", historic=monument).
    // Just past the roadworks at the map edge, in view from Av. América.
    monuments: [{ kind: 'relojSolar', name: 'Reloj Solar de la Universidad Central', lat: -0.2013468, lon: -78.5017621 }],
  },
};
