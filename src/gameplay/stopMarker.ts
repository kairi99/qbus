import * as THREE from 'three';
import { type CityData, type Vec2, terrainAt } from '../world/cityData';
import { ZONE_RADIUS } from './routeGame';

const PICKUP = new THREE.Color('#3dff8a');
const DROPOFF = new THREE.Color('#ffd23f');

/**
 * Crazy-Taxi-style marker on the active stop: a light column visible across the city and a
 * ring on the road showing where to stop. Yellow when someone on board gets off here.
 */
export class StopMarker {
  readonly root = new THREE.Group();
  private beamMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  private ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  private fillMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.15, side: THREE.DoubleSide });
  private t = 0;

  constructor(
    scene: THREE.Scene,
    private city: CityData,
  ) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 140, 16, 1, true), this.beamMat);
    beam.position.y = 70; // taller than the tallest towers so it shows over rooftops
    const ring = new THREE.Mesh(new THREE.RingGeometry(ZONE_RADIUS - 0.5, ZONE_RADIUS, 40), this.ringMat);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(ZONE_RADIUS - 0.5, 40), this.fillMat);
    for (const m of [ring, fill]) {
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.1;
    }
    this.root.add(beam, ring, fill);
    scene.add(this.root);
  }

  place(zone: Vec2, dropoff: boolean): void {
    this.root.position.set(zone.x, terrainAt(this.city, zone), zone.z);
    const c = dropoff ? DROPOFF : PICKUP;
    for (const m of [this.beamMat, this.ringMat, this.fillMat]) m.color.copy(c);
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  update(dt: number): void {
    this.t += dt;
    this.beamMat.opacity = 0.22 + Math.sin(this.t * 3) * 0.08;
    this.ringMat.opacity = 0.7 + Math.sin(this.t * 6) * 0.25;
  }
}
