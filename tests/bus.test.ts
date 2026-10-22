import { beforeAll, describe, expect, it } from 'vitest';
import { RAPIER, addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { DriveInput } from '../src/core/input';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import interparroquial from '../data/buses/interparroquial.json';
import buseta from '../data/buses/buseta.json';
import ae86 from '../data/buses/ae86.json';
import articulado from '../data/buses/articulado.json';
import gusanito from '../data/buses/gusanito.json';

const idle: DriveInput = { throttle: 0, steer: 0, handbrake: false };

describe.each([popular, interparroquial, buseta, ae86, articulado, gusanito] as BusPreset[])('BusPhysics ($name)', (preset) => {
function setup() {
  const world = createWorld();
  // Big enough that the fastest vehicle can't drive off it during a test.
  addGround(world, 3000);
  const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
  const run = (input: DriveInput, seconds: number) => {
    for (let t = 0; t < seconds; t += PHYSICS_STEP) {
      bus.update(input, PHYSICS_STEP);
      world.step();
    }
  };
  return { world, bus, run };
}

  beforeAll(() => initRapier());

  it('settles on its wheels', () => {
    const { bus, run } = setup();
    run(idle, 3);
    expect(bus.wheelsOnGround).toBe(bus.wheelCount);
    const y = bus.body.translation().y;
    expect(y).toBeGreaterThan(preset.body.height / 2);
    expect(y).toBeLessThan(preset.body.height / 2 + 1.2);
  });

  it('accelerates forward along +X to a brisk arcade speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 5);
    const kmh = bus.speed * 3.6;
    expect(kmh).toBeGreaterThan(45);
    expect(kmh).toBeLessThanOrEqual(preset.topSpeedKmh + 5);
    expect(bus.body.translation().x).toBeGreaterThan(20);
  });

  it('turns left when steering left', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 2);
    run({ ...idle, throttle: 0.6, steer: -1 }, 1.5);
    expect(bus.heading).toBeGreaterThan(0.3);
  });

  it('brakes to a stop quickly (then holding brake reverses)', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    let t = 0;
    while (bus.speed > 1 && t < 10) {
      run({ ...idle, throttle: -1 }, PHYSICS_STEP);
      t += PHYSICS_STEP;
    }
    expect(t).toBeLessThan(3);
    run({ ...idle, throttle: -1 }, 2);
    expect(bus.speed).toBeLessThan(-1);
  });

  it('stays upright through a hard turn at speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    run({ ...idle, throttle: 1, steer: 1 }, 3);
    const q = bus.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY).toBeGreaterThan(0.5);
  });

  describe('handbrake drift', () => {
    /** Angle between where the bus points and where it moves, degrees. */
    const slipDeg = (bus: BusPhysics) => {
      const v = bus.body.linvel();
      const h = bus.heading;
      const fwd = v.x * Math.cos(h) - v.z * Math.sin(h);
      const side = v.x * Math.sin(h) + v.z * Math.cos(h);
      return (Math.atan2(Math.abs(side), Math.abs(fwd)) * 180) / Math.PI;
    };
    const driftFrom60 = (throttle: number) => {
      const { bus, run } = setup();
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      let maxSlip = 0;
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) {
        run({ throttle, steer: 1, handbrake: true }, PHYSICS_STEP);
        maxSlip = Math.max(maxSlip, slipDeg(bus));
      }
      return { bus, run, maxSlip };
    };

    it('a normal hard turn barely slides', () => {
      const { bus, run } = setup();
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      let maxSlip = 0;
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) {
        run({ throttle: 0.5, steer: 1, handbrake: false }, PHYSICS_STEP);
        maxSlip = Math.max(maxSlip, slipDeg(bus));
      }
      expect(maxSlip).toBeLessThan(12);
    });

    for (const throttle of [0, 1]) {
      it(`kicks the tail out to a visible drift without spinning (throttle ${throttle})`, () => {
        const { bus, maxSlip } = driftFrom60(throttle);
        expect(maxSlip).toBeGreaterThan(25);
        expect(maxSlip).toBeLessThan(55);
        expect(bus.speed).toBeGreaterThan(3); // still rolling forward, not spun around
      });
    }

    it('regains grip after the handbrake is released', () => {
      const { bus, run } = driftFrom60(1);
      run({ throttle: 1, steer: 0, handbrake: false }, 2);
      expect(slipDeg(bus)).toBeLessThan(8);
      expect(bus.speed).toBeGreaterThan(5);
    });
  });

  it('reverses at a useful speed', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: -1 }, 4);
    expect(bus.speed * 3.6).toBeLessThan(-25);
    expect(bus.speed * 3.6).toBeGreaterThan(-(preset.reverseTopSpeedKmh + 5));
  });

  it('nitro gives a clear kick in 1.5 s, stays upright, and can pass top speed', () => {
    const plain = setup();
    const boosted = setup();
    for (const s of [plain, boosted]) {
      s.run(idle, 1);
      s.run({ ...idle, throttle: 1 }, 2);
    }
    plain.run({ ...idle, throttle: 1 }, 1.5);
    boosted.run({ ...idle, throttle: 1, boost: true }, 1.5);
    expect(boosted.bus.boosting).toBe(true);
    expect((boosted.bus.speed - plain.bus.speed) * 3.6).toBeGreaterThan(20);
    expect(boosted.bus.wheelsOnGround).toBeGreaterThanOrEqual(3);
    expect(Math.abs(boosted.bus.body.translation().z)).toBeLessThan(1);

    // Already flat out: nitro still pushes past top speed, but only up to the bonus.
    boosted.run({ ...idle, throttle: 1 }, 6);
    boosted.run({ ...idle, throttle: 1, boost: true }, 6);
    const kmh = boosted.bus.speed * 3.6;
    expect(kmh).toBeGreaterThan(preset.topSpeedKmh + 5);
    expect(kmh).toBeLessThanOrEqual(preset.topSpeedKmh + preset.nitro.topSpeedBonusKmh + 3);
  });

  it('slipstream pulls it past top speed (a little), only on throttle', () => {
    const plain = setup();
    const drafted = setup();
    for (const s of [plain, drafted]) s.run({ ...idle, throttle: 1 }, 12);
    drafted.bus.draft = 1;
    plain.run({ ...idle, throttle: 1 }, 6);
    drafted.run({ ...idle, throttle: 1 }, 6);
    const gain = (drafted.bus.speed - plain.bus.speed) * 3.6;
    expect(gain).toBeGreaterThan(3);
    expect(drafted.bus.speed * 3.6).toBeLessThanOrEqual(preset.topSpeedKmh + 14 + 2);
    // Off the throttle it gives nothing: both coast down alike.
    plain.run(idle, 2);
    drafted.run(idle, 2);
    expect(Math.abs(drafted.bus.speed - plain.bus.speed) * 3.6).toBeLessThan(gain + 1);
  });

  it('reset puts the bus back upright at spawn', () => {
    const { bus, run } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 3);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    expect(bus.body.translation().x).toBeCloseTo(10);
    expect(bus.heading).toBeCloseTo(Math.PI / 2);
  });
});

