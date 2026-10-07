import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { type CameraObstacles, CameraRig } from '../src/camera/cameraRig';
import { staticObstacles } from '../src/physics/cameraObstacles';
import { RAPIER, createWorld, initRapier } from '../src/physics/world';
import type { BusPhysics } from '../src/vehicle/bus';
import popular from '../data/buses/popular.json';

/** Minimal stand-in for the physics bus: at (10, 2, -5), heading 0.6 rad, cruising. */
function fakeBus(heading = 0.6): BusPhysics {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  return {
    body: { translation: () => ({ x: 10, y: 2, z: -5 }), rotation: () => ({ x: q.x, y: q.y, z: q.z, w: q.w }) },
    heading,
    speed: 12,
    preset: popular,
  } as unknown as BusPhysics;
}

describe('CameraRig look-back', () => {
  const bus = fakeBus();
  const fwd = new THREE.Vector3(Math.cos(bus.heading), 0, -Math.sin(bus.heading));
  const busPos = new THREE.Vector3(10, 2, -5);
  const view = (rig: CameraRig) => {
    const toCam = rig.camera.position.clone().sub(busPos);
    const dir = rig.camera.getWorldDirection(new THREE.Vector3());
    return { ahead: toCam.dot(fwd), facing: dir.dot(fwd) };
  };

  for (const mode of ['chase', 'cockpit'] as const) {
    it(`looks back at the bus from in front while held, then snaps back (${mode})`, () => {
      const rig = new CameraRig(new THREE.PerspectiveCamera());
      if (mode === 'cockpit') rig.toggle();
      rig.update(1 / 60, bus);
      const normal = view(rig);
      expect(normal.facing).toBeGreaterThan(0.8); // looking forward

      rig.update(1 / 60, bus, true);
      const back = view(rig);
      expect(back.ahead).toBeGreaterThan(8); // in front of the bus, immediately
      expect(back.facing).toBeLessThan(-0.8); // looking back along the bus

      rig.update(1 / 60, bus, false);
      expect(view(rig).facing).toBeGreaterThan(0.8);
      expect(view(rig).ahead).toBeCloseTo(normal.ahead, 1); // snapped, not gliding through the bus
    });
  }
});

describe('CameraRig chase camera vs the world', () => {
  const busPos = new THREE.Vector3(10, 2, -5);
  const fwd = (bus: BusPhysics) => new THREE.Vector3(Math.cos(bus.heading), 0, -Math.sin(bus.heading));
  /** A horizontal plane at `y` (a roof) and/or a vertical one `wall` meters behind the bus. */
  const planes = (roof: number | null, wall: number | null, bus: BusPhysics): CameraObstacles => {
    const f = fwd(bus);
    return {
      cast(ox, oy, oz, dx, dy, dz, max) {
        let t = max;
        if (roof !== null && dy > 1e-6 && oy < roof) t = Math.min(t, (roof - oy) / dy);
        if (wall !== null) {
          // Plane through busPos - f * wall, normal f: distance along the ray.
          const along = (ox - busPos.x) * f.x + (oz - busPos.z) * f.z + wall;
          const rate = dx * f.x + dz * f.z;
          if (rate < -1e-6 && along > 0) t = Math.min(t, along / -rate);
        }
        return t;
      },
    };
  };
  const run = (rig: CameraRig, bus: BusPhysics, frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i++) rig.update(dt, bus);
    return rig.camera.position.clone();
  };

  it('stays where it was with nothing in the way', () => {
    const bus = fakeBus();
    const free = run(new CameraRig(new THREE.PerspectiveCamera()), bus);
    const open = run(new CameraRig(new THREE.PerspectiveCamera(), planes(null, null, bus)), bus);
    expect(open.distanceTo(free)).toBeLessThan(1e-9);
    expect(free.y - busPos.y).toBeGreaterThan(6); // high behind the bus
  });

  it('comes down under a roof over the bus (a tunnel), still behind it', () => {
    const bus = fakeBus();
    const roof = busPos.y + 4.5;
    const rig = new CameraRig(new THREE.PerspectiveCamera(), planes(roof, null, bus));
    const cam = run(rig, bus, 30);
    expect(cam.y).toBeLessThanOrEqual(roof - 1);
    expect(busPos.clone().sub(cam).dot(fwd(bus))).toBeGreaterThan(10);
  });

  it('pulls in in front of a wall behind the bus, and eases back out without jumping', () => {
    const bus = fakeBus();
    const obs = { roof: null as number | null, wall: 6 as number | null };
    const rig = new CameraRig(new THREE.PerspectiveCamera(), { cast: (...a) => planes(obs.roof, obs.wall, bus).cast(...a) });
    const behind = (p: THREE.Vector3) => busPos.clone().sub(p).dot(fwd(bus));
    const cam = run(rig, bus, 30);
    expect(behind(cam)).toBeLessThan(6);
    expect(behind(cam)).toBeGreaterThan(1);
    obs.wall = null;
    let prev = cam;
    let maxStep = 0;
    for (let i = 0; i < 300; i++) {
      const p = run(rig, bus);
      maxStep = Math.max(maxStep, p.distanceTo(prev));
      prev = p;
    }
    expect(maxStep).toBeLessThan(0.3); // ~18 m/s at most at 60 fps: a glide, not a cut
    expect(behind(prev)).toBeGreaterThan(13);
  });

  it('in a real tunnel (Rapier), stays under the roof and between the walls; ignores poles', async () => {
    await initRapier();
    const world = createWorld();
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const bus = fakeBus(0);
    // Floor at y 0.5, roof 6 m over it, walls 5 m either side of the bus, along x.
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
      world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array([x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1]))!, fixed);
    box(-60, 60, 6.5, 7, -15, 5);
    box(-60, 60, 0, 7, -10.5, -10);
    box(-60, 60, 0, 7, 0, 0.5);
    // A lamp pole right behind the bus: not an obstacle for the camera.
    world.createCollider(RAPIER.ColliderDesc.cylinder(3, 0.1).setTranslation(4, 3, -5), fixed);
    world.step();
    const rig = new CameraRig(new THREE.PerspectiveCamera(), staticObstacles(world));
    const cam = run(rig, bus, 60);
    expect(cam.y).toBeLessThan(6.5 - 1);
    expect(cam.z).toBeGreaterThan(-10);
    expect(cam.z).toBeLessThan(0);
    expect(cam.x).toBeLessThan(10 - 10); // well behind, not pulled in to the pole
  });
});
