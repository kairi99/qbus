/**
 * Drives one harness passage (tests/underpass) and prints a trace: every `every` seconds the
 * position, speed, height over the road, and the chassis's static contacts (point, normal,
 * impulse, collider kind). Usage: npx tsx tools/underpass-recon/passage.ts "<part of passage id>" <vehicle> <kmh> [every=0.5]
 */
import { RAPIER } from '../../src/physics/world';
import { busById } from '../../src/vehicle/buses';
import { describe as explain, driveRoute } from '../../tests/underpass/drive';
import { buildAll, cityAndCatalog } from '../../tests/underpass/setup';

async function main() {
  const [needle, vehicle, kmh, every = '0.5'] = process.argv.slice(2);
  const base = cityAndCatalog();
  const built = await buildAll(base);
  const p = base.structures.flatMap((s) => s.passages).find((x) => x.id.includes(needle));
  if (!p) throw new Error(`no passage matching ${needle}: ${base.structures.flatMap((s) => s.passages.map((x) => x.id)).join('\n')}`);
  console.log(p.id, 'route', p.route.join(','), 'startS', p.startS);
  const world = built.world;
  let next = 0;
  const r = driveRoute(world, built.city, built.graph, busById(vehicle), p.route, {
    kmh: Number(kmh),
    startS: p.startS,
    passage: { from: p.first, to: p.first + p.edges.length },
    trace: (t, bus, info) => {
      const chassis = bus.body.collider(0);
      const hits: string[] = [];
      world.contactPairsWith(chassis, (other) => {
        world.contactPair(chassis, other, (m) => {
          if (!m.numContacts()) return;
          let imp = 0;
          for (let i = 0; i < m.numContacts(); i++) imp += m.contactImpulse(i);
          const n = m.normal();
          const lp = m.localContactPoint1(0);
          hits.push(`${RAPIER.ShapeType[other.shapeType()]} imp ${imp.toFixed(0)} n(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) at ${lp ? `(${lp.x.toFixed(1)},${lp.y.toFixed(2)},${lp.z.toFixed(1)})` : '-'}`);
        });
      });
      if (t < next && !hits.some((h) => !/imp 0 /.test(h))) return;
      if (t >= next) next = t + Number(every);
      const q = bus.body.translation();
      console.log(`t ${t.toFixed(2)} (${q.x.toFixed(1)}, ${q.y.toFixed(2)}, ${q.z.toFixed(1)}) v ${bus.speed.toFixed(1)} road ${info.surfaceY.toFixed(2)} wheels ${bus.wheelsOnGround} off ${info.offPath.toFixed(1)} ${hits.join(' | ')}`);
    },
  });
  console.log(explain(r));
}
main();
