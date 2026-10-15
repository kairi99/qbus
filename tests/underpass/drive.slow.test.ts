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
const G2 = 'Puente del Guambra, southbound: since the AE86 rides higher (2026-10-15) it no longer stops dead under the overlapping ramp decks at (-620.3, 313.0), but at 89 km/h its side brushes the bridge railing hulls at (-658.3, 279.8) (0.9 m over the deck, 6 contact steps, Δv 15 m/s on the 520 kg car; the same with any ride height tried) and drives on to the far end';
const Q1 = '12 de Octubre N→S turn through its tunnel onto Queseras (e585→e523), interparroquial: since the junction dips to meet the link\'s mouth (2026-10-15) everyone gets through, but the 12.5 m bus starts the turn while still in the ramp\'s last meter of cut and its front corner knocks the ground beside it at (-63.7, 715.0) once (Δv ~5.6 m/s), then drives on';
const C1A = 'Cut at (-652, 321) (sin nombre e197→e199), articulated bus at 60 km/h: the REAR section (traced: lateral hit on the rear collider) grazes the cut wall at (-665.6, 331.7) on the bend, Δv 1.18 m/s against the 1.0 threshold: a genuine off-tracking sweep of an 18.4 m bus on a cut that widens at most 2 m (BEND_SWEEP). Order- and dice-dependent (1.08 to 1.18; it passed once on 2026-10-15)';
const Q2 = '12 de Octubre S→N link to Av. Patria (e588→e160): interparroquial (12.5 m) jams on the bend near the top against the low retaining wall at (-16.6, 747.6) between the ramp and Ladrón de Guevara alongside (1.1 m of ground between the two asphalts: no room to widen the cut); shorter vehicles pass';
const S2 = 'Cut at (-820, 774) (sin nombre e682→e195): on the sharp OSM kink at (-829.2, 773.8) the interparroquial\'s front corner hits the outer tunnel wall at (-827.7, 771.0) (Δv 4.6–6.4 m/s); since the streets alongside the cut give it room (clearCuts, 2026-10-15) it no longer stalls there and drives on';
known({
  'drive bridge Av. Patria @(-658,290): Av. Patria → Alfredo Perez Guerrero [e575→e899] | ae86 @ 90 km/h': G2,
  'drive cut sin nombre @(-652,321): sin nombre [e197→e199] | articulado @ 60 km/h': C1A,
  'drive cut Av. 12 de Octubre @(-42,733): sin nombre [e585→e523] | interparroquial @ 35 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,733): sin nombre [e585→e523] | interparroquial @ 70 km/h': Q1,
  'drive cut Av. 12 de Octubre @(-42,733): sin nombre [e588→e160] | interparroquial @ 35 km/h': Q2,
  'drive cut Av. 12 de Octubre @(-42,733): sin nombre [e588→e160] | interparroquial @ 70 km/h': Q2,
  'drive cut sin nombre @(-820,774): sin nombre [e682→e195] | interparroquial @ 35 km/h': S2,
  'drive cut sin nombre @(-820,774): sin nombre [e682→e195] | interparroquial @ 70 km/h': S2,
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