describe('articulated bus', () => {
  const preset = articulado as BusPreset;
  const art = preset.articulated!;
  const deg = (r: number) => (r * 180) / Math.PI;
  beforeAll(() => initRapier());

  function setup(walls?: (w: ReturnType<typeof createWorld>) => void) {
    const world = createWorld();
    addGround(world, 3000);
    walls?.(world);
    const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
    const rear = bus.rear!;
    /** Distance between the two hinge anchors in the world. */
    const separation = () => {
      const anchor = (b: typeof bus.body, x: number) => {
        const t = b.translation();
        const q = b.rotation();
        return { x: t.x + x * (1 - 2 * (q.y * q.y + q.z * q.z)), y: t.y + x * 2 * (q.x * q.y + q.w * q.z), z: t.z + x * 2 * (q.x * q.z - q.w * q.y) };
      };
      const a = anchor(bus.body, -(bus.frontLength / 2 + art.gap / 2));
      const b = anchor(rear.body, art.rearLength / 2 + art.gap / 2);
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    const run = (input: DriveInput, seconds: number, each?: () => void) => {
      for (let t = 0; t < seconds; t += PHYSICS_STEP) {
        bus.update(input, PHYSICS_STEP);
        world.step();
        each?.();
      }
    };
    return { world, bus, rear, run, separation };
  }

  it('is two bodies whose sections add up to the preset length', () => {
    const { bus } = setup();
    expect(bus.bodies).toHaveLength(2);
    expect(bus.colliders).toHaveLength(2);
    expect(bus.frontLength + art.gap + art.rearLength).toBeCloseTo(preset.body.length);
    expect(bus.wheelCount).toBe(6);
  });

  it('starts in line, settles on six wheels and drives straight', () => {
    const { bus, run } = setup();
    run(idle, 2);
    expect(bus.wheelsOnGround).toBe(6);
    run({ ...idle, throttle: 1 }, 6);
    expect(Math.abs(deg(bus.bend))).toBeLessThan(1);
    expect(Math.abs(bus.body.translation().z)).toBeLessThan(0.5);
    expect(bus.rear!.body.translation().x).toBeLessThan(bus.body.translation().x - preset.body.length / 2);
  });

  it('bends in a turn, with the tail cutting inside, and straightens out again', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    let max = 0;
    run({ throttle: 0.5, steer: -1, handbrake: false }, 4, () => (max = Math.max(max, Math.abs(bus.bend))));
    expect(deg(max)).toBeGreaterThan(8);
    expect(deg(max)).toBeLessThan(art.yawLimitDeg);
    run({ throttle: 0.5, steer: 0, handbrake: false }, 6);
    expect(Math.abs(deg(bus.bend))).toBeLessThan(3);
  });

  it('never jack-knifes: reversing on full lock stops at the yaw limit, upright, joint closed', () => {
    const { bus, run, separation } = setup();
    run(idle, 1);
    let maxBend = 0;
    let maxSep = 0;
    let minUp = 1;
    run({ ...idle, throttle: -1, steer: 1 }, 10, () => {
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
      maxSep = Math.max(maxSep, separation());
      for (const b of bus.bodies) {
        const q = b.rotation();
        minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
    });
    expect(deg(maxBend)).toBeLessThan(art.yawLimitDeg + 6);
    expect(maxSep).toBeLessThan(0.1);
    expect(minUp).toBeGreaterThan(0.9);
  });

  it('holds together through hard swerves at full speed', () => {
    const { bus, run, separation } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 10);
    let maxBend = 0;
    let maxSep = 0;
    let t = 0;
    for (let k = 0; k < 5 * 60; k++) {
      t += PHYSICS_STEP;
      run({ throttle: 1, steer: Math.sin(t * 5) > 0 ? 1 : -1, handbrake: false }, PHYSICS_STEP);
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
      maxSep = Math.max(maxSep, separation());
    }
    expect(deg(maxBend)).toBeLessThan(art.yawLimitDeg + 6);
    expect(maxSep).toBeLessThan(0.1);
  });

  it('joint holds through a 25 m/s crash into a wall, and the tail stops at a wall behind', () => {
    const wall = (w: ReturnType<typeof createWorld>, x: number) => {
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 2, 0));
      w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 20), b);
    };
    const crash = setup((w) => wall(w, 80));
    crash.run(idle, 1);
    for (const b of crash.bus.bodies) b.setLinvel({ x: 25, y: 0, z: 0 }, true);
    let maxSep = 0;
    crash.run({ ...idle, throttle: 1 }, 5, () => (maxSep = Math.max(maxSep, crash.separation())));
    expect(maxSep).toBeLessThan(0.1);
    expect(crash.bus.body.translation().x + crash.bus.frontLength / 2).toBeLessThan(79.6);
    for (const b of crash.bus.bodies) expect(Number.isFinite(b.translation().x + b.translation().y)).toBe(true);

    const back = setup((w) => wall(w, -14));
    back.run(idle, 1);
    back.run({ ...idle, throttle: -1 }, 6);
    expect(back.rear.body.translation().x - art.rearLength / 2).toBeGreaterThan(-13.5 - 0.15);
  });

  it('crosses speed humps and a ramp without leaving the road or flipping', () => {
    const { bus, run } = setup((w) => {
      for (const x of [50, 70]) {
        const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.04, 0));
        w.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 0.12, 6), b);
      }
    });
    run(idle, 1);
    let minUp = 1;
    let airborne = 0;
    run({ ...idle, throttle: 0.4 }, 12, () => {
      for (const b of bus.bodies) {
        const q = b.rotation();
        minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
      if (bus.wheelsOnGround === 0) airborne += PHYSICS_STEP;
    });
    expect(bus.body.translation().x).toBeGreaterThan(90);
    expect(minUp).toBeGreaterThan(0.95);
    expect(airborne).toBe(0);
  });

  it('a handbrake drift scores: front-section slip over 20 degrees for a second, no jack-knife, recovers', () => {
    const { bus, run } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 5);
    expect(bus.speed * 3.6).toBeGreaterThan(40);
    let above = 0;
    let maxBend = 0;
    run({ throttle: 1, steer: 1, handbrake: true }, 2, () => {
      if (Math.abs(bus.slipAngle) > (20 * Math.PI) / 180) above += PHYSICS_STEP;
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
    });
    expect(above).toBeGreaterThanOrEqual(1);
    expect(deg(maxBend)).toBeLessThan(art.yawLimitDeg);
    run({ throttle: 1, steer: 0, handbrake: false }, 3);
    expect(Math.abs(bus.slipAngle)).toBeLessThan(0.15);
    expect(Math.abs(deg(bus.bend))).toBeLessThan(5);
    expect(bus.speed).toBeGreaterThan(5);
  });

  it('reset puts both sections upright and in line, centered on the spawn', () => {
    const { bus, run } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 4);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    const c = bus.position();
    expect(c.x).toBeCloseTo(10, 1);
    expect(c.z).toBeCloseTo(5, 1);
    expect(bus.heading).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(bus.bend)).toBeLessThan(0.01);
    // Facing +Z... heading pi/2 points to -Z: the tail is toward +Z.
    expect(bus.rear!.body.translation().z).toBeGreaterThan(bus.body.translation().z + 8);
  });
});

