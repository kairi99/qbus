import { distToPolyline, pointInPolygon } from './geom';
import { type Terrain, terrainHeight } from './terrain';

/**
 * Engine-agnostic description of a drivable city. Both the procedural generator and the
 * (M6) OpenStreetMap importer produce this; cityBuilder turns it into meshes + colliders.
 * Coordinates are meters on the ground plane (x, z); heading follows the bus convention
 * (0 = facing +X, positive turns toward -Z).
 */
export interface Vec2 {
  x: number;
  z: number;
}

export interface Road {
  name: string;
  kind: 'street' | 'avenue';
  points: Vec2[];
  width: number;
  /** Total lanes (both directions, or all one way when `oneway`). */
  lanes: number;
  /** Traffic only flows in the direction the points are listed. */
  oneway?: boolean;
  /** OSM level of a bridge (> 0) or underpass (< 0). */
  layer?: number;
  /**
   * Height of the road above (or below) the ground at each point, for bridges, underpasses and
   * their ramps (see osm/grades.ts). Absent means the road lies on the ground.
   */
  lift?: number[];
}

/** Raised pedestrian area (sidewalk around a block, or a park). */
export interface Block {
  kind: 'sidewalk' | 'park';
  footprint: Vec2[];
}

export interface Building {
  footprint: Vec2[];
  height: number;
  color: string;
  roof: string;
}

/** Rapid-transit systems with their own stations (the Metro is underground: entrances only). */
export type TransitSystem = 'trolebus' | 'ecovia' | 'metrobus';

export interface Stop {
  id: string;
  name: string;
  /** Where passengers wait: on the sidewalk to the right of travel, or on the platform edge for `side: 'left'`. */
  pos: Vec2;
  /** Direction of travel of a bus serving this stop. */
  heading: number;
  /** Median stations are boarded from the left (BRT buses have doors on that side). */
  side?: 'left';
  /** Rapid-transit stop: only that system's lines serve it, and it has a station instead of a shelter. */
  system?: TransitSystem;
}

/** A rapid-transit station platform (in the median, or at the curb where there's no median). */
export interface Station {
  name: string;
  system: TransitSystem;
  /** Center of the platform. */
  pos: Vec2;
  /** Along the avenue. */
  heading: number;
  length: number;
  width: number;
}

/** A wall around closed grounds (a campus): the bus can't get in. */
export interface Wall {
  points: Vec2[];
}

/**
 * Real terrain far around the city (coarse, no collisions), for the view: the valley, the hills
 * and Pichincha. Same layout and height base as `Terrain`, heights in whole meters.
 */
export interface Horizon {
  minX: number;
  minZ: number;
  cell: number;
  cols: number;
  rows: number;
  heights: number[];
}

/** A far-off landmark drawn in the view: the Virgen on El Panecillo, the snow volcanoes. */
export interface Landmark {
  kind: 'virgen' | 'volcano';
  name: string;
  pos: Vec2;
  /** Ground height there (Virgen) or summit height (volcano), same base as the terrain. */
  y: number;
}

/** A Metro de Quito entrance: a canopy over stairs going down. */
export interface MetroEntrance {
  /** Station it leads to. */
  name: string;
  pos: Vec2;
  /** The way out of the stairs (people coming up walk this way). */
  heading: number;
}

/** Static driving toys placed on roads. */
export interface Feature {
  kind: 'ramp' | 'hump';
  pos: Vec2;
  heading: number;
  length: number;
  width: number;
  height: number;
}

export type PropKind = 'cone' | 'trashcan' | 'fruitStand';

export interface Prop {
  kind: PropKind;
  pos: Vec2;
  heading: number;
}

export interface CityData {
  name: string;
  roads: Road[];
  blocks: Block[];
  buildings: Building[];
  stops: Stop[];
  features: Feature[];
  props: Prop[];
  trees: Vec2[];
  spawn: { pos: Vec2; heading: number };
  bounds: { min: Vec2; max: Vec2 };
  /** Real elevation (imported cities). Absent means flat ground at y = 0. */
  terrain?: Terrain;
  /** Green areas drawn on the ground (imported cities; generated ones use park blocks). */
  parks?: Vec2[][];
  /** Where the data came from, shown in credits. */
  attribution?: string;
  /** Real bus lines through an imported zone. */
  lines?: import('./osm/lines').BusLine[];
  /** Trolebús / Ecovía / Metrobus stations. */
  stations?: Station[];
  metro?: MetroEntrance[];
  /**
   * Where the game happens (imported cities): the map edge is closed off by roadworks along
   * this rectangle, so nobody sees where the streets and traffic end.
   */
  playArea?: { min: Vec2; max: Vec2 };
  walls?: Wall[];
  horizon?: Horizon;
  landmarks?: Landmark[];
}

export const SIDEWALK_HEIGHT = 0.15;

/** Height of the terrain (without sidewalk slabs) at `p`. */
export function terrainAt(city: CityData, p: Vec2): number {
  return city.terrain ? terrainHeight(city.terrain, p.x, p.z) : 0;
}

/** Height of the walkable surface at `p`: terrain plus the sidewalk/park slab if on one. */
export function groundHeightAt(city: CityData, p: Vec2): number {
  const slab = city.blocks.some((b) => pointInPolygon(p, b.footprint)) ? SIDEWALK_HEIGHT : 0;
  return terrainAt(city, p) + slab;
}

/** Inside the play area (everywhere for cities without one), at least `pad` meters in. */
export function inPlayArea(city: Pick<CityData, 'playArea'>, p: Vec2, pad = 0): boolean {
  const a = city.playArea;
  return !a || (p.x >= a.min.x + pad && p.x <= a.max.x - pad && p.z >= a.min.z + pad && p.z <= a.max.z - pad);
}

/** Unit forward vector for a heading. */
export function forward(heading: number): Vec2 {
  return { x: Math.cos(heading), z: -Math.sin(heading) };
}

/** Unit vector pointing to the right of travel for a heading (traffic drives on the right). */
export function right(heading: number): Vec2 {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

/**
 * Where the bus stops for `s`: on the road beside the shelter, or beside the platform edge
 * (in the lane next to it) for median stations boarded from the left.
 */
export function stopZone(s: Stop): Vec2 {
  const r = right(s.heading);
  const k = s.side === 'left' ? -2.7 : 4.2;
  return { x: s.pos.x - r.x * k, z: s.pos.z - r.z * k };
}

/** The road whose asphalt contains `p` (closest centerline wins), or null when off-road. */
export function nearestRoad(city: CityData, p: Vec2): Road | null {
  let best: Road | null = null;
  let bestD = Infinity;
  for (const r of city.roads) {
    const d = distToPolyline(p, r.points);
    if (d < r.width / 2 && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}
