import { distToPolyline, pointInPolygon } from './geom';

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
  lanes: number;
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

export interface Stop {
  id: string;
  name: string;
  /** Where passengers wait, on the sidewalk to the right of travel. */
  pos: Vec2;
  /** Direction of travel of a bus serving this stop. */
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
}

export const SIDEWALK_HEIGHT = 0.15;

/** Height of the walkable surface at `p` (top of a sidewalk/park slab, else street level). */
export function groundHeightAt(city: CityData, p: Vec2): number {
  return city.blocks.some((b) => pointInPolygon(p, b.footprint)) ? SIDEWALK_HEIGHT : 0;
}

/** Unit forward vector for a heading. */
export function forward(heading: number): Vec2 {
  return { x: Math.cos(heading), z: -Math.sin(heading) };
}

/** Unit vector pointing to the right of travel for a heading (traffic drives on the right). */
export function right(heading: number): Vec2 {
  return { x: Math.sin(heading), z: Math.cos(heading) };
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
