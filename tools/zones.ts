/** Real-city zones that can be imported. bbox = [south, west, north, east]. */
export const ZONES: Record<string, { id: string; name: string; bbox: [number, number, number, number]; osm: string; dem: string }> = {
  mariscal: {
    id: 'mariscal',
    name: 'La Mariscal',
    bbox: [-0.2125, -78.502, -0.195, -78.485],
    osm: 'data/raw/mariscal.osm.json',
    dem: 'data/raw/copernicus-S01-W079.tif',
  },
};
