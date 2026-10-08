import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { CityData, Vec2 } from './cityData';
import { groundHeightAt, stopZone } from './cityData';
import { pointInPolygon } from './geom';
import type { BuildingIndex } from './facades';
import type { ChunkedMeshBuilder, MeshBuilder } from './meshBuilder';
import type { RoadGraph } from './roadGraph';
import type { RoadIndex } from './roadIndex';
import type { Lighting } from './sky';
import { glowTexture } from './streetscape';
import type { LightState, TrafficLights } from '../gameplay/trafficLights';

/** Pole height and where the arm holding the head over the lanes is. */
const POLE = 6.2;
const ARM_Y = 5.9;
/** The head: three lamps one above the other, red on top. */
const HEAD = { w: 0.42, h: 1.15, d: 0.32 };
const LAMP_GAP = 0.36;
const LAMP_R = 0.14;
/** The arm never reaches further than this over the road. */
const MAX_REACH = 6;
const HOUSING = '#23262a';
const STEEL = '#4f5459';
const STOP_LINE = '#eceae0';

const LIT: Record<LightState, THREE.Color> = {
  red: new THREE.Color('#ff2414'),
  amber: new THREE.Color('#ffae00'),
  green: new THREE.Color('#14e86a'),
};
/** Lamps that are off: the colored glass, dim. */
const DARK = [new THREE.Color('#3a1612'), new THREE.Color('#3a2c0e'), new THREE.Color('#0f3020')];
const ORDER: LightState[] = ['red', 'amber', 'green'];

/** A signal head facing one approach of a lit junction. */
interface Head {
  edge: number;
  /** Center of the head, and the direction it faces (toward the drivers). */
  pos: THREE.Vector3;
  facing: Vec2;
  state: LightState | null;
}

export interface SignalContext {
  city: CityData;
  graph: RoadGraph;
  lights: TrafficLights;
  roads: RoadIndex;
  buildings: BuildingIndex;
  /** Drawn ground height (draped layers) at a point. */
  ground: (p: Vec2) => number;
  solid: ChunkedMeshBuilder;
  /** Stop lines on the asphalt. */
  paint: ChunkedMeshBuilder;
  light: Lighting;
  world: RAPIER.World;
  fixed: RAPIER.RigidBody;
}

/**
 * Traffic lights at every lit junction: a pole on the sidewalk at each approach's stop line
 * (right-hand curb), its arm out over the incoming lanes holding a three-lamp head that faces
 * the drivers, and a stop line painted across those lanes. Poles, arms and housings go into the
 * static tiles (no extra draw calls) and the pole is solid like a street lamp's; the lamps are
 * one instanced mesh for the whole city whose instance colors switch as the lights change (no
 * real lights), plus, after dark, one instanced mesh of glows around the lit ones.
 */
