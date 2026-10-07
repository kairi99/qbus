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
const G2 = 'Puente del Guambra, southbound: the AE86 at 88 km/h stops dead at (-620.3, 313.0) where Av. Patria eastbound\'s down-ramp deck (#358) overlaps the westbound up-ramp (#401) 0.2–0.35 m higher, just before their joint with the bridge (deck edge hit from below, then railing contacts)';
const A1 = 'Av. 10 de Agosto cut (south edge), e276: AE86 at 87 km/h hits a wall at (-195.4, -791.3) (Δv 20 m/s, normal (-0.39, 0.10, 0.91)) and stays stuck';
const Q1 = '12 de Octubre N→S turn through its tunnel onto Queseras (e585→e524): the link is still ~1 m down in its cut where it reaches node 257\'s paved area (UP-007; leveling it there needs a 16% climb right out of the crossing, a V the bus high-centers on), so the interparroquial high-centers turning out at (-68.5, 723.5); buseta and AE86 hit a wall at (-103.0, 761.4) / (-127.6, 776.2) on 12 de Octubre (e277) running along the ramp\'s cut';
const Q2 = '12 de Octubre S→N link to Av. Patria (e588→e160): interparroquial (12.5 m) jams on the bend near the top against the low retaining wall at (-16.6, 747.6) between the ramp and Ladrón de Guevara alongside (1.1 m of ground between the two asphalts: no room to widen the cut); shorter vehicles pass';
const S2 = 'Cut at (-820, 774) (sin nombre e681→e195): on the sharp OSM kink at (-829.2, 773.8) the interparroquial\'s front corner hits the outer tunnel wall at (-835.7, 774.4) (Δv 8.6 m/s) and stalls; the cut is already widened there (BEND_SWEEP)';
known({
  'drive bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e895] | ae86 @ 90 km/h': G2,
  'drive cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e276→e276] | ae86 @ 90 km/h': A1,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e585→e524] | interparroquial @ 35 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e585→e524] | interparroquial @ 70 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e585→e524] | buseta @ 60 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e585→e524] | ae86 @ 90 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e588→e160] | interparroquial @ 35 km/h': Q2,
  'drive cut Av. 12 de Octubre @(-43,733): sin nombre [e588→e160] | interparroquial @ 70 km/h': Q2,
  'drive cut sin nombre @(-820,774): sin nombre [e681→e195] | interparroquial @ 35 km/h': S2,
  'drive cut sin nombre @(-820,774): sin nombre [e681→e195] | interparroquial @ 70 km/h': S2,
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
