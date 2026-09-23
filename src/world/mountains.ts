import * as THREE from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder } from './meshBuilder';

// Quito sits in a valley: Pichincha to the west, a ring of lower hills elsewhere,
// and a snowy volcano (Cotopaxi-style) far to the south.
const HAZE = new THREE.Color('#dfe9ee');

/**
 * Distant low-poly mountain ring. Unfogged, but pre-blended toward the horizon color.
 * `cityRadius` (center to farthest corner) keeps the ring outside the playable area; the
 * layout was tuned for a ~470 m radius and scales up from there, keeping peaks' apparent size.
 */
export function buildMountains(cityRadius = 470, seed = 7): THREE.Mesh {
  const k = Math.max(1, cityRadius / 470);
  const rng = new Rng(seed);
  const mb = new MeshBuilder();
  const peaks: { angle: number; dist: number; radius: number; height: number; snow: boolean }[] = [];
  for (let i = 0; i < 30; i++) {
    const angle = (i / 30) * Math.PI * 2 + rng.range(-0.08, 0.08);
    // angle PI = west (-x): the Pichincha side is taller and closer.
    const west = Math.max(0, -Math.cos(angle));
    peaks.push({
      angle,
      dist: (rng.range(1250, 1450) - west * 120) * k,
      radius: rng.range(220, 340) * k,
      height: (rng.range(110, 220) + west * 260) * k,
      snow: false,
    });
  }
  peaks.push({ angle: Math.PI / 2 + 0.25, dist: 1650 * k, radius: 420 * k, height: 560 * k, snow: true }); // south (+z)

  for (const p of peaks) {
    const geo = new THREE.ConeGeometry(p.radius, p.height, 7, p.snow ? 1 : 3);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > -p.height / 2 + 1 && y < p.height / 2 - 1) {
        pos.setX(i, pos.getX(i) * rng.range(0.8, 1.2));
        pos.setZ(i, pos.getZ(i) * rng.range(0.8, 1.2));
        pos.setY(i, y + rng.range(-12, 12));
      }
    }
    const m = new THREE.Matrix4().makeTranslation(Math.cos(p.angle) * p.dist, p.height / 2 - 5, Math.sin(p.angle) * p.dist);
    const haze = Math.min(0.75, (p.dist / k - 900) / 1000);
    const rock = new THREE.Color('#6f8a6a').lerp(HAZE, haze);
    mb.add(geo, m, new THREE.Color('#7f9a78').lerp(HAZE, haze), rock);
    geo.dispose();
    if (p.snow) {
      // Snow cap: the top 30% of the cone, drawn slightly larger over the rock.
      const capH = p.height * 0.3;
      const cap = new THREE.ConeGeometry(p.radius * 0.3 * 1.03, capH, 7);
      const cm = new THREE.Matrix4().makeTranslation(Math.cos(p.angle) * p.dist, p.height - 5 - capH / 2 + 1, Math.sin(p.angle) * p.dist);
      mb.add(cap, cm, '#f4f6f8');
      cap.dispose();
    }
  }
  const mesh = new THREE.Mesh(mb.build(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false }));
  mesh.renderOrder = -0.5;
  return mesh;
}