export class SignalLamps {
  readonly meshes: THREE.Object3D[] = [];
  /** Where the poles stand: trees and lamps keep clear. */
  readonly poles: Vec2[] = [];
  private heads: Head[] = [];
  private lamps: THREE.InstancedMesh | null = null;
  private glows: THREE.InstancedMesh | null = null;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(ctx: SignalContext) {
    const { city, graph, lights } = ctx;
    const hulls = graph.nodes.filter((n) => n.hull).map((n) => n.hull!);
    const stops = city.stops.flatMap((s) => [s.pos, stopZone(s)]);
    const clear = (p: Vec2) =>
      ctx.roads.clearance(p) > 0.45 &&
      ctx.buildings.distance(p) > 0.5 &&
      !hulls.some((h) => pointInPolygon(p, h)) &&
      stops.every((s) => Math.hypot(p.x - s.x, p.z - s.z) > 3) &&
      city.props.every((pr) => Math.hypot(p.x - pr.pos.x, p.z - pr.pos.z) > 1.2) &&
      city.trees.every((t) => Math.hypot(p.x - t.x, p.z - t.z) > 1.5) &&
      (city.stations ?? []).every((s) => Math.hypot(p.x - s.pos.x, p.z - s.pos.z) > s.length / 2 + 1) &&
      this.poles.every((o) => Math.hypot(p.x - o.x, p.z - o.z) > 1.5);

    for (const j of lights.junctions) {
      // Only at street level: no sidewalks on decks or down in cuts.
      if (Math.abs(j.lift) > 0.3) continue;
      for (const a of j.approaches) {
        const e = graph.edges[a.edge];
        const right = { x: -a.dir.z, z: a.dir.x };
        // The incoming lanes: the right half of a two-way road, all of a one-way one.
        const inner = e.reverse >= 0 ? 0 : -a.halfWidth;
        const laneMid = (inner + a.halfWidth) / 2;
        // On the curb by the stop line, or a little further out or back if that spot is taken.
        let base: Vec2 | null = null;
        let off = 0;
        search: for (const back of [0, 1.5, 3, -1.5])
          for (const out of [0.8, 1.3, 1.9, 2.6]) {
            const at = a.halfWidth + out;
            const p = { x: a.line.x + right.x * at - a.dir.x * back, z: a.line.z + right.z * at - a.dir.z * back };
            if (clear(p)) {
              base = p;
              off = at;
              break search;
            }
          }
        if (!base) continue; // nowhere to stand: the light still works, unseen
        this.poles.push(base);
        const y0 = groundHeightAt(city, base);
        const reach = Math.min(MAX_REACH, off - laneMid);
        addPole(ctx.solid.at(base.x, base.z), new THREE.Vector3(base.x, y0, base.z), reach, a.dir, right);
        ctx.world.createCollider(RAPIER.ColliderDesc.cylinder(POLE / 2, 0.13).setTranslation(base.x, y0 + POLE / 2, base.z), ctx.fixed);
        const hx = base.x - right.x * reach;
        const hz = base.z - right.z * reach;
        this.heads.push({ edge: a.edge, pos: new THREE.Vector3(hx, y0 + ARM_Y - HEAD.h / 2 - 0.05, hz), facing: { x: -a.dir.x, z: -a.dir.z }, state: null });
        // Stop line across the incoming lanes, just behind the zebra crossing.
        const y = (p: Vec2) => ctx.ground(p) + 0.085;
        const c = { x: a.line.x + right.x * laneMid, z: a.line.z + right.z * laneMid };
        ctx.paint.drapedQuad(c, a.dir, 0.45, a.halfWidth - inner - 0.5, y, STOP_LINE);
      }
    }
    if (!this.heads.length) return;

    // Lamps: three per head, facing the drivers, a little in front of the housing.
    const lamps = new THREE.InstancedMesh(new THREE.CircleGeometry(LAMP_R, 10), new THREE.MeshBasicMaterial({ toneMapped: false }), this.heads.length * 3);
    this.heads.forEach((h, i) => {
      for (let k = 0; k < 3; k++) {
        lamps.setMatrixAt(i * 3 + k, this.place(h, LAMP_GAP * (1 - k), HEAD.d / 2 + 0.01, 1));
        lamps.setColorAt(i * 3 + k, DARK[k]);
      }
    });
    lamps.computeBoundingSphere();
    this.lamps = lamps;
    this.meshes.push(lamps);
    if (ctx.light.lamps) {
      // A soft glow around each lit lamp when it's dark, so lights read from a block away.
      const mat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 1.6), mat, this.heads.length);
      this.heads.forEach((h, i) => {
        glows.setMatrixAt(i, this.place(h, 0, HEAD.d / 2 + 0.05, 1));
        glows.setColorAt(i, DARK[0]);
      });
      glows.computeBoundingSphere();
      glows.renderOrder = 2;
      this.glows = glows;
      this.meshes.push(glows);
    }
  }

  /** Shows each head's light at time `t` (only what changed is written). */
  update(lights: TrafficLights, t: number): void {
    const lamps = this.lamps;
    if (!lamps) return;
    let changed = false;
    for (let i = 0; i < this.heads.length; i++) {
      const h = this.heads[i];
      const state = lights.state(h.edge, t);
      if (state === h.state) continue;
      h.state = state;
      changed = true;
      for (let k = 0; k < 3; k++) lamps.setColorAt(i * 3 + k, ORDER[k] === state ? LIT[state] : DARK[k]);
      if (this.glows && state) {
        this.glows.setMatrixAt(i, this.place(h, LAMP_GAP * (1 - ORDER.indexOf(state)), HEAD.d / 2 + 0.05, 1));
        this.glows.setColorAt(i, LIT[state]);
      }
    }
    if (!changed) return;
    lamps.instanceColor!.needsUpdate = true;
    if (this.glows) {
      this.glows.instanceColor!.needsUpdate = true;
      this.glows.instanceMatrix.needsUpdate = true;
    }
  }

  /** Matrix for something on a head's face: `dy` up from its middle, `ahead` toward the drivers. */
  private place(h: Head, dy: number, ahead: number, scale: number): THREE.Matrix4 {
    // Circles and planes face +z: turn that toward the drivers.
    this.q.setFromAxisAngle(this.up, Math.atan2(h.facing.x, h.facing.z));
    this.v.set(h.pos.x + h.facing.x * ahead, h.pos.y + dy, h.pos.z + h.facing.z * ahead);
    this.s.setScalar(scale);
    return this.m.compose(this.v, this.q, this.s);
  }
}

/** Pole, arm out to `reach` over the road (local -right), and the housing hanging from it. */
function addPole(mb: MeshBuilder, base: THREE.Vector3, reach: number, dir: Vec2, right: Vec2): void {
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  mb.add(new THREE.CylinderGeometry(0.09, 0.13, POLE, 6), at(base.x, base.y + POLE / 2, base.z), STEEL);
  // The arm along -right (from the curb out over the lanes).
  const arm = new THREE.BoxGeometry(reach, 0.12, 0.12).rotateY(Math.atan2(right.z, -right.x));
  mb.add(arm, at(base.x - (right.x * reach) / 2, base.y + ARM_Y, base.z - (right.z * reach) / 2), STEEL);
  // The housing, turned to face the drivers (-dir), with a backplate.
  const turn = Math.atan2(-dir.x, -dir.z);
  const hx = base.x - right.x * reach;
  const hz = base.z - right.z * reach;
  const hy = base.y + ARM_Y - HEAD.h / 2 - 0.05;
  mb.add(new THREE.BoxGeometry(HEAD.w, HEAD.h, HEAD.d).rotateY(turn), at(hx, hy, hz), HOUSING);
  mb.add(new THREE.BoxGeometry(HEAD.w + 0.22, HEAD.h + 0.2, 0.04).rotateY(turn), at(hx + dir.x * (HEAD.d / 2 + 0.02), hy, hz + dir.z * (HEAD.d / 2 + 0.02)), '#151719');
  // A short hanger from the arm down to the housing.
  mb.add(new THREE.BoxGeometry(0.06, 0.1, 0.06), at(hx, base.y + ARM_Y - 0.08, hz), STEEL);
}
