import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../src/camera/cameraRig';
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
