import { Rng } from '../core/rng';
import type { Block, Building, CityData, Feature, Prop, Road, Stop, Vec2 } from './cityData';
import { right } from './cityData';
import { rect } from './geom';

export const SIDEWALK_WIDTH = 3;
const STREET_WIDTH = 12;
const AVENUE_WIDTH = 20;
const FLOOR_HEIGHT = 3.2;
const CURB_INSET = 1;

export interface ProcCityOptions {
  seed: number;
  blocksX?: number;
  blocksZ?: number;
  blockSize?: number;
}

// Street names borrowed from La Mariscal / Iñaquito so stops read like real Quito stops.
const NS_NAMES = ['Av. 10 de Agosto', 'Páez', 'Juan León Mera', 'Reina Victoria', 'Av. Amazonas', 'Diego de Almagro', 'Av. 6 de Diciembre', 'Isabel la Católica', 'Tamayo'];
const EW_NAMES = ['Av. Patria', 'Jorge Washington', '18 de Septiembre', 'Av. Colón', 'Foch', 'Wilson', 'Veintimilla', 'Av. Orellana', 'Cordero', 'La Niña'];
const WALLS = ['#f2e8d5', '#e9d3b4', '#d8e2dc', '#f4c7a1', '#c9d6e8', '#f0d98c', '#e6b8b8', '#fbfaf5', '#cfd8c4', '#b9c4cc'];
const TERRACOTTA = '#b5563a';
const CONCRETE_ROOF = '#9a9a96';

interface Axis {
  centers: number[];
  widths: number[];
  /** [start, end] of each block between consecutive roads. */
  spans: [number, number][];
  avenue: number;
}

function layoutAxis(blocks: number, blockSize: number, avenue: number): Axis {
  const centers: number[] = [];
  const widths: number[] = [];
  const spans: [number, number][] = [];
  let pos = 0;
  for (let i = 0; i <= blocks; i++) {
    const w = i === avenue ? AVENUE_WIDTH : STREET_WIDTH;
    centers.push(pos + w / 2);
    widths.push(w);
    pos += w;
    if (i < blocks) {
      spans.push([pos, pos + blockSize]);
      pos += blockSize;
    }
  }
  const shift = pos / 2;
  return {
    centers: centers.map((c) => c - shift),
    widths,
    spans: spans.map(([a, b]) => [a - shift, b - shift]),
    avenue,
  };
}

