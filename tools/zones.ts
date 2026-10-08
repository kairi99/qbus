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
  },
};
