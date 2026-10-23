/**
 * Drive-through: the real physics vehicle, driven by a simple autopilot along each legal passage
 * through every underpass and bridge, slow and fast, bus and car. See README.md.
 */
import { beforeAll, describe, expect } from 'vitest';
import { busById } from '../../src/vehicle/buses';
import { type DriveResult, describe as explain, driveRoute } from './drive';
import { check, known } from './known';
import { type Built, buildAll, cityAndCatalog } from './setup';
import { DRIVE } from './thresholds';

// Observed on the harness's first run (2026-10-06, La Mariscal at DEFAULT_HILLS), updated after
// the collision fixes of 2026-10-07 (what's left). Delete an entry once its bug is fixed (the
// it.fails turns red to tell you).
const S2 = 'Cut at (-820, 774) (sin nombre e694→e195): the OSM line turns 65 degrees in about 10 m at (-829.2, 773.8), a tighter bend than a 12.5 m interparroquial can take, and the cut is boxed in there (Av. 10 de Agosto runs over its east lane, another carriageway of it along its west wall): the front corner hits the outer wall at (-827.8, 771.1) (Δv 2.8 at 35, 8.3 at 70 km/h since the walls went frictionless 2026-10-23: no stall any more, stuck 0–0.3 s instead of 2.8). Easing the line to a minimum radius, wider bend room and moving the streets all just moved the hit to the next wall (see README 2026-10-23)';
known({
  'drive cut sin nombre @(-820,774): sin nombre [e694→e195] | interparroquial @ 35 km/h': S2,
  'drive cut sin nombre @(-820,774): sin nombre [e694→e195] | interparroquial @ 70 km/h': S2,
});

const base = cityAndCatalog();
let built: Built;
beforeAll(async () => {
  built = await buildAll(base);
}, 120_000);

export function driveProblems(r: DriveResult): string[] {
  const out: string[] = [];
  if (!r.reached) out.push(`did not reach the far end in ${r.budget.toFixed(0)} s`);
  if (r.stuck > DRIVE.STUCK_S) out.push(`stuck ${r.stuck.toFixed(1)} s`);
  if (r.airborne > DRIVE.AIRBORNE_S) out.push(`airborne ${r.airborne.toFixed(2)} s`);
  if (r.maxLateralImpulse / r.mass > DRIVE.WALL_DV) out.push(`wall shove Δv ${(r.maxLateralImpulse / r.mass).toFixed(2)} m/s`);
  if (r.maxRise > DRIVE.RISE_M) out.push(`rose ${r.maxRise.toFixed(2)} m over the road`);
  if (r.maxSink < -DRIVE.SINK_M) out.push(`sank ${(-r.maxSink).toFixed(2)} m into the road`);
  if (r.fellThrough) out.push('fell through the road');
  if (r.maxOffPath > DRIVE.OFF_PATH_M) out.push(`knocked ${r.maxOffPath.toFixed(1)} m off its lane`);
  return out;
}

for (const s of base.structures.filter((x) => x.passages.length))
  describe(s.id, () => {
    for (const p of s.passages)
      for (const [vehicle, kmh] of DRIVE.RUNS)
        check(`drive ${p.id} | ${vehicle} @ ${kmh} km/h`, () => {
          const r = driveRoute(built.world, built.city, built.graph, busById(vehicle), p.route, {
            kmh,
            startS: p.startS,
            slack: DRIVE.SLACK_S,
            passage: { from: p.first, to: p.first + p.edges.length },
          });
          expect(driveProblems(r).join('; ') || 'ok', explain(r)).toBe('ok');
        });
  });
