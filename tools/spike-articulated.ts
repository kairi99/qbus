/**
 * Spike behind the articulated bus: (a) two rigid bodies hinged by a Rapier joint (the real
 * `BusPhysics` with `preset.articulated`) against (b) the front section alone with a kinematic
 * trailer that follows its hitch. Prints numbers per scenario at 60 Hz.
 *   npx tsx tools/spike-articulated.ts
 */
import { RAPIER, addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import type { DriveInput } from '../src/core/input';
import articulado from '../data/buses/articulado.json';

const preset = articulado as BusPreset;
const art = preset.articulated!;
const Lf = preset.body.length - art.rearLength - art.gap;
const idle: DriveInput = { throttle: 0, steer: 0, handbrake: false };

type V = { x: number; y: number; z: number };
type Q = { x: number; y: number; z: number; w: number };
const rot = (q: Q, v: V): V => {
  const cx = q.y * v.z - q.z * v.y;
  const cy = q.z * v.x - q.x * v.z;
  const cz = q.x * v.y - q.y * v.x;
  return { x: v.x + 2 * (q.w * cx + q.y * cz - q.z * cy), y: v.y + 2 * (q.w * cy + q.z * cx - q.x * cz), z: v.z + 2 * (q.w * cz + q.x * cy - q.y * cx) };
};
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const yawQ = (h: number): Q => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
const headingOf = (q: Q) => {
  const f = rot(q, { x: 1, y: 0, z: 0 });
  return Math.atan2(-f.z, f.x);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Rig {
  world: RAPIER.World;
  front: BusPhysics;
  /** Per-step hook before world.step (kinematic trailer follows). */
  pre(): void;
  rearBody: RAPIER.RigidBody;
  bend(): number;
  /** Distance between the two hinge anchors, m. */
  separation(): number;
  mode: 'joint' | 'kinematic';
  rearCollider: RAPIER.Collider;
}

function make(mode: 'joint' | 'kinematic', extra?: (w: RAPIER.World) => void, at = { x: 0, z: 0 }): Rig {
  const world = createWorld();
  addGround(world, 3000);
  extra?.(world);
  if (mode === 'joint') {
    const front = new BusPhysics(world, preset, { x: at.x, y: 0, z: at.z, heading: 0 });
    const r = front.rear!;
    const anchorF = (): V => add(front.body.translation(), rot(front.body.rotation(), { x: -(Lf / 2 + art.gap / 2), y: 0, z: 0 }));
    const anchorR = (): V => add(r.body.translation(), rot(r.body.rotation(), { x: art.rearLength / 2 + art.gap / 2, y: 0, z: 0 }));
    return {
      world,
      front,
      pre: () => {},
      rearBody: r.body,
      bend: () => front.bend,
      separation: () => {
        const a = anchorF();
        const b = anchorR();
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      },
      mode,
      rearCollider: r.body.collider(0),
    };
  }
  // Kinematic: the front section alone (shortened), trailer pulled along by its hitch.
  const p2: BusPreset = { ...preset, articulated: undefined, body: { ...preset.body, length: Lf } };
  const front = new BusPhysics(world, p2, { x: at.x + (preset.body.length / 2 - Lf / 2), y: 0, z: at.z, heading: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x - 8, 1.7, at.z));
  const col = world.createCollider(RAPIER.ColliderDesc.cuboid(art.rearLength / 2, preset.body.height / 2, preset.body.width / 2), body);
  const axleDist = art.gap / 2 + art.rearLength / 2 - art.rearAxle;
  let axle: V = { x: at.x - (Lf / 2 + art.gap / 2) - axleDist, y: 0, z: at.z };
  let rh = 0;
  const hitchW = (): V => add(front.body.translation(), rot(front.body.rotation(), { x: -(Lf / 2 + art.gap / 2), y: 0, z: 0 }));
  const lim = (art.yawLimitDeg * Math.PI) / 180;
  const pre = () => {
    const h = hitchW();
    const fh = front.heading;
    let d = Math.atan2(-(h.z - axle.z), h.x - axle.x);
    // Heading of the trailer = direction axle -> hitch, clamped to the bend limit.
    d = fh + Math.max(-lim, Math.min(lim, wrap(d - fh)));
    rh = d;
    const dir = { x: Math.cos(d), y: 0, z: -Math.sin(d) };
    axle = { x: h.x - dir.x * axleDist, y: 0, z: h.z - dir.z * axleDist };
    const c = { x: h.x - dir.x * (art.gap / 2 + art.rearLength / 2), y: h.y, z: h.z - dir.z * (art.gap / 2 + art.rearLength / 2) };
    body.setNextKinematicTranslation(c);
    body.setNextKinematicRotation(yawQ(d));
  };
  return {
    world,
    front,
    pre,
    rearBody: body,
    bend: () => wrap(rh - front.heading),
    separation: () => 0,
    mode,
    rearCollider: col,
  };
}

function run(rig: Rig, input: DriveInput | ((t: number) => DriveInput), seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += PHYSICS_STEP) {
    rig.front.update(typeof input === 'function' ? input(t) : input, PHYSICS_STEP);
    rig.pre();
    rig.world.step();
    each?.(t);
  }
}

const upY = (b: RAPIER.RigidBody) => {
  const q = b.rotation();
  return 1 - 2 * (q.x * q.x + q.z * q.z);
};
const finite = (rig: Rig) =>
  [rig.front.body.translation(), rig.rearBody.translation()].every((t) => Number.isFinite(t.x + t.y + t.z));

/** How deep the rear box sits inside static world geometry (max over the run), m. */
function overlapDepth(rig: Rig, shapeHalf: V): number {
  const shape = new RAPIER.Cuboid(shapeHalf.x, shapeHalf.y, shapeHalf.z);
  const t = rig.rearBody.translation();
  const q = rig.rearBody.rotation();
  let depth = 0;
  rig.world.intersectionsWithShape(t, q, shape, (c) => {
    if (c.parent() === rig.rearBody || c.parent() === rig.front.body) return true;
    if (!c.parent()?.isFixed() && c.parent()) return true;
    if (c.shapeType() === RAPIER.ShapeType.Cuboid && c.translation().y < 0) return true; // the ground
    const k = c.contactShape(shape, t, q, 0);
    if (k) depth = Math.max(depth, -k.distance);
    return true;
  });
  return depth;
}

function wall(world: RAPIER.World, x: number, z: number, hx: number, hz: number, hy = 2) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, hy, z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.3), b);
}

