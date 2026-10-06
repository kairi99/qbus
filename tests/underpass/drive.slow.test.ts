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

// Observed on the harness's first run (2026-10-06, La Mariscal at DEFAULT_HILLS). Delete an entry
// once its bug is fixed (the it.fails turns red to tell you).
const G1 = 'Puente del Guambra, northbound up-ramp: chassis drops 0.66–0.82 m into the road at about (-705, 220), where the deck ramp leaves the junction; the AE86 at 86 km/h stops dead there and stays stuck';
const G2 = 'Puente del Guambra, southbound: buseta shoved sideways (Δv 1.1 m/s) at (-692.6, 213.1) on the down-ramp; AE86 at 88 km/h gets stuck at (-620.5, 313.6) on the deck ramp';
const A1 = 'Av. 10 de Agosto cut (south edge), e276: AE86 at 87 km/h hits a wall at (-195.4, -791.3) (Δv 20 m/s, normal (-0.39, 0.10, 0.91)) and stays stuck';
const A2 = 'Av. 10 de Agosto cut (south edge), e564 up-ramp out of the cut: the bus starts wedged at (-195.5, -832.7) (a wall/ground stands on lane 0 here: ground at 20.8 m 1 m left of the lane, road at 17.6 m) and never moves; buseta escapes after 3.7 s of grinding';
const Q1 = '12 de Octubre N→S turn through its tunnel onto Queseras (e585→e524): wall at (-57.2, 713.5) (normal (0.97, 0, 0.25)) stops the interparroquial; a ~1 m bump at (-68.3, 724.7) lifts every vehicle (AE86 +1.14 m); buseta hits a wall at (-126.0, 775.3)';
const Q2 = '12 de Octubre S→N link to Av. Patria (e588→e160): interparroquial (12.5 m) jams against a wall at (-21.9, 750.8) (normal (-0.98, 0, -0.22)); shorter vehicles pass';
const Q3 = '12 de Octubre main cut S→N (e589→e241): AE86 at 90 km/h gets stuck at (0.2, 713.0) near the north mouth after a 0.12 s hop at (-69.0, 753.3)';
const S1 = 'Cut under Av. Patria by the Guambra (sin nombre e197→e199): interparroquial high-centers/stops at (-660, 323.7) in the cut (chassis on the floor, normal down); at 70 km/h also a wall shove Δv 14.7 m/s at (-617.9, 325.0)';
const S2 = 'Cut at (-820, 774) (sin nombre e681→e195): interparroquial hits a wall at (-818.4, 768.0) (Δv 8 m/s, normal (0.85, 0, 0.53)) and stalls';
const S3 = 'Cut at the west edge (-876, -220), e516 starting down in the cut: interparroquial spawns rubbing a sloped wall at (-854.2, -272.7) (normal (-0.77, 0.61, -0.21)) and takes 4.8 s to pull away';
known({
  'drive bridge Av. Patria @(-658,290): Av. Patria [e167→e517] | interparroquial @ 35 km/h': G1,
  'drive bridge Av. Patria @(-658,290): Av. Patria [e167→e517] | interparroquial @ 70 km/h': G1,
  'drive bridge Av. Patria @(-658,290): Av. Patria [e167→e517] | buseta @ 60 km/h': G1,
  'drive bridge Av. Patria @(-658,290): Av. Patria [e167→e517] | ae86 @ 90 km/h': G1,
  'drive bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e895] | buseta @ 60 km/h': G2,
  'drive bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e895] | ae86 @ 90 km/h': G2,
  'drive cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e276→e276] | ae86 @ 90 km/h': A1,
  'drive cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e564→e564] | interparroquial @ 35 km/h': A2,
  'drive cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e564→e564] | interparroquial @ 70 km/h': A2,
  'drive cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e564→e564] | buseta @ 60 km/h': A2,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e585→e524] | interparroquial @ 35 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e585→e524] | interparroquial @ 70 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e585→e524] | buseta @ 60 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e585→e524] | ae86 @ 90 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e588→e160] | interparroquial @ 35 km/h': Q2,
  'drive cut Av. 12 de Octubre @(-42,734): sin nombre [e588→e160] | interparroquial @ 70 km/h': Q2,
  'drive cut Av. 12 de Octubre @(-42,734): Av. 12 de Octubre [e589→e241] | ae86 @ 90 km/h': Q3,
  'drive cut sin nombre @(-652,321): sin nombre [e197→e199] | interparroquial @ 35 km/h': S1,
  'drive cut sin nombre @(-652,321): sin nombre [e197→e199] | interparroquial @ 70 km/h': S1,
  'drive cut sin nombre @(-820,774): sin nombre [e681→e195] | interparroquial @ 35 km/h': S2,
  'drive cut sin nombre @(-820,774): sin nombre [e681→e195] | interparroquial @ 70 km/h': S2,
  'drive cut sin nombre @(-876,-220): sin nombre [e516→e516] | interparroquial @ 35 km/h': S3,
  'drive cut sin nombre @(-876,-220): sin nombre [e516→e516] | interparroquial @ 70 km/h': S3,
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

for (const s of base.structures)
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
