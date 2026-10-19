/**
 * How each vehicle handles a soaked road (`preset.wet`): slide in a hard turn at speed, handbrake
 * drift and braking distance, dry vs soaked. `npx tsx tools/wet-grip.ts [id] [rear front]` (caps
 * override the preset's, for tuning).
 */
import { addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { VEHICLES } from '../src/vehicle/buses';
import { WET_GRIP } from '../src/gameplay/weather';
import type { DriveInput } from '../src/core/input';

await initRapier();
const [only, rear, front] = process.argv.slice(2);
for (const { preset } of VEHICLES) {
  if (only && only !== preset.id) continue;
  const p = rear ? { ...preset, wet: { rear: Number(rear), front: Number(front ?? rear) } } : preset;
  const row: string[] = [];
  for (const grip of [1, WET_GRIP]) {
    const mk = () => {
      const world = createWorld();
      addGround(world, 3000);
      const bus = new BusPhysics(world, p, { x: 0, y: 3, z: 0, heading: 0 });
      bus.grip = grip;
      const run = (inp: DriveInput, s: number, fn?: () => void) => {
        for (let t = 0; t < s; t += PHYSICS_STEP) {
          bus.update(inp, PHYSICS_STEP);
          world.step();
          fn?.();
        }
      };
      run({ throttle: 0, steer: 0, handbrake: false }, 1);
      run({ throttle: 1, steer: 0, handbrake: false }, 4);
      return { bus, run };
    };
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0).padStart(3);
    let { bus, run } = mk();
    let turn = 0;
    run({ throttle: 0.6, steer: 1, handbrake: false }, 1.5, () => (turn = Math.max(turn, Math.abs(bus.slipAngle))));
    const heading = bus.heading;
    ({ bus, run } = mk());
    let hb = 0;
    run({ throttle: 1, steer: 1, handbrake: true }, 1.5, () => (hb = Math.max(hb, Math.abs(bus.slipAngle))));
    ({ bus, run } = mk());
    const x0 = bus.body.translation().x;
    for (let t = 0; bus.speed > 1 && t < 10; t += PHYSICS_STEP) run({ throttle: -1, steer: 0, handbrake: false }, PHYSICS_STEP);
    row.push(`${grip === 1 ? 'dry' : 'wet'}: turn slip ${deg(turn)}° heading ${heading.toFixed(2)}, drift ${deg(hb)}°, brakes in ${(bus.body.translation().x - x0).toFixed(1)} m`);
  }
  console.log(preset.id.padEnd(16), row.join(' | '));
}
