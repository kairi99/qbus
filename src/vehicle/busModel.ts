import * as THREE from 'three';
import type { BusPreset } from './busPreset';
import type { BusPhysics } from './bus';
import { carCockpit, carExterior } from './carBody';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/**
 * Low-poly bus built from boxes (or, for `kind: 'car'`, the AE86 from carBody.ts), in chassis
 * space (+X forward). The exterior is hidden in cockpit view and replaced by a dashboard +
 * window frame so the camera can sit inside.
 */
export class BusModel {
  readonly root = new THREE.Group();
  private exterior = new THREE.Group();
  private cockpit = new THREE.Group();
  private wheels: { pivot: THREE.Object3D; spin: THREE.Object3D }[] = [];
  private steeringWheel!: THREE.Object3D;
  /** Exhaust flames, shown while the nitro burns. */
  private flames = new THREE.Group();

  constructor(private preset: BusPreset) {
    const { length: L, width: W, height: H } = preset.body;
    const car = preset.kind === 'car';
    if (car) this.exterior.add(...carExterior(preset));
    else this.busExterior(preset);
    this.exterior.traverse((o) => (o.castShadow = true));

    // Nitro flames out of two exhausts under the rear bumper, pointing backwards.
    const flameGeo = new THREE.ConeGeometry(car ? 0.12 : 0.22, car ? 1.0 : 1.6, 8);
    flameGeo.rotateZ(Math.PI / 2);
    flameGeo.translate(car ? -0.5 : -0.8, 0, 0);
    const outer = new THREE.MeshBasicMaterial({ color: '#3fa9ff', transparent: true, opacity: 0.75, depthWrite: false });
    const inner = new THREE.MeshBasicMaterial({ color: '#fff4c2' });
    for (const z of [-W * 0.25, W * 0.25]) {
      const flame = new THREE.Mesh(flameGeo, outer);
      const core = new THREE.Mesh(flameGeo, inner);
      core.scale.set(0.6, 0.5, 0.5);
      flame.add(core);
      flame.position.set(-L / 2, car ? -H * 0.3 : -H * 0.42, z);
      this.flames.add(flame);
    }
    this.flames.visible = false;
    this.exterior.add(this.flames);

    // Cockpit: dashboard, pillars, roof edge and steering wheel seen from the driver seat.
    this.steeringWheel = new THREE.Mesh(new THREE.TorusGeometry(car ? 0.18 : 0.22, 0.03, 6, 16), flat('#111'));
    if (car) {
      const { parts, wheelMount } = carCockpit(preset);
      wheelMount.add(this.steeringWheel);
      this.cockpit.add(...parts, wheelMount);
    } else this.busCockpit(preset);
    this.cockpit.visible = false;

    // Wheels
    const w = preset.wheels;
    const tireWidth = car ? 0.2 : 0.4;
    const tire = new THREE.CylinderGeometry(w.radius, w.radius, tireWidth, 12);
    tire.rotateX(Math.PI / 2);
    const tireMat = flat('#1b1b1b');
    const hubMat = flat(car ? '#d9d9d4' : '#bbbbbb');
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
      const hub = new THREE.Mesh(new THREE.BoxGeometry(w.radius * 0.9, w.radius * 0.3, tireWidth + 0.02), hubMat);
      spin.add(mesh, hub);
      pivot.add(spin);
      this.exterior.add(pivot);
      this.wheels.push({ pivot, spin });
    }

    this.root.add(this.exterior, this.cockpit);
  }

  private busExterior(preset: BusPreset): void {
    const { length: L, width: W, height: H, color, stripe, roof } = preset.body;
    const glass = flat('#1c2a38');
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
  }

  private busCockpit(preset: BusPreset): void {
    const { length: L, width: W, height: H, color } = preset.body;
    const frame = flat(color);
    const trim = flat('#3a3d42');
    const part = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      this.cockpit.add(m);
    };
    // The front few meters of the cabin, closed all round below the windows: at speed the view
    // widens and would show the road through any gap.
    const D = 3.4;
    const back = L / 2 - D;
    const floor = -H * 0.32;
    const sill = H * 0.01; // side windows start here (busExterior)
    const roof = H * 0.45;
    part(0.8, 0.5, W * 0.95, L / 2 - 0.5, 0.15, 0, flat('#2a2a2a')); // dashboard
    part(0.1, 0.15 - floor, W, L / 2 - 0.05, (0.15 + floor) / 2, 0, trim); // under the dash
    part(D, 0.06, W, L / 2 - D / 2, floor, 0, trim); // floor
    part(D, 0.1, W, L / 2 - D / 2, roof + 0.05, 0, new THREE.MeshBasicMaterial({ color: '#bfc3c7' })); // ceiling
    part(0.2, roof + 0.1 - H * 0.4, W, L / 2 - 0.1, (roof + 0.1 + H * 0.4) / 2, 0, frame); // header joining the pillars to the ceiling
    for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) {
      part(0.15, roof + 0.1 - floor, 0.12, L / 2 - 0.1, (roof + 0.1 + floor) / 2, z, frame); // pillars, floor to ceiling
      part(D, sill - floor, 0.1, L / 2 - D / 2, (sill + floor) / 2, z, frame); // side wall under the windows
      // Window posts down the side, into the ceiling.
      for (let x = L / 2 - 1.4; x > back; x -= 1.3) part(0.1, roof + 0.1 - sill, 0.1, x, (roof + 0.1 + sill) / 2, z, frame);
    }
    const wheelMount = new THREE.Group();
    wheelMount.position.set(L / 2 - 0.9, 0.55, -W / 2 + 0.75);
    wheelMount.rotation.z = -0.5;
    wheelMount.rotation.y = Math.PI / 2;
    wheelMount.add(this.steeringWheel);
    this.cockpit.add(wheelMount);
  }

  /**
   * Headlights for the dark: one real spot light lighting the road ahead (the only moving
   * light in the game; traffic gets fake beams on the road instead).
   */
  setHeadlights(on: boolean): void {
    if (!on || this.root.getObjectByName('headlights')) return;
    const { length: L, height: H } = this.preset.body;
    const spot = new THREE.SpotLight('#fff1d0', 90, 85, 0.62, 0.55, 1.2);
    spot.name = 'headlights';
    spot.position.set(L / 2 + 0.1, -H * 0.2, 0);
    spot.target.position.set(L / 2 + 22, -H * 0.5 - 2.5, 0);
    this.root.add(spot, spot.target);
    // The cabin ceiling is unshaded so it reads as daylit: dim it in the dark.
    this.cockpit.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat?.isMeshBasicMaterial) mat.color.multiplyScalar(0.22);
    });
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
    this.flames.visible = bus.boosting;
    if (bus.boosting) for (const f of this.flames.children) f.scale.x = 0.8 + Math.random() * 0.6;
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
