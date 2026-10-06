/**
 * Simple autopilot that drives the real physics vehicle (BusPhysics) along a route of lane
 * edges, recording everything the drive-through suite asserts on.
 */
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { Navigator } from '../../src/gameplay/navigation';
import { PHYSICS_STEP, RAPIER } from '../../src/physics/world';
import { BusPhysics } from '../../src/vehicle/bus';
import type { BusPreset } from '../../src/vehicle/busPreset';
import type { CityData, Vec2 } from '../../src/world/cityData';
import { groundHeightAt } from '../../src/world/cityData';
import { type RoadGraph, edgeY, lanePoint } from '../../src/world/roadGraph';
import { distToPolyline } from '../../src/world/geom';
import { routePath, surfaceAlong } from './catalog';

/** Lateral acceleration the autopilot allows itself in curves (m/s²). */
const A_LAT = 3.5;

export interface DriveResult {
  reached: boolean;
  time: number;
  /** Time budget it had. */
  budget: number;
  /** Longest stretch at < 1 m/s (after pulling away), s. */
  stuck: number;
  stuckAt: Vec2 | null;
  /** Longest stretch with no wheel touching anything, s. */
  airborne: number;
  airAt: Vec2 | null;
  /** Chassis (body box) contacts: count of steps, biggest impulse and where/what. */
  bodyContacts: number;
  maxImpulse: number;
  /** Horizontal share of that impulse (a wall shove rather than bottoming out). */
  maxLateralImpulse: number;
  contactAt: { pos: Vec2; y: number; normal: { x: number; y: number; z: number } } | null;
  /** Chassis height minus road height, relative to its ride height at the start (m). */
  maxRise: number;
  maxSink: number;
  riseAt: Vec2 | null;
  sinkAt: Vec2 | null;
  /** Fell below the road surface (through the floor). */
  fellThrough: boolean;
  /** Farthest the bus got from its lane path (m). */
  maxOffPath: number;
  offPathAt: Vec2 | null;
  /** Top speed reached on the passage (km/h). */
  topKmh: number;
}

export interface DriveOptions {
  /** Cruise speed (km/h). */
  kmh: number;
  /** Route index range of the passage (for top speed). */
  passage?: { from: number; to: number };
  /** Seconds allowed on top of length / (cruise / 2). */
  slack?: number;
  /** Called every step (debugging). */
  trace?: (t: number, bus: BusPhysics, info: { throttle: number; steer: number; target: number; offPath: number; surfaceY: number }) => void;
}

const fmt = (p: Vec2 | null) => (p ? `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})` : '-');

export function describe(r: DriveResult): string {
  return [
    `reached=${r.reached} in ${r.time.toFixed(1)}/${r.budget.toFixed(0)} s, top ${r.topKmh.toFixed(0)} km/h`,
    `stuck ${r.stuck.toFixed(1)} s at ${fmt(r.stuckAt)}`,
    `airborne ${r.airborne.toFixed(2)} s at ${fmt(r.airAt)}`,
    `body contacts ${r.bodyContacts} steps, max impulse ${r.maxImpulse.toFixed(0)} (lateral ${r.maxLateralImpulse.toFixed(0)}) at ${fmt(r.contactAt?.pos ?? null)} y=${r.contactAt?.y.toFixed(2) ?? '-'}`,
    `height vs road +${r.maxRise.toFixed(2)} at ${fmt(r.riseAt)} / ${r.maxSink.toFixed(2)} at ${fmt(r.sinkAt)}${r.fellThrough ? ' FELL THROUGH' : ''}`,
    `off path ${r.maxOffPath.toFixed(1)} m at ${fmt(r.offPathAt)}`,
  ].join('; ');
}

