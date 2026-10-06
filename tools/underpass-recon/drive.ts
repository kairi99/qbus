/**
 * Drives every vehicle preset through every lifted (bridge/underpass/ramp) drivable edge of La
 * Mariscal, along the legal path, taking every way out of the junction after it, at a cruise and
 * a fast speed. Records what the chassis touches (walls vs. floor), stalls, airtime, speed drops
 * and how far the body ends up from the road surface.
 *
 * Usage: npx tsx tools/underpass-recon/drive.ts [vehicles=popular,interparroquial,buseta,ae86] [speeds=40,75] [filter edge ids] > out.jsonl
 * Each line of stdout is a JSON run record; a summary goes to stderr.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP, RAPIER } from '../../src/physics/world';
import { BusPhysics } from '../../src/vehicle/bus';
import type { BusPreset } from '../../src/vehicle/busPreset';
import { buildCity } from '../../src/world/cityBuilder';
import { type CityData, groundHeightAt, type Vec2 } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, edgeY, makePath, projectOnPath } from '../../src/world/roadGraph';
import { Navigator, type GraphSpot } from '../../src/gameplay/navigation';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);
const nav = new Navigator(graph);
const vehicles = (process.argv[2] ?? 'popular,interparroquial,buseta,ae86').split(',');
const speeds = (process.argv[3] ?? '40,75').split(',').map(Number);
const only = process.argv[4] ? new Set(process.argv[4].split(',').map(Number)) : null;
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const TRACE = !!process.env.TRACE;

/** Height of the road under p for the path being driven: the nearest edge on the path, else ground. */
function roadY(edges: number[], p: Vec2): { y: number; edge: number; d: number } {
  let best = { y: groundHeightAt(city, p), edge: -1, d: Infinity };
  for (const id of edges) {
    const e = graph.edges[id];
    const pr = projectOnPath(e.center, p);
    if (pr.d < best.d) best = { y: edgeY(e, pr.s) ?? groundHeightAt(city, p), edge: id, d: pr.d };
  }
  return best;
}

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  world.step();
  const shapeName = (c: RAPIER.Collider) => RAPIER.ShapeType[c.shapeType()] ?? String(c.shapeType());

  const lifted = graph.edges.filter((e) => e.drivable && e.lift && e.lift.some((l) => Math.abs(l) > 1) && (!only || only.has(e.id)));
  console.error(`${lifted.length} lifted drivable edges`);
  const summary: string[] = [];
  for (const e of lifted) {
    const k = e.lift!.reduce((b, l, i) => (Math.abs(l) > Math.abs(e.lift![b]) ? i : b), 0);
    const mid: GraphSpot = { edge: e.id, s: e.center.cum[k] };
    const from = nav.behind(mid, 90);
    const outs = graph.nodes[e.to].out.map((id) => graph.edges[id]).filter((o) => o.drivable && o.id !== e.reverse);
    for (const next of outs.length ? outs : [null]) {
      const to: GraphSpot = next ? { edge: next.id, s: Math.min(next.len - 1, 40) } : { edge: e.id, s: e.len - 1 };
      const path = nav.route(from, to);
      if (!path) {
        summary.push(`edge ${e.id} -> ${next?.id}: NO ROUTE`);
        continue;
      }
      for (const vid of vehicles) {
        const preset = JSON.parse(readFileSync(`data/buses/${vid}.json`, 'utf8')) as BusPreset;
        for (const kmh of speeds) {
          const start = nav.pose(from);
          const sy = start.y ?? groundHeightAt(city, start.pos);
          const bus = new BusPhysics(world, preset, { x: start.pos.x, y: sy, z: start.pos.z, heading: start.heading });
          const chassis = bus.body.collider(0);
          const rec = {
            edge: e.id, road: e.road, roadIndex: e.roadIndex, next: next?.id ?? null, nextRoad: next?.road ?? null, vehicle: vid, kmh,
            reached: false, time: 0, offWheels: 0, airborne: 0, maxStall: 0, maxDev: 0,
            wall: [] as { x: number; z: number; y: number; t: number; shape: string; imp: number; nx: number; ny: number; nz: number }[],
            floor: [] as { x: number; z: number; y: number; t: number; shape: string; imp: number }[],
            maxAbove: -Infinity, minAbove: Infinity, maxDecel: 0, maxDecelAt: null as null | { x: number; z: number },
            vyMax: 0, vyMaxAt: null as null | { x: number; z: number }, rollMax: 0, pitchMax: 0, end: null as null | { x: number; y: number; z: number },
          };
          const goal = path.points[path.points.length - 1];
          const pathLine = makePath(path.points);
          let prevSpeed = 0;
          let stall = 0;
          const rideH = preset.body.height / 2 + 0.6; // reset clearance used by BusPhysics.reset
          for (let t = 0; t < 45; t += PHYSICS_STEP) {
            const p = bus.body.translation();
            const here = { x: p.x, z: p.z };
            const speed = bus.speed;
            // Speed target: slow for turns ahead.
            let target = kmh / 3.6;
            const pts = path.points;
            let bi = 0, bd = Infinity;
            pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) (bd = d), (bi = i); });
            let along = 0;
            for (let i = bi; i < pts.length - 2 && along < 80; i++) {
              const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
              along += Math.hypot(b.x - a.x, b.z - a.z);
              const turn = Math.abs(angle(Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x)));
              if (turn > 0.2) {
                const vc = Math.max(6, (kmh / 3.6) * (1 - turn / 1.4));
                target = Math.min(target, Math.sqrt(vc * vc + 2 * 4 * Math.max(0, along - 4)));
              }
            }
            const look = Math.max(7, Math.abs(speed) * 0.7);
            const aim = nav.guidePoint(path, here, look);
            const err = angle(Math.atan2(-(aim.z - p.z), aim.x - p.x) - bus.heading);
            const throttle = speed < target - 0.5 ? 1 : speed > target + 0.5 ? -1 : 0.2;
            bus.update({ throttle, steer: Math.max(-1, Math.min(1, -err * 2.5)), handbrake: false, boost: kmh > 60 && Math.abs(err) < 0.1 && speed < target - 3 }, PHYSICS_STEP);
            world.step();
            const q = bus.body.translation();
            const v = bus.body.linvel();
            rec.time = t;
            // Lateral deviation from the path.
            rec.maxDev = Math.max(rec.maxDev, projectOnPath(pathLine, here).d);
            const wheels = bus.wheelsOnGround;
            if (TRACE && Math.round(t * 60) % 15 === 0) console.error("step", JSON.stringify({ t: +t.toFixed(2), x: +q.x.toFixed(1), y: +q.y.toFixed(2), z: +q.z.toFixed(1), v: +bus.speed.toFixed(1), wheels, target: +target.toFixed(1), roadY: +roadY(path.edges, { x: q.x, z: q.z }).y.toFixed(2) }));
            if (wheels < 2) rec.offWheels += PHYSICS_STEP;
            if (wheels === 0) rec.airborne += PHYSICS_STEP;
            stall = Math.abs(bus.speed) < 1 && throttle > 0 ? stall + PHYSICS_STEP : 0;
            rec.maxStall = Math.max(rec.maxStall, stall);
            const decel = (prevSpeed - bus.speed) / PHYSICS_STEP;
            if (decel > rec.maxDecel && throttle >= 0) (rec.maxDecel = decel), (rec.maxDecelAt = { x: q.x, z: q.z });
            prevSpeed = bus.speed;
            if (v.y > rec.vyMax) (rec.vyMax = v.y), (rec.vyMaxAt = { x: q.x, z: q.z });
            const r = bus.body.rotation();
            const up = { x: 2 * (r.x * r.y - r.w * r.z), y: 1 - 2 * (r.x * r.x + r.z * r.z), z: 2 * (r.y * r.z + r.w * r.x) };
            const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
            rec.rollMax = Math.max(rec.rollMax, tilt);
            const ry = roadY(path.edges, { x: q.x, z: q.z });
            const above = q.y - ry.y;
            rec.maxAbove = Math.max(rec.maxAbove, above);
            rec.minAbove = Math.min(rec.minAbove, above);
            world.contactPairsWith(chassis, (other) => {
              const parent = other.parent();
              if (parent && !parent.isFixed()) return;
              world.contactPair(chassis, other, (m, flipped) => {
                if (m.numContacts() === 0) return;
                const n = m.normal();
                const sgn = flipped ? -1 : 1;
                let imp = 0;
                let real = false;
                for (let i = 0; i < m.numContacts(); i++) {
                  imp += m.contactImpulse(i);
                  if (m.contactDist(i) < 0.02) real = true;
                }
                // Speculative contacts (still apart) don't count.
                if (!real && imp <= 0) return;
                if (t < 1) return; // settling after the spawn drop
                const cp = m.numSolverContacts() ? m.solverContactPoint(0) : null;
                const ny = n.y * sgn;
                const item = { x: +q.x.toFixed(1), z: +q.z.toFixed(1), y: +q.y.toFixed(2), t: +t.toFixed(2), shape: shapeName(other), imp: +imp.toFixed(0), cp: cp ? [+cp.x.toFixed(1), +cp.y.toFixed(2), +cp.z.toFixed(1)] : null, cpRel: cp ? +(cp.y - q.y).toFixed(2) : null, v: +bus.speed.toFixed(1) };
                if (TRACE) console.error('contact', JSON.stringify({ ...item, n: [+(n.x * sgn).toFixed(2), +ny.toFixed(2), +(n.z * sgn).toFixed(2)] }));
                if (Math.abs(ny) > 0.7) rec.floor.push(item);
                else rec.wall.push({ ...item, nx: +(n.x * sgn).toFixed(2), ny: +ny.toFixed(2), nz: +(n.z * sgn).toFixed(2) });
              });
            });
            if (Math.hypot(goal.x - q.x, goal.z - q.z) < 8) {
              rec.reached = true;
              break;
            }
            if (q.y < -50) break;
          }
          const q = bus.body.translation();
          rec.end = { x: +q.x.toFixed(1), y: +q.y.toFixed(1), z: +q.z.toFixed(1) };
          (rec as any).rideH = rideH;
          // Keep at most a few contact samples, plus the count.
          const out = { ...rec, wallN: rec.wall.length, floorN: rec.floor.length, wall: rec.wall.filter((_, i) => i % Math.ceil(rec.wall.length / 8 || 1) === 0), floor: rec.floor.filter((_, i) => i % Math.ceil(rec.floor.length / 8 || 1) === 0) };
          console.log(JSON.stringify(out));
          const bad = !rec.reached || rec.wall.length > 0 || rec.floor.length > 0 || rec.airborne > 0.15 || rec.maxStall > 1;
          if (bad)
            summary.push(
              `edge ${e.id} ${e.road} -> ${next?.road ?? '-'}(${next?.id}) ${vid}@${kmh}: reached=${rec.reached} t=${rec.time.toFixed(1)} wall=${rec.wall.length} floor=${rec.floor.length} air=${rec.airborne.toFixed(2)} stall=${rec.maxStall.toFixed(1)} dev=${rec.maxDev.toFixed(1)} end=(${rec.end.x},${rec.end.z})` +
                (rec.wall[0] ? ` firstWall@(${rec.wall[0].x},${rec.wall[0].z}) ${rec.wall[0].shape}` : '') +
                (rec.floor[0] ? ` firstFloor@(${rec.floor[0].x},${rec.floor[0].z}) ${rec.floor[0].shape}` : ''),
            );
          world.removeRigidBody(bus.body);
          (world as any).removeVehicleController?.(bus.vehicle);
        }
      }
    }
  }
  console.error(summary.join('\n'));
}
main();
