import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { Monument, Vec2 } from './cityData';
import type { MeshBuilder } from './meshBuilder';

type Ground = (p: Vec2) => number;

const ANDESITE = '#8a8780';
const ANDESITE_DARK = '#6f6c66';
const ANDESITE_LIGHT = '#a7a49c';
const PAVING = '#c9c1b0';
const PAVING_EDGE = '#9d9585';
const BRONZE = '#5b4a36';

/**
 * The Universidad Central's Reloj Solar in Plaza Indoamérica: three stacked pieces of Andean
 * stone (andesite), a half-cone base, a Solomonic column twisting twice (like those beside the
 * door of La Compañía) and a block with an hour dial on each of its four faces ("HORÆ
 * QUITENSE"), facing the cardinal points. Its real height isn't published; it's drawn at about
 * 5 m so it reads over the roadworks hoarding at the map edge, a few busts of the plaza's
 * Indo-American heroes around it.
 */
export function addMonument(mb: MeshBuilder, m: Monument, ground: Ground, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  if (m.kind === 'relojSolar') relojSolar(mb, m.pos, ground, world, fixed);
}

function relojSolar(mb: MeshBuilder, at: Vec2, ground: Ground, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const base = ground(at);
  const place = (x: number, y: number, z: number, ry = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(at.x + x, base + y, at.z + z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4, color: string, side?: string) => {
    mb.add(g, m, color, side);
    g.dispose();
  };

  // The round plaza, paved in stone, with a darker kerb.
  const ring = (r: number) => Array.from({ length: 32 }, (_, i) => ({ x: at.x + Math.cos((i / 32) * Math.PI * 2) * r, z: at.z + Math.sin((i / 32) * Math.PI * 2) * r }));
  mb.fan(ring(10), (p) => ground(p) + 0.06, PAVING_EDGE, 2);
  mb.fan(ring(9.4), (p) => ground(p) + 0.08, PAVING, 2);

  // A low stepped platform, then the half-cone base.
  add(new THREE.CylinderGeometry(1.7, 1.8, 0.3, 16), place(0, 0.15, 0), ANDESITE_DARK);
  add(new THREE.CylinderGeometry(1.3, 1.4, 0.3, 16), place(0, 0.45, 0), ANDESITE_DARK);
  add(new THREE.CylinderGeometry(0.55, 1.05, 1.0, 16), place(0, 1.1, 0), ANDESITE);
  add(new THREE.CylinderGeometry(0.62, 0.62, 0.14, 16), place(0, 1.67, 0), ANDESITE_DARK);

  // The Solomonic column: a shaft whose axis winds round twice on the way up.
  const colH = 2.2;
  const shaft = new THREE.CylinderGeometry(0.3, 0.3, colH, 12, 40);
  const v = shaft.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < v.count; i++) {
    const t = (v.getY(i) + colH / 2) / colH;
    const a = t * Math.PI * 2 * 2;
    v.setX(i, v.getX(i) + Math.cos(a) * 0.12);
    v.setZ(i, v.getZ(i) + Math.sin(a) * 0.12);
  }
  shaft.computeVertexNormals();
  add(shaft, place(0, 1.74 + colH / 2, 0), ANDESITE_LIGHT, ANDESITE);
  const top = 1.74 + colH;
  add(new THREE.CylinderGeometry(0.5, 0.38, 0.22, 12), place(0, top + 0.11, 0), ANDESITE_DARK);

  // The dial block: an hour circle and a gnomon on each face, a little pyramid on top.
  const blockY = top + 0.22;
  const B = 0.95;
  add(new THREE.BoxGeometry(B, 1.05, B), place(0, blockY + 0.525, 0), ANDESITE_LIGHT, ANDESITE);
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    const out = { x: Math.sin(ry), z: Math.cos(ry) };
    const face = (d: number) => [out.x * (B / 2 + d), out.z * (B / 2 + d)] as const;
    const [fx, fz] = face(0.01);
    const dial = new THREE.CylinderGeometry(0.34, 0.34, 0.02, 24).rotateX(Math.PI / 2);
    add(dial, place(fx, blockY + 0.58, fz, ry), '#d9d3c4');
    // Hour lines fanning down from the gnomon's foot.
    for (let h = -3; h <= 3; h++) {
      const line = new THREE.BoxGeometry(0.015, 0.3, 0.012).translate(0, -0.15, 0).rotateZ((h * Math.PI) / 9);
      const [lx, lz] = face(0.025);
      add(line, place(lx, blockY + 0.66, lz, ry), '#4c4a45');
    }
    const gnomon = new THREE.BoxGeometry(0.02, 0.2, 0.16).translate(0, 0, 0.08);
    add(gnomon, place(fx, blockY + 0.6, fz, ry), '#3f3d39');
  }
  add(new THREE.ConeGeometry(0.62, 0.42, 4).rotateY(Math.PI / 4), place(0, blockY + 1.05 + 0.21, 0), ANDESITE, ANDESITE_DARK);

  // A few of the plaza's busts of Indo-American heroes, facing the sundial.
  const busts = 8;
  for (let i = 0; i < busts; i++) {
    const a = (i / busts) * Math.PI * 2 + Math.PI / busts;
    const x = Math.cos(a) * 7.2;
    const z = Math.sin(a) * 7.2;
    const g = ground({ x: at.x + x, z: at.z + z }) - base;
    const face = Math.atan2(-x, -z);
    add(new THREE.BoxGeometry(0.55, 1.3, 0.55), place(x, g + 0.65, z, face), ANDESITE_LIGHT, ANDESITE);
    add(new THREE.BoxGeometry(0.62, 0.32, 0.36), place(x, g + 1.46, z, face), BRONZE);
    add(new THREE.CylinderGeometry(0.08, 0.09, 0.14, 8), place(x, g + 1.66, z, face), BRONZE);
    add(new THREE.IcosahedronGeometry(0.18, 1), place(x, g + 1.86, z, face), BRONZE);
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 1.0, 0.3).setTranslation(at.x + x, base + g + 1.0, at.z + z), fixed);
  }
  world.createCollider(RAPIER.ColliderDesc.cylinder(2.7, 0.9).setTranslation(at.x, base + 2.7, at.z), fixed);
  world.createCollider(RAPIER.ColliderDesc.cylinder(0.3, 1.8).setTranslation(at.x, base + 0.3, at.z), fixed);
}
