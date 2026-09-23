import * as THREE from 'three';
import type { Vec2 } from '../world/cityData';
import type { CameraMode } from '../camera/cameraRig';

/**
 * Big floating arrow pointing at the next stop, drawn on top of everything so buildings
 * never hide it. Sits above the bus in chase view and near the windshield top in cockpit view.
 */
export class NavArrow {
  readonly root = new THREE.Group();
  private mat = new THREE.MeshLambertMaterial({ color: '#3dff8a', emissive: '#1a7a3f', depthTest: false, transparent: true });
  private target: Vec2 | null = null;
  private fwd = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    // Built pointing along +Z, which is what Object3D.lookAt aims.
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 1.6), this.mat);
    shaft.position.z = -0.5;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 4), this.mat);
    head.rotation.x = Math.PI / 2;
    head.rotation.y = Math.PI / 4;
    head.position.z = 0.8;
    for (const m of [shaft, head]) m.renderOrder = 10;
    this.root.add(shaft, head);
    scene.add(this.root);
  }

  point(target: Vec2 | null, color?: THREE.ColorRepresentation): void {
    this.target = target;
    this.root.visible = !!target;
    if (color) {
      this.mat.color.set(color);
      this.mat.emissive.set(color).multiplyScalar(0.4);
    }
  }

  update(camera: THREE.Camera, mode: CameraMode, busPos: THREE.Vector3): void {
    if (!this.target) return;
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    if (mode === 'chase') {
      this.root.position.copy(busPos).addScaledVector(this.fwd, 3);
      this.root.position.y += 4.6;
      this.root.scale.setScalar(1.4);
    } else {
      this.root.position.copy(camera.position).addScaledVector(this.fwd, 7);
      this.root.position.y += 1.6;
      this.root.scale.setScalar(0.7);
    }
    this.root.lookAt(this.target.x, this.root.position.y, this.target.z);
    // Dip the tip so an arrow pointing straight ahead still reads as an arrow, not a box.
    this.root.rotateX(0.35);
  }
}