/** Seeded grid city inspired by La Mariscal: one N-S and one E-W avenue, taller buildings downtown. */
export function generateCity(opts: ProcCityOptions): CityData {
  const { seed, blocksX = 8, blocksZ = 8, blockSize = 68 } = opts;
  const rng = new Rng(seed);
  const ax = layoutAxis(blocksX, blockSize, Math.floor(blocksX / 2));
  const az = layoutAxis(blocksZ, blockSize, Math.floor(blocksZ / 2) - 1);
  const xMin = ax.centers[0] - ax.widths[0] / 2;
  const xMax = ax.centers[blocksX] + ax.widths[blocksX] / 2;
  const zMin = az.centers[0] - az.widths[0] / 2;
  const zMax = az.centers[blocksZ] + az.widths[blocksZ] / 2;

  // Roads. N-S roads run along z at fixed x; E-W roads along x at fixed z.
  const roads: Road[] = [];
  const nsRoads = ax.centers.map((x, i): Road => road(NS_NAMES[i % NS_NAMES.length], i === ax.avenue, [{ x, z: zMin }, { x, z: zMax }]));
  const ewRoads = az.centers.map((z, j): Road => road(EW_NAMES[j % EW_NAMES.length], j === az.avenue, [{ x: xMin, z }, { x: xMax, z }]));
  roads.push(...nsRoads, ...ewRoads);

  // Stops and features along each block-long road segment.
  const stops: Stop[] = [];
  const features: Feature[] = [];
  const addSegmentStuff = (r: Road, along: 'x' | 'z', fixed: number, spans: [number, number][], cross: Road[]) => {
    spans.forEach(([a, b], k) => {
      const mid = (a + b) / 2;
      const at = (t: number): Vec2 => (along === 'z' ? { x: fixed, z: t } : { x: t, z: fixed });
      const positive = rng.chance(0.5);
      // Heading for travel toward +along: +z => -PI/2, +x => 0.
      const heading = along === 'z' ? (positive ? -Math.PI / 2 : Math.PI / 2) : positive ? 0 : Math.PI;
      if (rng.chance(r.kind === 'avenue' ? 0.6 : 0.18)) {
        const ahead = cross[positive ? k + 1 : k];
        const off = right(heading);
        const c = at(mid + rng.range(-8, 8));
        const d = r.width / 2 + 1.2;
        stops.push({
          id: `s${stops.length}`,
          name: `${shortName(r.name)} y ${shortName(ahead.name)}`,
          pos: { x: c.x + off.x * d, z: c.z + off.z * d },
          heading,
        });
      }
      if (r.kind === 'street') {
        const roll = rng.next();
        if (roll < 0.06) {
          features.push({ kind: 'ramp', pos: at(mid + rng.range(-12, 12)), heading, length: 10, width: 3.6, height: 2.2 });
        } else if (roll < 0.2) {
          features.push({ kind: 'hump', pos: at(mid + rng.range(-15, 15)), heading, length: 3, width: r.width, height: 0.22 });
        }
      }
    });
  };
  nsRoads.forEach((r, i) => addSegmentStuff(r, 'z', ax.centers[i], az.spans, ewRoads));
  ewRoads.forEach((r, j) => addSegmentStuff(r, 'x', az.centers[j], ax.spans, nsRoads));
  ensureFeature(features, 'ramp', nsRoads, az, ax, { length: 10, width: 3.6, height: 2.2 });
  ensureFeature(features, 'hump', nsRoads, az, ax, { length: 3, width: STREET_WIDTH, height: 0.22 });

  // Blocks, buildings, props.
  const blocks: Block[] = [];
  const buildings: Building[] = [];
  const props: Prop[] = [];
  const trees: Vec2[] = [];
  const nearStop = (p: Vec2, r: number) => stops.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < r);
  const addProp = (kind: Prop['kind'], pos: Vec2, heading: number) => {
    if (!nearStop(pos, 6)) props.push({ kind, pos, heading });
  };
  const maxR = Math.hypot(xMax, zMax);
  const avenueX = ax.centers[ax.avenue];
  const avenueZ = az.centers[az.avenue];

  ax.spans.forEach(([x0, x1]) => {
    az.spans.forEach(([z0, z1]) => {
      const park = rng.chance(0.1);
      blocks.push({ kind: park ? 'park' : 'sidewalk', footprint: rect(x0, z0, x1, z1) });

      // Trash cans on the corners; cones for "obras" and fruit stands along the curbs.
      const i = CURB_INSET;
      for (const [cx, cz] of [
        [x0 + i, z0 + i],
        [x1 - i, z0 + i],
        [x1 - i, z1 - i],
        [x0 + i, z1 - i],
      ]) {
        if (rng.chance(0.7)) addProp('trashcan', { x: cx, z: cz }, 0);
      }
      const sides: { a: Vec2; b: Vec2; heading: number }[] = [
        { a: { x: x0, z: z0 + 1.5 }, b: { x: x1, z: z0 + 1.5 }, heading: 0 },
        { a: { x: x0, z: z1 - 1.5 }, b: { x: x1, z: z1 - 1.5 }, heading: 0 },
        { a: { x: x0 + 1.5, z: z0 }, b: { x: x0 + 1.5, z: z1 }, heading: Math.PI / 2 },
        { a: { x: x1 - 1.5, z: z0 }, b: { x: x1 - 1.5, z: z1 }, heading: Math.PI / 2 },
      ];
      for (const s of sides) {
        const lerp = (t: number): Vec2 => ({ x: s.a.x + (s.b.x - s.a.x) * t, z: s.a.z + (s.b.z - s.a.z) * t });
        if (rng.chance(0.3)) addProp('fruitStand', lerp(rng.range(0.2, 0.8)), s.heading);
        if (rng.chance(0.12)) {
          const t0 = rng.range(0.15, 0.6);
          for (let c = 0; c < 5; c++) addProp('cone', lerp(t0 + c * 0.035), 0);
        }
      }

      if (park) {
        const n = rng.int(8, 14);
        for (let t = 0; t < n; t++) trees.push({ x: rng.range(x0 + 5, x1 - 5), z: rng.range(z0 + 5, z1 - 5) });
        for (let t = 0; t < 3; t++) addProp('fruitStand', { x: rng.range(x0 + 8, x1 - 8), z: rng.range(z0 + 8, z1 - 8) }, rng.range(0, Math.PI));
        return;
      }

      // Buildings: two rows of lots, each row split into lots of random frontage.
      const bx0 = x0 + SIDEWALK_WIDTH;
      const bx1 = x1 - SIDEWALK_WIDTH;
      const bz0 = z0 + SIDEWALK_WIDTH;
      const bz1 = z1 - SIDEWALK_WIDTH;
      const zMid = (bz0 + bz1) / 2 + rng.range(-6, 6);
      for (const [rz0, rz1] of [
        [bz0, zMid],
        [zMid, bz1],
      ]) {
        let lx = bx0;
        while (lx < bx1 - 0.5) {
          let w = rng.range(10, 22);
          if (bx1 - (lx + w) < 8) w = bx1 - lx;
          const lot = { x0: lx, x1: lx + w, z0: rz0, z1: rz1 };
          lx += w;
          if (rng.chance(0.06)) continue; // empty lot / parking
          const cx = (lot.x0 + lot.x1) / 2;
          const cz = (lot.z0 + lot.z1) / 2;
          const central = 1 - Math.min(1, Math.hypot(cx, cz) / maxR);
          const onAvenue = Math.abs(cx - avenueX) < 45 || Math.abs(cz - avenueZ) < 45;
          const floors = rng.chance((1 - central) * 0.45)
            ? rng.int(2, 3)
            : Math.round(rng.range(3, 6 + 14 * central ** 1.5 + (onAvenue ? 6 : 0)));
          const g = 0.3;
          buildings.push({
            footprint: rect(lot.x0 + g, lot.z0 + g, lot.x1 - g, lot.z1 - g),
            height: floors * FLOOR_HEIGHT,
            color: rng.pick(WALLS),
            roof: floors <= 3 ? TERRACOTTA : CONCRETE_ROOF,
          });
        }
      }
    });
  });

  // Spawn in the right-hand lane of Av. Amazonas heading north (+z).
  const spawnHeading = -Math.PI / 2;
  const spawnRight = right(spawnHeading);
  const [sz0, sz1] = az.spans[Math.floor(blocksZ / 2)];
  const spawn = {
    pos: { x: avenueX + spawnRight.x * (AVENUE_WIDTH / 4), z: (sz0 + sz1) / 2 + spawnRight.z * (AVENUE_WIDTH / 4) },
    heading: spawnHeading,
  };

  return {
    name: `Quito procedural #${seed}`,
    roads,
    blocks,
    buildings,
    stops,
    features,
    props,
    trees,
    spawn,
    bounds: { min: { x: xMin, z: zMin }, max: { x: xMax, z: zMax } },
  };
}

function road(name: string, avenue: boolean, points: Vec2[]): Road {
  return avenue
    ? { name, kind: 'avenue', points, width: AVENUE_WIDTH, lanes: 4 }
    : { name, kind: 'street', points, width: STREET_WIDTH, lanes: 2 };
}

function shortName(name: string): string {
  return name.replace(/^Av\. /, '');
}

/** Guarantees at least one feature of a kind so every city has something to jump. */
function ensureFeature(
  features: Feature[],
  kind: Feature['kind'],
  nsRoads: Road[],
  az: Axis,
  ax: Axis,
  dims: Pick<Feature, 'length' | 'width' | 'height'>,
): void {
  if (features.some((f) => f.kind === kind)) return;
  const i = ax.avenue === 1 ? 2 : 1;
  const [a, b] = az.spans[kind === 'ramp' ? 1 : 2];
  features.push({ kind, pos: { x: nsRoads[i].points[0].x, z: (a + b) / 2 }, heading: -Math.PI / 2, ...dims });
}