describe('gusanito (a train of trailers)', () => {
  const preset = gusanito as BusPreset;
  const art = preset.articulated!;
  const n = art.sections!;
  const deg = (r: number) => (r * 180) / Math.PI;
  beforeAll(() => initRapier());

  function setup(walls?: (w: ReturnType<typeof createWorld>) => void) {
    const world = createWorld();
    addGround(world, 3000);
    walls?.(world);
    const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
    const anchor = (b: typeof bus.body, x: number) => {
      const t = b.translation();
      const q = b.rotation();
      return { x: t.x + x * (1 - 2 * (q.y * q.y + q.z * q.z)), y: t.y + x * 2 * (q.x * q.y + q.w * q.z), z: t.z + x * 2 * (q.x * q.z - q.w * q.y) };
    };
    /** Widest gap between any turntable's two anchors. */
    const separation = () => {
      let worst = 0;
      bus.rears.forEach((r, i) => {
        const ahead = i ? bus.rears[i - 1] : { body: bus.body, length: bus.frontLength };
        const a = anchor(ahead.body, -(ahead.length / 2 + art.gap / 2));
        const b = anchor(r.body, art.rearLength / 2 + art.gap / 2);
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      });
      return worst;
    };
    const maxBend = () => Math.max(...bus.rears.map((_, i) => Math.abs(bus.bendAt(i))));
    const minUp = () =>
      Math.min(
        ...bus.bodies.map((b) => {
          const q = b.rotation();
          return 1 - 2 * (q.x * q.x + q.z * q.z);
        }),
      );
    const run = (input: DriveInput, seconds: number, each?: () => void) => {
      for (let t = 0; t < seconds; t += PHYSICS_STEP) {
        bus.update(input, PHYSICS_STEP);
        world.step();
        each?.();
      }
    };
    return { world, bus, run, separation, maxBend, minUp };
  }

  it('is a head car and its wagons, adding up to the preset length', () => {
    const { bus } = setup();
    expect(bus.rears).toHaveLength(n);
    expect(bus.bodies).toHaveLength(n + 1);
    expect(bus.frontLength + n * (art.gap + art.rearLength)).toBeCloseTo(preset.body.length);
    expect(bus.wheelCount).toBe(4 + 2 * n);
    expect(bus.sections()).toHaveLength(n + 1);
  });

  it('settles on every wheel and drives straight, wagons in line behind', () => {
    const { bus, run, maxBend } = setup();
    run(idle, 2);
    expect(bus.wheelsOnGround).toBe(bus.wheelCount);
    run({ ...idle, throttle: 1 }, 6);
    expect(deg(maxBend())).toBeLessThan(1.5);
    const xs = bus.bodies.map((b) => b.translation().x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1] - art.rearLength);
    for (const b of bus.bodies) expect(Math.abs(b.translation().z)).toBeLessThan(0.5);
  });

  it('wags through a turn without folding past its limit, and straightens out again', () => {
    const { bus, run, maxBend, separation } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 4);
    let max = 0;
    let sep = 0;
    run({ throttle: 0.6, steer: -1, handbrake: false }, 4, () => ((max = Math.max(max, maxBend())), (sep = Math.max(sep, separation()))));
    expect(deg(max)).toBeGreaterThan(5);
    expect(deg(max)).toBeLessThan(art.yawLimitDeg + 6);
    expect(sep).toBeLessThan(0.1);
    run({ throttle: 0.6, steer: 0, handbrake: false }, 6);
    expect(deg(maxBend())).toBeLessThan(3);
  });

  it('backs up in line, even on full lock (the turntables pull straight), upright, joints closed', () => {
    const { bus, run, maxBend, separation, minUp } = setup();
    run(idle, 1);
    let bend = 0;
    let sep = 0;
    let up = 1;
    run({ ...idle, throttle: -1, steer: 1 }, 8, () => ((bend = Math.max(bend, maxBend())), (sep = Math.max(sep, separation())), (up = Math.min(up, minUp()))));
    expect(deg(bend)).toBeLessThan(20);
    expect(sep).toBeLessThan(0.1);
    expect(up).toBeGreaterThan(0.9);
    expect(bus.speed).toBeLessThan(-2);
  });

  it('holds together through hard swerves, a handbrake drift and its whiplash', () => {
    const { run, maxBend, separation, minUp } = setup();
    run(idle, 1);
    run({ ...idle, throttle: 1 }, 8);
    let bend = 0;
    let sep = 0;
    let up = 1;
    const watch = () => ((bend = Math.max(bend, maxBend())), (sep = Math.max(sep, separation())), (up = Math.min(up, minUp())));
    let t = 0;
    for (let k = 0; k < 5 * 60; k++) {
      t += PHYSICS_STEP;
      run({ throttle: 1, steer: Math.sin(t * 5) > 0 ? 1 : -1, handbrake: false }, PHYSICS_STEP, watch);
    }
    run({ throttle: 1, steer: 1, handbrake: true }, 1.5, watch);
    run({ throttle: 1, steer: 0, handbrake: false }, 4, watch);
    expect(deg(bend)).toBeLessThan(art.yawLimitDeg + 8);
    expect(sep).toBeLessThan(0.15);
    expect(up).toBeGreaterThan(0.6);
  });

  it('its wagons never collide with each other, but the last one stops at a wall behind', () => {
    const back = setup((w) => {
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-16, 2, 0));
      w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 20), b);
    });
    const groups = back.bus.colliders.map((c) => c.collisionGroups());
    expect(new Set(groups).size).toBe(1);
    // A section's membership isn't in its own filter: the train doesn't touch itself.
    expect((groups[0] >>> 16) & groups[0] & 0xffff).toBe(0);
    back.run(idle, 1);
    back.run({ ...idle, throttle: -1 }, 6);
    const last = back.bus.rears[n - 1].body.translation().x;
    expect(last - art.rearLength / 2).toBeGreaterThan(-15.5 - 0.15);
  });

  it('two gusanitos (a race of them) are solid to each other, and stay so driven into each other', () => {
    const world = createWorld();
    addGround(world, 3000);
    const a = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
    const b = new BusPhysics(world, preset, { x: 0, y: 3, z: 6, heading: 0 });
    const [ga, gb] = [a.colliders[0].collisionGroups(), b.colliders[0].collisionGroups()];
    const meets = (x: number, y: number) => ((x >>> 16) & y & 0xffff) !== 0 && ((y >>> 16) & x & 0xffff) !== 0;
    expect(meets(ga, gb)).toBe(true);
    // Each still ignores its own wagons.
    expect(meets(ga, ga)).toBe(false);
    // Steered into each other side by side for a few seconds: they never end up overlapping.
    let closest = Infinity;
    for (let t = 0; t < 4; t += PHYSICS_STEP) {
      a.update({ throttle: 0.6, steer: 0.5, handbrake: false }, PHYSICS_STEP);
      b.update({ throttle: 0.6, steer: -0.5, handbrake: false }, PHYSICS_STEP);
      world.step();
      closest = Math.min(closest, Math.abs(a.body.translation().z - b.body.translation().z));
    }
    expect(closest).toBeGreaterThan(preset.body.width * 0.8);
  });

  it('crosses speed humps without leaving the road or flipping', () => {
    const { bus, run, minUp } = setup((w) => {
      for (const x of [50, 70]) {
        const b = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.04, 0));
        w.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 0.12, 6), b);
      }
    });
    run(idle, 1);
    let up = 1;
    run({ ...idle, throttle: 0.4 }, 14, () => (up = Math.min(up, minUp())));
    expect(bus.rears[n - 1].body.translation().x).toBeGreaterThan(80);
    expect(up).toBeGreaterThan(0.93);
  });

  it('reset puts every section upright and in line, centered on the spawn', () => {
    const { bus, run, maxBend } = setup();
    run({ ...idle, throttle: 1, steer: 1 }, 4);
    bus.reset({ x: 10, y: 0, z: 5, heading: Math.PI / 2 });
    const c = bus.position();
    expect(c.x).toBeCloseTo(10, 1);
    expect(c.z).toBeCloseTo(5, 1);
    expect(maxBend()).toBeLessThan(0.01);
    expect(bus.rears[n - 1].body.translation().z).toBeGreaterThan(bus.body.translation().z + preset.body.length - bus.frontLength / 2 - art.rearLength / 2 - 0.1);
  });
});

