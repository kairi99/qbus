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
  },
};