export function driveRoute(world: RAPIER_T.World, city: CityData, graph: RoadGraph, preset: BusPreset, route: number[], opts: DriveOptions): DriveResult {
  const nav = new Navigator(graph);
  const first = graph.edges[route[0]];
  const s0 = Math.min(6, first.len / 2);
  const path = routePath(graph, route, s0);
  const start = lanePoint(first, s0, 0);
  const startY = edgeY(first, s0) ?? groundHeightAt(city, start);
  const head = nav.pose({ edge: first.id, s: s0 }).heading;
  const bus = new BusPhysics(world, preset, { x: start.x, y: startY, z: start.z, heading: head });
  const chassis = bus.body.collider(0);
  const goal = path.points[path.points.length - 1];
  const cruise = opts.kmh / 3.6;
  const budget = path.length / (cruise / 2) + (opts.slack ?? 10);
  const r: DriveResult = {
    reached: false, time: 0, budget, stuck: 0, stuckAt: null, airborne: 0, airAt: null, bodyContacts: 0, maxImpulse: 0, maxLateralImpulse: 0,
    contactAt: null, maxRise: 0, maxSink: 0, riseAt: null, sinkAt: null, fellThrough: false, maxOffPath: 0, offPathAt: null, topKmh: 0,
  };
  const passageEdges = opts.passage ? new Set(route.slice(opts.passage.from, opts.passage.to)) : null;
  let ride: number | null = null;
  let slow = 0;
  let air = 0;
  try {
    // Settle on the wheels first.
    for (let t = 0; t < 1; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    {
      const p = bus.body.translation();
      ride = p.y - surfaceAlong(city, graph, route, p).y;
    }
    for (let t = 0; t < budget; t += PHYSICS_STEP) {
      const p = bus.body.translation();
      const here = { x: p.x, z: p.z };
      const v = bus.speed;
      // Aim ahead on the path; slow for curves ahead.
      const look = Math.max(8, Math.abs(v) * 0.8);
      const aim = nav.guidePoint(path, here, look);
      const a1 = nav.guidePoint(path, here, 12);
      const a2 = nav.guidePoint(path, here, 32);
      const h1 = Math.atan2(a1.z - p.z, a1.x - p.x);
      const h2 = Math.atan2(a2.z - a1.z, a2.x - a1.x);
      const bend = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
      const curvature = bend / 20;
      const target = Math.min(cruise, curvature > 1e-3 ? Math.sqrt(A_LAT / curvature) : cruise);
      const want = Math.atan2(-(aim.z - p.z), aim.x - p.x);
      const err = Math.atan2(Math.sin(want - bus.heading), Math.cos(want - bus.heading));
      const throttle = Math.max(-1, Math.min(1, (target - v) * 0.4));
      const steer = Math.max(-1, Math.min(1, -err * 2.5));
      bus.update({ throttle, steer, handbrake: false }, PHYSICS_STEP);
      world.step();
      r.time = t;

      const q = bus.body.translation();
      const pos = { x: q.x, z: q.z };
      const surf = surfaceAlong(city, graph, route, pos);
      if (!passageEdges || passageEdges.has(surf.edge)) r.topKmh = Math.max(r.topKmh, v * 3.6);
      const dev = q.y - surf.y - ride!;
      if (dev > r.maxRise) (r.maxRise = dev), (r.riseAt = pos);
      if (dev < r.maxSink) (r.maxSink = dev), (r.sinkAt = pos);
      if (q.y < surf.y - 0.5) r.fellThrough = true;
      // Off path: distance to the path polyline (junction crossings are single long segments).
      const off = distToPolyline(pos, path.points);
      if (off > r.maxOffPath) (r.maxOffPath = off), (r.offPathAt = pos);

      if (t > 2 && Math.abs(v) < 1) slow += PHYSICS_STEP;
      else slow = 0;
      if (slow > r.stuck) (r.stuck = slow), (r.stuckAt = pos);
      if (bus.wheelsOnGround === 0) air += PHYSICS_STEP;
      else air = 0;
      if (air > r.airborne) (r.airborne = air), (r.airAt = pos);

      let touched = false;
      world.contactPairsWith(chassis, (other) => {
        world.contactPair(chassis, other, (m) => {
          if (m.numContacts() === 0) return;
          let imp = 0;
          for (let i = 0; i < m.numContacts(); i++) imp += m.contactImpulse(i);
          touched ||= imp > 0 || m.numSolverContacts() > 0;
          const n = m.normal();
          const lat = imp * Math.hypot(n.x, n.z);
          if (imp > r.maxImpulse) {
            r.maxImpulse = imp;
            r.contactAt = { pos, y: q.y, normal: { x: n.x, y: n.y, z: n.z } };
          }
          r.maxLateralImpulse = Math.max(r.maxLateralImpulse, lat);
        });
      });
      if (touched) r.bodyContacts++;

      opts.trace?.(t, bus, { throttle, steer, target, offPath: off, surfaceY: surf.y });
      if (Math.hypot(goal.x - q.x, goal.z - q.z) < 8) {
        r.reached = true;
        break;
      }
      if (r.fellThrough) break;
    }
  } finally {
    world.removeVehicleController(bus.vehicle);
    world.removeRigidBody(bus.body);
  }
  return r;
}

export { RAPIER };