describe('weather', () => {
  beforeAll(() => initRapier());
  const setup = (preset: BusPreset) => {
    const world = createWorld();
    addGround(world, 3000);
    const bus = new BusPhysics(world, preset, { x: 0, y: 3, z: 0, heading: 0 });
    const run = (input: DriveInput, seconds: number) => {
      for (let t = 0; t < seconds; t += PHYSICS_STEP) {
        bus.update(input, PHYSICS_STEP);
        world.step();
      }
    };
    return { bus, run };
  };

  const all = [popular, interparroquial, buseta, ae86, articulado, gusanito] as BusPreset[];
  it.each(all)('a soaked road brakes longer and (but for the articulado) slides in a hard turn, without spinning ($name)', (preset) => {
    const turn = (grip: number) => {
      const { bus, run } = setup(preset);
      bus.grip = grip;
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      let max = 0;
      for (let t = 0; t < 1.5; t += PHYSICS_STEP) {
        run({ throttle: 0.6, steer: 1, handbrake: false }, PHYSICS_STEP);
        max = Math.max(max, Math.abs(bus.slipAngle));
      }
      return (max * 180) / Math.PI;
    };
    const braking = (grip: number) => {
      const { bus, run } = setup(preset);
      bus.grip = grip;
      run(idle, 1);
      run({ ...idle, throttle: 1 }, 4);
      const x0 = bus.body.translation().x;
      for (let t = 0; bus.speed > 1 && t < 10; t += PHYSICS_STEP) run({ ...idle, throttle: -1 }, PHYSICS_STEP);
      return bus.body.translation().x - x0;
    };
    const [dry, wet] = [turn(1), turn(0.7)];
    if (preset.id !== 'articulado') expect(wet).toBeGreaterThan(dry + 3.5);
    expect(wet).toBeLessThan(30);
    expect(braking(0.7)).toBeGreaterThan(braking(1) * 1.25);
  });

  it.each([popular, gusanito] as BusPreset[])('floodwater slows the bus to a crawl, nitro still pushes through ($name)', (preset) => {
    const dry = setup(preset);
    const wet = setup(preset);
    const boosted = setup(preset);
    for (const s of [dry, wet, boosted]) {
      s.run(idle, 1);
      s.run({ ...idle, throttle: 1 }, 4);
      if (s !== dry) s.bus.wade = 0.6;
    }
    dry.run({ ...idle, throttle: 1 }, 4);
    wet.run({ ...idle, throttle: 1 }, 4);
    boosted.run({ ...idle, throttle: 1, boost: true }, 1.5);
    expect(wet.bus.speed * 3.6).toBeLessThan(25);
    expect(wet.bus.speed).toBeGreaterThan(1.5);
    expect(dry.bus.speed).toBeGreaterThan(wet.bus.speed * 2);
    expect(boosted.bus.speed).toBeGreaterThan(wet.bus.speed * 1.3);
  });

  it.each([popular, gusanito] as BusPreset[])('deep mud holds the bus to about 50 km/h, nitro pushes on, reset clears it ($name)', (preset) => {
    const dry = setup(preset);
    const mud = setup(preset);
    for (const s of [dry, mud]) {
      s.run(idle, 1);
      s.run({ ...idle, throttle: 1 }, 4);
    }
    mud.bus.mud = 1;
    dry.run({ ...idle, throttle: 1 }, 10);
    mud.run({ ...idle, throttle: 1 }, 10);
    const kmh = mud.bus.speed * 3.6;
    expect(kmh).toBeGreaterThan(30);
    expect(kmh).toBeLessThan(65);
    expect(dry.bus.speed).toBeGreaterThan(mud.bus.speed * 1.2);
    mud.run({ ...idle, throttle: 1, boost: true }, 1.5);
    expect(mud.bus.speed * 3.6).toBeGreaterThan(kmh);
    mud.bus.reset({ x: 0, y: 1, z: 0, heading: 0 });
    expect(mud.bus.mud).toBe(0);
  });
});
