import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { CityData, PropKind } from './cityData';
import { groundHeightAt } from './cityData';
import { MeshBuilder, vertexColorMaterial } from './meshBuilder';

interface KindSpec {
  /** Geometry centered on the body origin. */
  geometry: THREE.BufferGeometry;
  collider: () => RAPIER.ColliderDesc;
  /** Distance from the body origin down to the prop's base. */
  halfHeight: number;
  mass: number;
}

const t = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

function coneSpec(): KindSpec {
  const mb = new MeshBuilder();
  mb.add(new THREE.ConeGeometry(0.28, 0.7, 8), t(0, 0, 0), '#ff6a13');
  mb.add(new THREE.CylinderGeometry(0.17, 0.2, 0.12, 8), t(0, 0.02, 0), '#f5f5f5');
  mb.add(new THREE.BoxGeometry(0.55, 0.05, 0.55), t(0, -0.33, 0), '#e0560c');
  return { geometry: mb.build(), collider: () => RAPIER.ColliderDesc.cone(0.35, 0.28), halfHeight: 0.35, mass: 2 };
}

function trashcanSpec(): KindSpec {
  const mb = new MeshBuilder();
  mb.add(new THREE.CylinderGeometry(0.3, 0.26, 0.9, 10), t(0, 0, 0), '#2e7d4f');
  mb.add(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 10), t(0, 0.47, 0), '#8c8c8c');
  return { geometry: mb.build(), collider: () => RAPIER.ColliderDesc.cylinder(0.45, 0.3), halfHeight: 0.45, mass: 12 };
}

/** Street fruit stand: table with crates of fruit and a striped awning. */
function fruitStandSpec(): KindSpec {
  const mb = new MeshBuilder();
  const h = 1.05;
  mb.add(new THREE.BoxGeometry(2, 0.08, 1), t(0, 0.85 - h, 0), '#9b7248');
  for (const [x, z] of [
    [-0.9, -0.42],
    [0.9, -0.42],
    [-0.9, 0.42],
    [0.9, 0.42],
  ]) {
    mb.add(new THREE.BoxGeometry(0.06, 0.85, 0.06), t(x, 0.42 - h, z), '#6d5033');
    mb.add(new THREE.BoxGeometry(0.04, 1.3, 0.04), t(x, 1.5 - h, z), '#6d5033');
  }
  const fruit = ['#f28c1c', '#d9302c', '#f5d130', '#6bb33c'];
  fruit.forEach((c, i) => mb.add(new THREE.BoxGeometry(0.42, 0.18, 0.7), t(-0.72 + i * 0.48, 0.98 - h, 0), c, '#8a6a45'));
  for (let i = 0; i < 6; i++) {
    mb.add(new THREE.BoxGeometry(0.4, 0.04, 1.2), t(-1 + 0.2 + i * 0.4, 2.15 - h, 0), i % 2 ? '#f4f4f4' : '#d63a3a');
  }
  return { geometry: mb.build(), collider: () => RAPIER.ColliderDesc.cuboid(1, h, 0.55), halfHeight: h, mass: 40 };
}

/**
 * Knockable street props. Bodies start asleep so hundreds of them cost nothing until the
 * bus hits one; each kind renders as one InstancedMesh.
 */
export class PropSystem {
  private groups: { mesh: THREE.InstancedMesh; bodies: RAPIER.RigidBody[]; origins: THREE.Vector3[]; knocked: boolean[] }[] = [];
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(world: RAPIER.World, scene: THREE.Scene, city: CityData) {
    const specs: Record<PropKind, KindSpec> = { cone: coneSpec(), trashcan: trashcanSpec(), fruitStand: fruitStandSpec() };
    const material = vertexColorMaterial();
    for (const kind of Object.keys(specs) as PropKind[]) {
      const spec = specs[kind];
      const items = city.props.filter((p) => p.kind === kind);
      if (!items.length) continue;
      const mesh = new THREE.InstancedMesh(spec.geometry, material, items.length);
      mesh.castShadow = true;
      mesh.frustumCulled = false; // instances span the whole city
      const bodies = items.map((prop) => {
        const y = groundHeightAt(city, prop.pos) + spec.halfHeight + 0.01;
        const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.heading);
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(prop.pos.x, y, prop.pos.z)
            .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
            .setSleeping(true)
            .setLinearDamping(0.3)
            .setAngularDamping(0.5),
        );
        world.createCollider(spec.collider().setMass(spec.mass).setFriction(0.7), body);
        return body;
      });
      const origins = bodies.map((b) => new THREE.Vector3().copy(b.translation()));
      this.groups.push({ mesh, bodies, origins, knocked: bodies.map(() => false) });
      scene.add(mesh);
    }
    this.sync(true);
  }

  get count(): number {
    return this.groups.reduce((n, g) => n + g.bodies.length, 0);
  }

  /** Number of props that have been shoved off their spot since the last call. */
  consumeKnocked(): number {
    let n = 0;
    for (const g of this.groups) {
      g.bodies.forEach((b, i) => {
        if (g.knocked[i] || b.isSleeping()) return;
        const t = b.translation();
        const o = g.origins[i];
        if (Math.hypot(t.x - o.x, t.y - o.y, t.z - o.z) > 0.4) {
          g.knocked[i] = true;
          n++;
        }
      });
    }
    return n;
  }

  /** Copies awake bodies into instance matrices (all of them when `force`). */
  sync(force = false): void {
    for (const { mesh, bodies } of this.groups) {
      let dirty = false;
      bodies.forEach((b, i) => {
        if (!force && b.isSleeping()) return;
        const tr = b.translation();
        const r = b.rotation();
        this.m.compose(this.p.set(tr.x, tr.y, tr.z), this.q.set(r.x, r.y, r.z, r.w), this.one);
        mesh.setMatrixAt(i, this.m);
        dirty = true;
      });
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
