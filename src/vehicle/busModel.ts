import * as THREE from 'three';
import type { BusPreset } from './busPreset';
import type { BusPhysics } from './bus';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/**
 * Low-poly bus built from boxes, in chassis space (+X forward). The exterior is hidden in
 * cockpit view and replaced by a dashboard + window frame so the camera can sit inside.
 */
export class BusModel {
  readonly root = new THREE.Group();
  private exterior = new THREE.Group();
  private cockpit = new THREE.Group();
  private wheels: { pivot: THREE.Object3D; spin: THREE.Object3D }[] = [];
  private steeringWheel: THREE.Object3D;

  constructor(preset: BusPreset) {
    const { length: L, width: W, height: H, color, stripe, roof } = preset.body;
    const glass = flat('#1c2a38');

    // Exterior
    const body = new THREE.Mesh(new THREE.BoxGeometry(L, H * 0.92, W), flat(color));
    body.position.y = -H * 0.04;
    const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(L * 0.98, H * 0.08, W * 0.96), flat(roof));
    roofMesh.position.y = H * 0.46;
    const band = new THREE.Mesh(new THREE.BoxGeometry(L + 0.02, H * 0.12, W + 0.02), flat(stripe));
    band.position.y = -H * 0.18;
    const sideWindows = new THREE.Mesh(new THREE.BoxGeometry(L * 0.72, H * 0.3, W + 0.04), glass);
    sideWindows.position.set(-L * 0.08, H * 0.16, 0);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.06, H * 0.42, W * 0.9), glass);
    windshield.position.set(L / 2 + 0.01, H * 0.12, 0);
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.2, H * 0.12, W * 1.02), flat('#333'));
    bumper.position.set(L / 2 + 0.05, -H * 0.4, 0);
    this.exterior.add(body, roofMesh, band, sideWindows, windshield, bumper, this.makeSign(preset, L, H, W));
    for (const z of [-W * 0.36, W * 0.36]) {
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.4), new THREE.MeshBasicMaterial({ color: '#fff6c8' }));
      light.position.set(L / 2 + 0.04, -H * 0.28, z);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: '#d42020' }));
      tail.position.set(-L / 2 - 0.04, -H * 0.2, z);
      this.exterior.add(light, tail);
    }
    this.exterior.traverse((o) => (o.castShadow = true));

    // Cockpit: dashboard, pillars, roof edge and steering wheel seen from the driver seat.
    const frame = flat(color);
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, W * 0.95), flat('#2a2a2a'));
    dash.position.set(L / 2 - 0.5, 0.15, 0);
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, W), new THREE.MeshBasicMaterial({ color: '#bfc3c7' }));
    ceiling.position.set(L / 2 - 1.25, H * 0.5, 0);
    this.cockpit.add(dash, ceiling);
    for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.15, H * 0.8, 0.12), frame);
      pillar.position.set(L / 2 - 0.1, H * 0.05, z);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, 0.5, 0.1), frame);
      sill.position.set(L / 4, -0.55, z);
      this.cockpit.add(pillar, sill);
    }
    this.steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 16), flat('#111'));
    const wheelMount = new THREE.Group();
    wheelMount.position.set(L / 2 - 0.9, 0.55, -W / 2 + 0.75);
    wheelMount.rotation.z = -0.5;
    wheelMount.rotation.y = Math.PI / 2;
    wheelMount.add(this.steeringWheel);
    this.cockpit.add(wheelMount);
    this.cockpit.visible = false;

    // Wheels
    const w = preset.wheels;
    const tire = new THREE.CylinderGeometry(w.radius, w.radius, 0.4, 12);
    tire.rotateX(Math.PI / 2);
    const tireMat = flat('#1b1b1b');
    const hubMat = flat('#bbbbbb');
    for (const [x, z] of [
      [w.frontOffset, -w.track],
      [w.frontOffset, w.track],
      [w.rearOffset, -w.track],
      [w.rearOffset, w.track],
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, w.mountHeight, z);
      const spin = new THREE.Group();
      const mesh = new THREE.Mesh(tire, tireMat);
      mesh.castShadow = true;
      const hub = new THREE.Mesh(new THREE.BoxGeometry(w.radius * 0.9, w.radius * 0.3, 0.42), hubMat);
      spin.add(mesh, hub);
      pivot.add(spin);
      this.exterior.add(pivot);
      this.wheels.push({ pivot, spin });
    }

    this.root.add(this.exterior, this.cockpit);
  }

  setCockpitView(on: boolean): void {
    this.exterior.visible = !on;
    this.cockpit.visible = on;
  }

  sync(bus: BusPhysics): void {
    const t = bus.body.translation();
    const q = bus.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);

    const mount = bus.preset.wheels.mountHeight;
    this.wheels.forEach(({ pivot, spin }, i) => {
      pivot.position.y = mount - (bus.vehicle.wheelSuspensionLength(i) ?? 0);
      pivot.rotation.y = bus.vehicle.wheelSteering(i) ?? 0;
      spin.rotation.z = -(bus.vehicle.wheelRotation(i) ?? 0);
    });
    this.steeringWheel.rotation.z = (bus.vehicle.wheelSteering(0) ?? 0) * 4;
  }

  /** Destination sign above the windshield, drawn to a canvas texture. */
  private makeSign(preset: BusPreset, L: number, H: number, W: number): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 256, 48);
    ctx.fillStyle = '#ffb000';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(preset.name.toUpperCase(), 128, 26);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.8, 0.35), new THREE.MeshBasicMaterial({ map: tex }));
    sign.position.set(L / 2 + 0.02, H * 0.38, 0);
    sign.rotation.y = Math.PI / 2;
    return sign;
  }
}
