import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { Vec2 } from './cityData';
import type { ChunkedMeshBuilder, MeshBuilder } from './meshBuilder';
import { locateOnTrack, type TrackData, type TrackScenery } from './track';

/**
 * The 230 kV double-circuit line that crosses the Silante valley (OSM's power=line): lattice steel
 * towers, three cross-arms a side with insulator strings, an earth-wire peak, and the six cables
 * plus the earth wire between them, sagging. Towers are built into the static tiles; the cables
 * are one LineSegments draw. Only what OSM maps is drawn: a tower per mapped tower node.
 */

/** Heights (m over the tower's base) of the panel rings, and the body's half width at each. */
const LEVELS = [0, 6, 13, 20, 27.5, 32.5, 37.5];
const HALF = [3.4, 2.7, 2.1, 1.5, 1.0, 0.85, 0.7];
/** The three cross-arms (they sit on the top three rings): height and reach from the axis. */
const ARM_Y = [27.5, 32.5, 37.5];
const ARM_LEN = [5.6, 5.0, 4.2];
/** An insulator string hangs this far under the arm's tip; the cable is held at its foot. */
const INSULATOR = 2.2;
/** The earth wire's peak over the top ring. */
const PEAK = 4.6;
/** Cable sag at midspan, as a share of the span (the earth wire hangs tighter). */
const SAG = 0.035;
const EARTH_SAG = 0.025;
/** Plants, crowds and mist stay this far (m) from a tower's axis. */
export const TOWER_CLEAR = 6;
/** A tower further than this from the asphalt (m) gets no collider: nothing can drive there. */
const SOLID_REACH = 30;
/** Cable segments per span. */
const CABLE_STEPS = 16;
/** A cable never hangs closer than this (m) to the ground under it (a span over a valley). */
const GROUND_CLEAR = 6;
const STEEL_LEG = '#8f979d';
const STEEL = '#aeb5ba';
const GLASS = '#b7bba8';
const CABLE = '#26292b';

/** A tower's axes: along the line and across it (the way its arms point), unit, on the ground plane. */
export interface TowerFrame {
  along: Vec2;
  across: Vec2;
}

/**
 * Each tower's frame: along the bisector of the line's directions in and out (the end towers use
 * their one span), arms across it. Cables then leave every arm at the same angle both ways.
 */
export function towerFrames(towers: Vec2[]): TowerFrame[] {
  const dir = (a: Vec2, b: Vec2) => {
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };
  return towers.map((t, i) => {
    const i0 = towers[i - 1] ? dir(towers[i - 1], t) : null;
    const i1 = towers[i + 1] ? dir(t, towers[i + 1]) : null;
    const a = i0 && i1 ? { x: i0.x + i1.x, z: i0.z + i1.z } : (i0 ?? i1 ?? { x: 1, z: 0 });
    const l = Math.hypot(a.x, a.z);
    // (A line doubling back on itself has no bisector: take the incoming direction.)
    const along = l < 1e-6 ? (i0 ?? { x: 1, z: 0 }) : { x: a.x / l, z: a.z / l };
    return { along, across: { x: -along.z, z: along.x } };
  });
}

/** Where a tower's seven cables are held (six conductors, then the earth wire), for a base at height `y0`. */
export function attachPoints(p: Vec2, frame: TowerFrame, y0: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++)
    for (const side of [-1, 1]) out.push(new THREE.Vector3(p.x + frame.across.x * side * ARM_LEN[i], y0 + ARM_Y[i] - INSULATOR, p.z + frame.across.z * side * ARM_LEN[i]));
  out.push(new THREE.Vector3(p.x, y0 + LEVELS[LEVELS.length - 1] + PEAK, p.z));
  return out;
}

/** A cable's height at fraction `u` of its span: the chord from `y0` to `y1` hung `sag` meters at midspan (a parabola, close enough to a catenary at a few percent). */
export function cableY(y0: number, y1: number, u: number, sag: number): number {
  return y0 + (y1 - y0) * u - 4 * sag * u * (1 - u);
}

/** A tower's base: its four feet (a square aligned to the line), the ground under each, and the ring height. */
function footing(p: Vec2, f: TowerFrame, ground: (p: Vec2) => number) {
  const feet = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, c]) => {
    const q = { x: p.x + f.along.x * a * HALF[0] + f.across.x * c * HALF[0], z: p.z + f.along.z * a * HALF[0] + f.across.z * c * HALF[0] };
    return { p: q, g: ground(q) };
  });
  // The ring sits on the highest foot; the others' legs reach down to their own ground.
  return { feet, y0: Math.max(...feet.map((q) => q.g)) };
}

/** A square steel member between two points. */
function beam(mb: MeshBuilder, a: THREE.Vector3Like, b: THREE.Vector3Like, w: number, color: string): void {
  const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
  const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(w / 2);
  const v = new THREE.Vector3().crossVectors(d, u).normalize().multiplyScalar(w / 2);
  const c = (e: THREE.Vector3Like, su: number, sv: number) => ({ x: e.x + u.x * su + v.x * sv, y: e.y + u.y * su + v.y * sv, z: e.z + u.z * su + v.z * sv });
  const ring = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let k = 0; k < 4; k++) {
    const [s0, t0] = ring[k];
    const [s1, t1] = ring[(k + 1) % 4];
    mb.quad(c(a, s0, t0), c(b, s0, t0), c(b, s1, t1), c(a, s1, t1), color);
  }
}

