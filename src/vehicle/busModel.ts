import * as THREE from 'three';
import { type BusPreset, isTrain } from './busPreset';
import type { BusPhysics } from './bus';
import { carCockpit, carExterior } from './carBody';
import { gusanitoCockpit, gusanitoHead, gusanitoWagon } from './gusanitoBody';
import { mergeParts } from './mergeParts';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/**
 * Low-poly bus built from boxes (or, for `kind: 'car'`, the AE86 from carBody.ts), in chassis
 * space (+X forward). The exterior is hidden in cockpit view and replaced by a dashboard +
 * window frame so the camera can sit inside.
 */
/**
 * A steering wheel in its own XY plane (it turns about z): rim, hub, three spokes (left, right,
 * down) and a yellow mark at the top. A bare ring's facets alias as it spins, so it can seem to
 * turn the wrong way; the spokes and the mark show which way it turns.
 */
function steeringWheel(r: number): THREE.Group {
  const dark = flat('#111');
  const wheel = new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(r, 0.03, 6, 16), dark));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.28, 0.05, 10), dark);
  hub.rotation.x = Math.PI / 2;
  wheel.add(hub);
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(r, 0.035, 0.025), dark);
    spoke.position.set((Math.cos(a) * r) / 2, (Math.sin(a) * r) / 2, 0);
    spoke.rotation.z = a;
    wheel.add(spoke);
  }
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.07), flat('#f2c230'));
  mark.position.set(0, r, 0);
  wheel.add(mark);
  return wheel;
}

export class BusModel {
  readonly root = new THREE.Group();
  private exterior = new THREE.Group();
  private cockpit = new THREE.Group();
  /** `section`: 0 = the front one, i + 1 = rear section i. */
  private wheels: { pivot: THREE.Object3D; spin: THREE.Object3D; section: number; index: number }[] = [];
  /** Rear sections of an articulated bus, each posed relative to the front one. */
  private rearGroups: THREE.Group[] = [];
  /** Length of the front section (the whole bus when rigid). */
  private frontLength: number;
  private steeringWheel!: THREE.Object3D;
  /** Exhaust flames, shown while the nitro burns. */
  private flames = new THREE.Group();
  /** Water thrown up off the front wheels, wading through a flood. */
  private spray = new THREE.Group();
  private sprayMat = new THREE.MeshBasicMaterial({ color: '#d9d4c6', transparent: true, opacity: 0.6, depthWrite: false });