const kmh = (v: number) => (v * 3.6).toFixed(1);
const rows: string[][] = [];
const out = (scn: string, mode: string, ...kv: string[]) => rows.push([scn, mode, ...kv]);

async function main() {
  await initRapier();
  for (const mode of ['joint', 'kinematic'] as const) {
    // 1. straight line: top speed, then nitro
    {
      const r = make(mode);
      run(r, idle, 1);
      let t = 0;
      let t60 = NaN;
      run(r, { ...idle, throttle: 1 }, 20, (s) => {
        t = s;
        if (Number.isNaN(t60) && r.front.speed > 60 / 3.6) t60 = s;
      });
      const top = r.front.speed;
      run(r, { ...idle, throttle: 1, boost: true }, 1.5);
      out('straight', mode, `top ${kmh(top)} km/h`, `0-60 ${t60.toFixed(1)} s`, `nitro ${kmh(r.front.speed)} km/h`, `bend ${((r.bend() * 180) / Math.PI).toFixed(2)} deg`, `sep ${r.separation().toFixed(3)}`, `y-drift z ${r.front.body.translation().z.toFixed(2)}`);
    }
    // 2. full lock at 15 m/s
    {
      const r = make(mode);
      run(r, idle, 1);
      run(r, { ...idle, throttle: 1 }, 5);
      let maxBend = 0;
      let maxSep = 0;
      let flip = 1;
      let osc = 0;
      let prev = 0;
      let sw = 0;
      run(r, { throttle: 0.5, steer: 1, handbrake: false }, 8, () => {
        maxBend = Math.max(maxBend, Math.abs(r.bend()));
        maxSep = Math.max(maxSep, r.separation());
        flip = Math.min(flip, upY(r.front.body), upY(r.rearBody));
        const w = r.front.body.angvel().y;
        osc = Math.max(osc, Math.abs(w - prev));
        prev = w;
        sw = Math.max(sw, Math.abs(r.rearBody.angvel().y - w));
      });
      out('full lock', mode, `bend max ${((maxBend * 180) / Math.PI).toFixed(1)} deg`, `sep max ${maxSep.toFixed(3)}`, `min up ${flip.toFixed(2)}`, `yaw-rate step max ${osc.toFixed(3)}`, `speed ${kmh(r.front.speed)}`, `finite ${finite(r)}`);
    }
    // 3. handbrake drift
    {
      const r = make(mode);
      run(r, idle, 1);
      run(r, { ...idle, throttle: 1 }, 5);
      let maxSlip = 0;
      let maxBend = 0;
      let minUp = 1;
      run(r, { throttle: 1, steer: 1, handbrake: true }, 2, () => {
        maxSlip = Math.max(maxSlip, Math.abs(r.front.slipAngle));
        maxBend = Math.max(maxBend, Math.abs(r.bend()));
        minUp = Math.min(minUp, upY(r.front.body), upY(r.rearBody));
      });
      out('drift', mode, `slip max ${((maxSlip * 180) / Math.PI).toFixed(0)} deg`, `bend max ${((maxBend * 180) / Math.PI).toFixed(0)} deg`, `min up ${minUp.toFixed(2)}`, `speed ${kmh(r.front.speed)}`);
    }
    // 4. crash into a static wall at 25 m/s
    {
      const wx = 80;
      const r = make(mode, (w) => wall(w, wx, 0, 0.5, 20));
      run(r, idle, 1);
      for (const b of r.front.bodies) b.setLinvel({ x: 25, y: 0, z: 0 }, true);
      if (mode === 'kinematic') run(r, idle, 0.02);
      let maxSep = 0;
      let maxDepth = 0;
      let maxBend = 0;
      let nan = false;
      run(r, { ...idle, throttle: 1 }, 6, () => {
        maxSep = Math.max(maxSep, r.separation());
        maxBend = Math.max(maxBend, Math.abs(r.bend()));
        maxDepth = Math.max(maxDepth, overlapDepth(r, { x: art.rearLength / 2, y: preset.body.height / 2, z: preset.body.width / 2 }));
        if (!finite(r)) nan = true;
      });
      const fx = r.front.body.translation().x + Lf / 2;
      out('crash 25 m/s', mode, `front nose x ${fx.toFixed(2)} (wall face ${wx - 0.5})`, `sep max ${maxSep.toFixed(3)}`, `rear in wall max ${maxDepth.toFixed(2)} m`, `bend max ${((maxBend * 180) / Math.PI).toFixed(0)} deg`, `NaN ${nan}`, `rear x ${r.rearBody.translation().x.toFixed(1)}`);
    }
    // 5. speed humps (0.22 high, 3 m) at 12 m/s, front and rear axle both cross
    {
      const r = make(mode, (w) => {
        for (const x of [60, 80]) {
          const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.04, 0));
          w.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 0.12, 6).setFriction(0.5), b);
        }
      });
      run(r, idle, 1);
      let maxVy = 0;
      let minUp = 1;
      let maxSep = 0;
      let airborne = 0;
      run(r, (t) => ({ ...idle, throttle: r.front.speed < 12 ? 0.7 : 0.1 }), 9, () => {
        maxVy = Math.max(maxVy, Math.abs(r.front.body.linvel().y), Math.abs(r.rearBody.linvel().y));
        minUp = Math.min(minUp, upY(r.front.body), upY(r.rearBody));
        maxSep = Math.max(maxSep, r.separation());
        if (r.front.wheelsOnGround === 0) airborne += PHYSICS_STEP;
      });
      out('humps', mode, `max vy ${maxVy.toFixed(2)} m/s`, `min up ${minUp.toFixed(2)}`, `sep max ${maxSep.toFixed(3)}`, `no wheels ${airborne.toFixed(2)} s`, `x ${r.front.body.translation().x.toFixed(0)}`);
    }
    // 6. ramp (12 deg wedge up then flat deck) at 15 m/s
    {
      const r = make(mode, (w) => {
        const a = (12 * Math.PI) / 180;
        const len = 20;
        const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(60 + (len / 2) * Math.cos(a), (len / 2) * Math.sin(a) - 0.2, 0).setRotation({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) }));
        w.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.2, 8).setFriction(0.8), b);
        const d = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(60 + len * Math.cos(a) + 40, len * Math.sin(a) - 0.2, 0));
        w.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.2, 8).setFriction(0.8), d);
      });
      run(r, idle, 1);
      let maxVy = 0;
      let minUp = 1;
      let maxSep = 0;
      let maxPitchRel = 0;
      run(r, (t) => ({ ...idle, throttle: r.front.speed < 15 ? 0.8 : 0.2 }), 10, () => {
        maxVy = Math.max(maxVy, Math.abs(r.front.body.linvel().y));
        minUp = Math.min(minUp, upY(r.front.body), upY(r.rearBody));
        maxSep = Math.max(maxSep, r.separation());
        const qf = r.front.body.rotation();
        const qr = r.rearBody.rotation();
        const pf = Math.asin(Math.max(-1, Math.min(1, 2 * (qf.x * qf.y + qf.w * qf.z))));
        const pr = Math.asin(Math.max(-1, Math.min(1, 2 * (qr.x * qr.y + qr.w * qr.z))));
        maxPitchRel = Math.max(maxPitchRel, Math.abs(pf - pr));
      });
      out('ramp 12 deg', mode, `climbed y ${r.front.body.translation().y.toFixed(1)}`, `x ${r.front.body.translation().x.toFixed(0)}`, `max vy ${maxVy.toFixed(2)}`, `min up ${minUp.toFixed(2)}`, `sep max ${maxSep.toFixed(3)}`, `pitch between sections max ${((maxPitchRel * 180) / Math.PI).toFixed(1)} deg`);
    }
    // 7. hit a dynamic box (1500 kg) at 15 m/s
    {
      const r = make(mode);
      const box = r.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(40, 0.8, 0));
      r.world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.8, 1).setMass(1500), box);
      run(r, idle, 1);
      let maxSep = 0;
      run(r, (t) => ({ ...idle, throttle: r.front.speed < 15 ? 0.8 : 0.1 }), 6, () => {
        maxSep = Math.max(maxSep, r.separation());
      });
      out('dynamic box', mode, `box x ${box.translation().x.toFixed(1)}`, `box speed ${kmh(Math.hypot(box.linvel().x, box.linvel().z))}`, `bus speed ${kmh(r.front.speed)}`, `sep max ${maxSep.toFixed(3)}`);
    }
    // 8. reverse at full lock (jack-knife test) and a fast hard swerve
    {
      const r = make(mode);
      run(r, idle, 1);
      run(r, { ...idle, throttle: -1, steer: 1 }, 8);
      out('reverse full lock', mode, `bend ${((r.bend() * 180) / Math.PI).toFixed(1)} deg (limit ${art.yawLimitDeg})`, `min up ${Math.min(upY(r.front.body), upY(r.rearBody)).toFixed(2)}`, `sep ${r.separation().toFixed(3)}`);
      const s = make(mode);
      run(s, idle, 1);
      run(s, { ...idle, throttle: 1 }, 8);
      let maxBend = 0;
      let minUp = 1;
      run(s, (t) => ({ throttle: 1, steer: Math.sin(t * 5) > 0 ? 1 : -1, handbrake: false }), 5, () => {
        maxBend = Math.max(maxBend, Math.abs(s.bend()));
        minUp = Math.min(minUp, upY(s.front.body), upY(s.rearBody));
      });
      out('swerve at speed', mode, `bend max ${((maxBend * 180) / Math.PI).toFixed(0)} deg`, `min up ${minUp.toFixed(2)}`, `speed ${kmh(s.front.speed)}`);
    }
    // 10. reverse into a wall 14 m behind the bus: does the tail stop at it?
    {
      const r = make(mode, (w) => wall(w, -14, 0, 0.5, 20));
      run(r, idle, 1);
      let d = 0;
      run(r, { ...idle, throttle: -1 }, 6, () => {
        d = Math.max(d, overlapDepth(r, { x: art.rearLength / 2, y: preset.body.height / 2, z: preset.body.width / 2 }));
      });
      out('reverse into wall', mode, `tail in wall max ${d.toFixed(2)} m`, `tail x ${(r.rearBody.translation().x - art.rearLength / 2).toFixed(2)} (wall face -13.5)`, `front x ${r.front.body.translation().x.toFixed(2)}`);
    }
    // 9. 90-degree corner next to a wall: does the tail clip it? Wall on the inside of the bend.
    {
      const r = make(mode, (w) => wall(w, 40, 12, 40, 0.3, 2.5));
      run(r, idle, 1);
      let d = 0;
      run(r, (t) => ({ throttle: r.front.speed < 6 ? 0.5 : 0, steer: 0.5, handbrake: false }), 7, () => {
        d = Math.max(d, overlapDepth(r, { x: art.rearLength / 2, y: preset.body.height / 2, z: preset.body.width / 2 }));
      });
      out('tail vs inside wall', mode, `rear in wall max ${d.toFixed(2)} m`, `heading ${((r.front.heading * 180) / Math.PI).toFixed(0)} deg`);
    }
  }
  for (const r of rows) console.log(r.join(' | '));
}

main();