/** One lattice tower: tapering four-legged body with X bracing, three cross-arms a side, insulators, earth-wire peak. */
function tower(mb: MeshBuilder, p: Vec2, f: TowerFrame, y0: number, feet: { p: Vec2; g: number }[]): void {
  const at = (a: number, c: number, y: number) => new THREE.Vector3(p.x + f.along.x * a + f.across.x * c, y0 + y, p.z + f.along.z * a + f.across.z * c);
  const corner = (k: number, level: number) => {
    const [a, c] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ][k];
    return at(a * HALF[level], c * HALF[level], LEVELS[level]);
  };
  for (let j = 0; j < LEVELS.length; j++) {
    for (let k = 0; k < 4; k++) {
      // Rings, and (between this ring and the next) legs and the X on each face.
      beam(mb, corner(k, j), corner((k + 1) % 4, j), 0.18, STEEL);
      if (j + 1 === LEVELS.length) continue;
      beam(mb, corner(k, j), corner(k, j + 1), j < 3 ? 0.4 : 0.28, STEEL_LEG);
      beam(mb, corner(k, j), corner((k + 1) % 4, j + 1), 0.13, STEEL);
      beam(mb, corner((k + 1) % 4, j), corner(k, j + 1), 0.13, STEEL);
    }
  }
  // Each leg runs on down to its own ground (the foot on the downhill side is longer).
  feet.forEach((q, k) => {
    const c = corner(k, 0);
    beam(mb, c, new THREE.Vector3(c.x, q.g - 0.5, c.z), 0.4, STEEL_LEG);
  });
  for (let i = 0; i < 3; i++) {
    const y = ARM_Y[i];
    const root = HALF[LEVELS.indexOf(y)];
    for (const side of [-1, 1]) {
      const tip = side * ARM_LEN[i];
      for (const a of [-1, 1]) {
        // A triangular truss per face of the body: top and bottom chord meeting at the tip.
        beam(mb, at(a * root, side * root, y + 0.8), at(a * 0.3, tip, y), 0.16, STEEL);
        beam(mb, at(a * root, side * root, y - 0.8), at(a * 0.3, tip, y), 0.16, STEEL);
      }
      beam(mb, at(-0.3, tip, y), at(0.3, tip, y), 0.16, STEEL);
      beam(mb, at(0, tip, y), at(0, tip, y - INSULATOR), 0.16, GLASS);
    }
  }
  // The peak that carries the earth wire.
  const top = LEVELS[LEVELS.length - 1];
  beam(mb, at(0, 0, top), at(0, 0, top + PEAK), 0.24, STEEL_LEG);
  for (let k = 0; k < 4; k++) beam(mb, corner(k, LEVELS.length - 1), at(0, 0, top + PEAK), 0.12, STEEL);
}

/** The towers' collision: a thin solid per leg for the first few meters, where a bus could reach one. */
function legSolids(race: TrackData, p: Vec2, feet: { p: Vec2; g: number }[], y0: number, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  if (Math.abs(locateOnTrack(race, p).off) > race.width / 2 + SOLID_REACH) return;
  for (const q of feet) {
    const h = 0.25;
    const pts: number[] = [];
    for (const y of [q.g - 0.5, y0 + 6]) for (const [dx, dz] of [[-h, -h], [h, -h], [h, h], [-h, h]]) pts.push(q.p.x + dx, y, q.p.z + dz);
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (desc) world.createCollider(desc.setFriction(0.5), fixed);
  }
}

/**
 * Builds the lines into the static tiles (towers) and returns their cables as one draw call
 * (null with none). Visual cables only: they hang far over the road, if they cross it at all.
 */
export function powerLines(
  race: TrackData,
  lines: NonNullable<TrackScenery['powerLines']>,
  solid: ChunkedMeshBuilder,
  ground: (p: Vec2) => number,
  world: RAPIER.World,
  fixed: RAPIER.RigidBody,
): THREE.LineSegments | null {
  const verts: number[] = [];
  for (const line of lines) {
    const frames = towerFrames(line.towers);
    const bases = line.towers.map((p, i) => footing(p, frames[i], ground));
    const held = line.towers.map((p, i) => attachPoints(p, frames[i], bases[i].y0));
    line.towers.forEach((p, i) => {
      tower(solid.at(p.x, p.z), p, frames[i], bases[i].y0, bases[i].feet);
      legSolids(race, p, bases[i].feet, bases[i].y0, world, fixed);
    });
    for (let i = 0; i + 1 < line.towers.length; i++) {
      const span = Math.hypot(line.towers[i + 1].x - line.towers[i].x, line.towers[i + 1].z - line.towers[i].z);
      for (let k = 0; k < held[i].length; k++) {
        const [a, b] = [held[i][k], held[i + 1][k]];
        const sag = span * (k === 6 ? EARTH_SAG : SAG);
        let prev: THREE.Vector3 | null = null;
        for (let s = 0; s <= CABLE_STEPS; s++) {
          const u = s / CABLE_STEPS;
          const x = a.x + (b.x - a.x) * u;
          const z = a.z + (b.z - a.z) * u;
          const cur = new THREE.Vector3(x, Math.max(cableY(a.y, b.y, u, sag), ground({ x, z }) + GROUND_CLEAR), z);
          if (prev) verts.push(prev.x, prev.y, prev.z, cur.x, cur.y, cur.z);
          prev = cur;
        }
      }
    }
  }
  if (!verts.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.computeBoundingSphere();
  const mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: CABLE, fog: true }));
  mesh.frustumCulled = true;
  return mesh;
}

/** Within `r` meters of a tower's axis (plants, crowds and mist keep off). */
export function nearTower(lines: TrackScenery['powerLines'], p: Vec2, r: number = TOWER_CLEAR): boolean {
  return !!lines && lines.some((l) => l.towers.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < r));
}