  constructor(private preset: BusPreset) {
    const { length: total, width: W, height: H } = preset.body;
    const art = preset.articulated;
    const rears = art ? (art.sections ?? 1) : 0;
    const L = art ? total - rears * (art.rearLength + art.gap) : total;
    this.frontLength = L;
    const car = preset.kind === 'car';
    const worm = isTrain(preset);
    if (car) this.exterior.add(...carExterior(preset));
    else if (worm) this.gusanitoExterior(preset, art!, rears);
    else if (art) this.articulatedExterior(preset, art);
    else this.busExterior(preset);
    this.exterior.traverse((o) => (o.castShadow = true));
    // The body's boxes draw as one mesh per material (each section on its own: they move apart).
    const sections = new Set<THREE.Object3D>(this.rearGroups);
    mergeParts(this.exterior, sections);
    for (const g of this.rearGroups) mergeParts(g, new Set());

    // Nitro flames out of two exhausts under the rear bumper, pointing backwards.
    const small = car || worm;
    const flameGeo = new THREE.ConeGeometry(small ? 0.12 : 0.22, small ? 1.0 : 1.6, 8);
    flameGeo.rotateZ(Math.PI / 2);
    flameGeo.translate(small ? -0.5 : -0.8, 0, 0);
    const outer = new THREE.MeshBasicMaterial({ color: '#3fa9ff', transparent: true, opacity: 0.75, depthWrite: false });
    const inner = new THREE.MeshBasicMaterial({ color: '#fff4c2' });
    for (const z of [-W * 0.25, W * 0.25]) {
      const flame = new THREE.Mesh(flameGeo, outer);
      const core = new THREE.Mesh(flameGeo, inner);
      core.scale.set(0.6, 0.5, 0.5);
      flame.add(core);
      flame.position.set(-(art ? art.rearLength : L) / 2, car ? -H * 0.3 : -H * 0.42, z);
      if (worm) flame.position.y = -H / 2 + 0.25;
      this.flames.add(flame);
    }
    this.flames.visible = false;
    (this.rearGroups[this.rearGroups.length - 1] ?? this.exterior).add(this.flames);

    // Cockpit: dashboard, pillars, roof edge and steering wheel seen from the driver seat.
    this.steeringWheel = steeringWheel(car || worm ? 0.18 : 0.22);
    if (car || worm) {
      const { parts, wheelMount } = worm ? gusanitoCockpit(preset, L) : carCockpit(preset);
      wheelMount.add(this.steeringWheel);
      this.cockpit.add(...parts, wheelMount);
    } else this.busCockpit(preset);
    mergeParts(this.cockpit, new Set([this.steeringWheel.parent!]));
    this.cockpit.visible = false;

    // Wheels
    const w = preset.wheels;
    const tireWidth = car || worm ? 0.2 : 0.4;
    const tire = new THREE.CylinderGeometry(w.radius, w.radius, tireWidth, 12);
    tire.rotateX(Math.PI / 2);
    const tireMat = flat('#1b1b1b');
    const hubMat = flat(car || worm ? '#d9d9d4' : '#bbbbbb');
    const axles: [number, number, number][] = [
      [w.frontOffset, -w.track, 0],
      [w.frontOffset, w.track, 0],
      [w.rearOffset, -w.track, 0],
      [w.rearOffset, w.track, 0],
    ];
    for (let i = 1; i <= rears; i++) axles.push([art!.rearAxle, -w.track, i], [art!.rearAxle, w.track, i]);
    const count: number[] = [];
    for (const [x, z, section] of axles) {
      const pivot = new THREE.Group();
      pivot.position.set(x, w.mountHeight, z);
      const spin = new THREE.Group();
      const mesh = new THREE.Mesh(tire, tireMat);
      mesh.castShadow = true;
      const hub = new THREE.Mesh(new THREE.BoxGeometry(w.radius * 0.9, w.radius * 0.3, tireWidth + 0.02), hubMat);
      // Inside the tire's outline: its shadow changes nothing, and with it the wheel is one mesh.
      hub.castShadow = true;
      spin.add(mesh, hub);
      mergeParts(spin, new Set());
      pivot.add(spin);
      (section ? this.rearGroups[section - 1] : this.exterior).add(pivot);
      count[section] = (count[section] ?? 0) + 1;
      this.wheels.push({ pivot, spin, section, index: count[section] - 1 });
    }

    // Spray: a fan of water out to each side of the front wheels, and a wake behind them.
    const fan = new THREE.ConeGeometry(0.6, 2.2, 8, 1, true);
    fan.translate(0, 1.1, 0);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(fan, this.sprayMat);
      m.position.set(w.frontOffset, w.mountHeight - w.radius * 0.6, side * (W / 2));
      m.rotation.set(side * 1.0, 0, 0.9);
      this.spray.add(m);
    }
    this.spray.visible = false;
    this.root.add(this.exterior, this.cockpit, this.spray);
  }

  /** Spray off the wheels, 0 (none) to 1 (wading flat out). */
  setSpray(k: number): void {
    this.spray.visible = k > 0.05;
    if (!this.spray.visible) return;
    for (const m of this.spray.children) m.scale.set(0.5 + k * 0.7, 0.3 + k * (0.8 + Math.random() * 0.3), 0.5 + k * 0.7);
    this.sprayMat.opacity = 0.35 + 0.3 * k;
  }

  private busExterior(preset: BusPreset): void {
    this.exterior.add(...this.busSection(preset, preset.body.length, true, true));
  }

  /**
   * One box-built bus body of length `L` (a whole bus, or one section of an articulated one):
   * windows, stripe, and a nose (windshield, headlights, sign) and/or a tail (tail lights).
   */
  private busSection(preset: BusPreset, L: number, nose: boolean, tail: boolean): THREE.Object3D[] {
    const { width: W, height: H, color, stripe, roof } = preset.body;
    const glass = flat('#1c2a38');
    const body = new THREE.Mesh(new THREE.BoxGeometry(L, H * 0.92, W), flat(color));
    body.position.y = -H * 0.04;
    const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(L * 0.98, H * 0.08, W * 0.96), flat(roof));
    roofMesh.position.y = H * 0.46;
    const band = new THREE.Mesh(new THREE.BoxGeometry(L + 0.02, H * 0.12, W + 0.02), flat(stripe));
    band.position.y = -H * 0.18;
    const sideWindows = new THREE.Mesh(new THREE.BoxGeometry(L * 0.72, H * 0.3, W + 0.04), glass);
    sideWindows.position.set(nose ? -L * 0.08 : 0, H * 0.16, 0);
    const out: THREE.Object3D[] = [body, roofMesh, band, sideWindows];
    if (nose) {
      const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.06, H * 0.42, W * 0.9), glass);
      windshield.position.set(L / 2 + 0.01, H * 0.12, 0);
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.2, H * 0.12, W * 1.02), flat('#333'));
      bumper.position.set(L / 2 + 0.05, -H * 0.4, 0);
      out.push(windshield, bumper, this.makeSign(preset, L, H, W));
      for (const z of [-W * 0.36, W * 0.36]) {
        const light = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.25, 0.4), new THREE.MeshBasicMaterial({ color: '#fff6c8' }));
        light.position.set(L / 2 + 0.04, -H * 0.28, z);
        out.push(light);
      }
    }
    if (tail)
      for (const z of [-W * 0.36, W * 0.36]) {
        const light = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: '#d42020' }));
        light.position.set(-L / 2 - 0.04, -H * 0.2, z);
        out.push(light);
      }
    return out;
  }

  /**
   * Articulated bus: a front section (in `exterior`) and a rear one (in `rearGroups`, posed by
   * `sync`), each with half of the black bellows over the turntable, and passenger doors on both
   * sides: right ones for street stops, left ones for BRT median platforms.
   */
  private articulatedExterior(preset: BusPreset, art: NonNullable<BusPreset['articulated']>): void {
    const { width: W, height: H } = preset.body;
    const Lf = this.frontLength;
    const Lr = art.rearLength;
    this.exterior.add(...this.busSection(preset, Lf, true, false));
    const rear = new THREE.Group();
    rear.add(...this.busSection(preset, Lr, false, true));
    this.rearGroups = [rear];
    this.exterior.add(rear);
    const bellowsMat = flat('#202225');
    const bellowsLen = art.gap / 2 + 0.25;
    for (const [group, x] of [
      [this.exterior, -(Lf / 2 + art.gap / 4 - 0.12)],
      [rear, Lr / 2 + art.gap / 4 - 0.12],
    ] as [THREE.Object3D, number][]) {
      const bellows = new THREE.Mesh(new THREE.BoxGeometry(bellowsLen, H * 0.88, W * 0.94), bellowsMat);
      bellows.position.set(x, -H * 0.04, 0);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(bellowsLen, 0.06, W * 0.9), flat('#777'));
      plate.position.set(x, -H * 0.5 + 0.02, 0);
      group.add(bellows, plate);
    }
    // Doors: a glazed double leaf with a yellow frame, on each side, one per section.
    const leaf = flat('#2a4458');
    const frame = flat('#f2c230');
    const door = (group: THREE.Object3D, x: number, side: number) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(1.5, H * 0.74, 0.04), frame);
      f.position.set(x, -H * 0.1, side * (W / 2 + 0.03));
      const g = new THREE.Mesh(new THREE.BoxGeometry(1.34, H * 0.66, 0.05), leaf);
      g.position.set(x, -H * 0.1, side * (W / 2 + 0.045));
      group.add(f, g);
    };
    for (const side of [-1, 1]) {
      door(this.exterior, Lf / 2 - 1.8, side);
      door(this.exterior, -Lf / 2 + 1.0, side);
      door(rear, Lr / 2 - 1.6, side);
      door(rear, -Lr / 2 + 2.2, side);
    }
  }

  /** The gusanito: its worm-faced head car (in `exterior`) and a wagon per rear section. */
  private gusanitoExterior(preset: BusPreset, art: NonNullable<BusPreset['articulated']>, n: number): void {
    this.exterior.add(...gusanitoHead(preset, this.frontLength));
    for (let i = 0; i < n; i++) {
      const wagon = new THREE.Group();
      wagon.add(...gusanitoWagon(preset, i, i === n - 1, art.gap));
      this.rearGroups.push(wagon);
      this.exterior.add(wagon);
    }
  }

  private busCockpit(preset: BusPreset): void {
    const { width: W, height: H, color } = preset.body;
    const L = this.frontLength;
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
    // Face the driver, then rake back (about the cross axis: in the default XYZ order the rake
    // would spin the wheel in its own plane, off center at rest).
    wheelMount.rotation.set(0, Math.PI / 2, -0.5, 'ZYX');
    wheelMount.add(this.steeringWheel);
    this.cockpit.add(wheelMount);
  }

  /**
   * Headlights for the dark: one real spot light lighting the road ahead (the only moving
   * light in the game; traffic gets fake beams on the road instead).
   */
  setHeadlights(on: boolean): void {
    if (!on || this.root.getObjectByName('headlights')) return;
    const L = this.frontLength;
    const { height: H } = this.preset.body;
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

    this.inv.copy(this.root.quaternion).invert();
    this.rearGroups.forEach((group, i) => {
      // Each rear section relative to the front one: inverse(front) * rear.
      const r = bus.rears[i].body;
      const tr = r.translation();
      const qr = r.rotation();
      group.position.set(tr.x - t.x, tr.y - t.y, tr.z - t.z).applyQuaternion(this.inv);
      group.quaternion.copy(this.inv).multiply(this.qTmp.set(qr.x, qr.y, qr.z, qr.w));
    });
    const mount = bus.preset.wheels.mountHeight;
    for (const { pivot, spin, section, index } of this.wheels) {
      const v = section ? bus.rears[section - 1].vehicle : bus.vehicle;
      pivot.position.y = mount - (v.wheelSuspensionLength(index) ?? 0);
      pivot.rotation.y = v.wheelSteering(index) ?? 0;
      spin.rotation.z = -(v.wheelRotation(index) ?? 0);
    }
    // Its axis points forward, away from the driver: negated so it turns counterclockwise, as
    // seen from the seat, when the wheels steer left.
    this.steeringWheel.rotation.z = -(bus.vehicle.wheelSteering(0) ?? 0) * 4;
    this.flames.visible = bus.boosting;
    if (bus.boosting) for (const f of this.flames.children) f.scale.x = 0.8 + Math.random() * 0.6;
  }

  private inv = new THREE.Quaternion();
  private qTmp = new THREE.Quaternion();

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
