import * as THREE from 'three';
import { MeshBuilder, vertexColorMaterial } from '../world/meshBuilder';
import { type CityData, groundHeightAt } from '../world/cityData';
import { CAR_KINDS, type CarKind, type TrafficSim } from './traffic';
import type { TrafficBodies } from './trafficBodies';
import type { Pedestrian } from './pedestrians';

/** What the view needs of a walker (street pedestrians, or people at a Metro entrance). */
export type WalkerPose = Pick<Pedestrian, 'pos' | 'heading' | 'speed' | 'look' | 'hop' | 'lean'> & { mode: string };

// Body parts are white in the geometry and tinted per car through instance colors.
const TINT = '#ffffff';
const GLASS = '#26313b';
const TIRE = '#151515';
const PAINT: Record<CarKind['name'], string[]> = {
  sedan: ['#c9ccd1', '#1e2a44', '#8a1c1c', '#ececec', '#2d4f2d', '#5a5f66', '#b0862a', '#3f6fa8'],
  taxi: ['#f5c400'],
  buseta: ['#f4f4f4', '#1f7a3a', '#c62828', '#1565c0', '#f2a900'],
};

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
/** From a walker's feet to the head's center. */
const HEAD = at(0, 1.42, 0);

function wheels(mb: MeshBuilder, L: number, W: number, H: number, r: number): void {
  const tire = new THREE.CylinderGeometry(r, r, 0.3, 10).rotateX(Math.PI / 2);
  for (const x of [L * 0.32, -L * 0.32]) for (const z of [W / 2 - 0.12, -W / 2 + 0.12]) mb.add(tire, at(x, -H / 2 + r, z), TIRE);
}

function carGeometry(k: CarKind): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = k;
  const mb = new MeshBuilder();
  if (k.name === 'buseta') {
    wheels(mb, L, W, H, 0.45);
    mb.add(new THREE.BoxGeometry(L, H - 0.45, W), at(0, 0.22, 0), TINT);
    mb.add(new THREE.BoxGeometry(L * 0.8, 0.7, W + 0.04), at(-L * 0.05, 0.55, 0), GLASS);
    mb.add(new THREE.BoxGeometry(0.06, 0.9, W * 0.9), at(L / 2 + 0.01, 0.45, 0), GLASS);
    mb.add(new THREE.BoxGeometry(0.06, 0.7, W * 0.8), at(-L / 2 - 0.01, 0.55, 0), GLASS);
    for (const z of [-W * 0.35, W * 0.35]) mb.add(new THREE.BoxGeometry(0.06, 0.2, 0.3), at(-L / 2 - 0.02, -0.7, z), '#c62020');
  } else {
    wheels(mb, L, W, H, 0.33);
    mb.add(new THREE.BoxGeometry(L, 0.65, W), at(0, -H / 2 + 0.3 + 0.325, 0), TINT);
    // Cabin: tinted roof, glass all round.
    mb.add(new THREE.BoxGeometry(L * 0.52, 0.52, W * 0.9), at(-L * 0.05, H / 2 - 0.26, 0), TINT, GLASS);
    if (k.name === 'taxi') {
      mb.add(new THREE.BoxGeometry(0.55, 0.16, 0.3), at(-L * 0.05, H / 2 + 0.08, 0), '#202020');
      // Checkered band along the doors.
      for (let i = 0; i < 8; i++) mb.add(new THREE.BoxGeometry(0.3, 0.1, W + 0.02), at(-1.2 + i * 0.34, -0.05, 0), i % 2 ? '#111' : TINT);
    }
  }
  return mb.build();
}

/** Instanced cars (one draw call per kind) that copy their physics bodies every frame. */
export class TrafficView {
  private meshes = new Map<CarKind['name'], { mesh: THREE.InstancedMesh; ids: number[] }>();
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private zero = new THREE.Vector3(0, 0, 0);

  constructor(
    scene: THREE.Scene,
    private sim: TrafficSim,
    private bodies: TrafficBodies,
  ) {
    const material = vertexColorMaterial();
    for (const kind of Object.values(CAR_KINDS)) {
      const ids = sim.cars.filter((c) => c.kind.name === kind.name).map((c) => c.id);
      if (!ids.length) continue;
      const mesh = new THREE.InstancedMesh(carGeometry(kind), material, ids.length);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const c = new THREE.Color();
      ids.forEach((id, i) => {
        const palette = PAINT[kind.name];
        mesh.setColorAt(i, c.set(palette[Math.floor(sim.cars[id].paint * palette.length)]));
      });
      scene.add(mesh);
      this.meshes.set(kind.name, { mesh, ids });
    }
  }

  sync(): void {
    for (const { mesh, ids } of this.meshes.values()) {
      ids.forEach((id, i) => {
        const b = this.bodies.bodies[id];
        if (this.sim.cars[id].state === 'parked') {
          this.m.compose(this.zero, this.q.identity(), this.zero);
        } else {
          const t = b.translation();
          const r = b.rotation();
          this.m.compose(this.p.set(t.x, t.y, t.z), this.q.set(r.x, r.y, r.z, r.w), this.one);
        }
        mesh.setMatrixAt(i, this.m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const SHIRTS = ['#d23c3c', '#2d6cc4', '#e8b21e', '#3d9a5a', '#8b4fb8', '#e27a2c', '#2fa6a6', '#f2f2f2', '#6d4c41', '#c2185b'];
const SKIN = ['#c68a5b', '#a8704a', '#e0ac7e', '#8d5a3a'];

/** Instanced pedestrians: body (tinted shirt) + head, two draw calls for the whole crowd. */
export class PedestrianView {
  private body: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private roll = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private fwd = new THREE.Vector3(0, 0, 1);

  constructor(
    scene: THREE.Scene,
    private sim: { readonly peds: readonly WalkerPose[] },
    private city: CityData,
  ) {
    const mb = new MeshBuilder();
    mb.add(new THREE.BoxGeometry(0.36, 0.7, 0.22), at(0, 0.35, 0), '#3a3f4a');
    mb.add(new THREE.BoxGeometry(0.42, 0.55, 0.26), at(0, 0.97, 0), TINT);
    const n = sim.peds.length;
    this.body = new THREE.InstancedMesh(mb.build(), vertexColorMaterial(), n);
    this.head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshLambertMaterial({ flatShading: true }), n);
    const c = new THREE.Color();
    sim.peds.forEach((ped, i) => {
      this.body.setColorAt(i, c.set(SHIRTS[Math.floor(ped.look * SHIRTS.length)]));
      this.head.setColorAt(i, c.set(SKIN[Math.floor(((ped.look * 7.3) % 1) * SKIN.length)]));
    });
    for (const mesh of [this.body, this.head]) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  sync(time: number): void {
    this.sim.peds.forEach((ped, i) => {
      const walking = ped.mode === 'walk' || ped.mode === 'cross';
      const bob = walking ? Math.abs(Math.sin(time * ped.speed * 5 + ped.look * 10)) * 0.05 : 0;
      const y = groundHeightAt(this.city, ped.pos) + 0.02 + ped.hop + bob;
      // Local +Z faces the walking direction: yaw = heading + 90°.
      this.q.setFromAxisAngle(this.up, ped.heading + Math.PI / 2).multiply(this.roll.setFromAxisAngle(this.fwd, ped.lean));
      this.m.compose(this.p.set(ped.pos.x, y, ped.pos.z), this.q, this.one);
      this.body.setMatrixAt(i, this.m);
      this.m.multiply(HEAD);
      this.head.setMatrixAt(i, this.m);
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
  }
}
