import * as THREE from 'three';
import type { CityData, Stop, Vec2 } from '../world/cityData';
import { forward, groundHeightAt, right } from '../world/cityData';
import type { BusPhysics } from '../vehicle/bus';
import type { Passenger, RouteStop } from './routeGame';

const SHIRTS = ['#d23c3c', '#2d6cc4', '#e8b21e', '#3d9a5a', '#8b4fb8', '#e27a2c', '#2fa6a6', '#f2f2f2'];
const PANTS = ['#2b3a55', '#3b3b3b', '#5a4632', '#1f2a2a'];
const SKIN = ['#c68a5b', '#a8704a', '#e0ac7e', '#8d5a3a'];
const RUN_SPEED = 4.5;
const WALK_AWAY = 7;

type Mode = 'waiting' | 'boarding' | 'leaving';

interface Figure {
  group: THREE.Group;
  mode: Mode;
  home: THREE.Vector3;
  target: THREE.Vector3;
  t: number;
  phase: number;
}

/** Low-poly people: waiting at stops, running to the door to board, walking off after alighting. */
export class PassengersView {
  private figures = new Map<number, Figure>();
  private leaving: Figure[] = [];
  private shared = {
    head: new THREE.IcosahedronGeometry(0.16, 0),
    torso: new THREE.BoxGeometry(0.42, 0.55, 0.26),
    legs: new THREE.BoxGeometry(0.36, 0.7, 0.22),
  };
  private materials = new Map<string, THREE.Material>();

  constructor(
    private scene: THREE.Scene,
    private city: CityData,
  ) {}

  /** Places the given passengers in a queue beside their stop's shelter (or along the platform edge). */
  showWaiting(stop: RouteStop, passengers: Passenger[]): void {
    const fw = forward(stop.stop.heading);
    // Away from the road: to the right of travel at the curb, to the left on a median platform.
    const left = stop.stop.side === 'left';
    const rt = right(stop.stop.heading + (left ? Math.PI : 0));
    passengers.forEach((p, k) => {
      if (this.figures.has(p.id)) return;
      const along = (k - (passengers.length - 1) / 2) * 0.9 + (k % 2 ? 0.2 : -0.2);
      const pos = this.at({ x: stop.stop.pos.x + fw.x * along + rt.x * 0.3, z: stop.stop.pos.z + fw.z * along + rt.z * 0.3 });
      const fig = this.make(p, pos);
      fig.group.rotation.y = stop.stop.heading + (left ? -Math.PI / 2 : Math.PI / 2); // face the street
      this.figures.set(p.id, fig);
    });
  }

  board(passengers: Passenger[]): void {
    for (const p of passengers) {
      const f = this.figures.get(p.id);
      if (f) (f.mode = 'boarding'), (f.t = 0);
    }
  }

  /**
   * Spawns figures at the door that walk away onto the sidewalk, or along a median platform
   * (`stop.side === 'left'`) toward its ends instead of off the far edge into traffic.
   */
  alight(passengers: Passenger[], bus: BusPhysics, stop: Stop): void {
    const left = stop.side === 'left';
    const door = this.doorPos(bus, left);
    const rt = right(bus.heading + (left ? Math.PI : 0));
    const fw = forward(bus.heading);
    passengers.forEach((p, k) => {
      const f = this.make(p, door.clone().add(new THREE.Vector3(-k * 0.4 * Math.cos(bus.heading), 0, k * 0.4 * Math.sin(bus.heading))));
      f.mode = 'leaving';
      if (left) {
        const along = (k % 2 ? 1 : -1) * (WALK_AWAY + k);
        f.target = this.at({ x: door.x + rt.x * 1.6 + fw.x * along, z: door.z + rt.z * 1.6 + fw.z * along });
      } else {
        f.target = this.at({ x: door.x + rt.x * 4 + (k - 1) * 1.5, z: door.z + rt.z * 4 });
        f.target.addScaledVector(new THREE.Vector3(f.target.x - door.x, 0, f.target.z - door.z).normalize(), WALK_AWAY);
      }
      this.leaving.push(f);
    });
  }

  clear(): void {
    for (const f of [...this.figures.values(), ...this.leaving]) this.scene.remove(f.group);
    this.figures.clear();
    this.leaving = [];
  }

  /** `leftDoor`: boarding at a median station, through the door on the left. */
  update(dt: number, bus: BusPhysics, leftDoor = false): void {
    const door = this.doorPos(bus, leftDoor);
    for (const [id, f] of this.figures) {
      f.phase += dt;
      if (f.mode === 'waiting') {
        f.group.position.y = f.home.y + Math.abs(Math.sin(f.phase * 2)) * 0.04;
      } else if (this.moveToward(f, door, dt, RUN_SPEED * 1.4) < 0.6) {
        this.scene.remove(f.group);
        this.figures.delete(id);
      }
    }
    this.leaving = this.leaving.filter((f) => {
      f.phase += dt;
      f.t += dt;
      this.moveToward(f, f.target, dt, RUN_SPEED * 0.5);
      if (f.t > 4) this.scene.remove(f.group);
      return f.t <= 4;
    });
  }

  /** Steps a figure toward `to` with a running bob; returns the remaining distance. */
  private moveToward(f: Figure, to: THREE.Vector3, dt: number, speed: number): number {
    const p = f.group.position;
    const dx = to.x - p.x;
    const dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const step = Math.min(d, speed * dt);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      f.group.rotation.y = Math.atan2(dx, dz);
    }
    p.y = groundHeightAt(this.city, { x: p.x, z: p.z }) + Math.abs(Math.sin(f.phase * 9)) * 0.12;
    return d;
  }

  /** Front door on the right-hand side of the bus (or the left), at street level. */
  private doorPos(bus: BusPhysics, left = false): THREE.Vector3 {
    const t = bus.body.translation();
    const fw = forward(bus.heading);
    const rt = right(bus.heading + (left ? Math.PI : 0));
    const L = bus.preset.body.length;
    const W = bus.preset.body.width;
    return this.at({ x: t.x + fw.x * (L / 2 - 1.3) + rt.x * (W / 2 + 0.3), z: t.z + fw.z * (L / 2 - 1.3) + rt.z * (W / 2 + 0.3) });
  }

  private at(p: Vec2): THREE.Vector3 {
    return new THREE.Vector3(p.x, groundHeightAt(this.city, p), p.z);
  }

  private make(p: Passenger, pos: THREE.Vector3): Figure {
    const pick = <T>(arr: T[], salt: number) => arr[Math.floor(((p.look * 997 + salt) % 1) * arr.length)];
    const g = new THREE.Group();
    const legs = new THREE.Mesh(this.shared.legs, this.mat(pick(PANTS, 0.31)));
    legs.position.y = 0.35;
    const torso = new THREE.Mesh(this.shared.torso, this.mat(pick(SHIRTS, 0.57)));
    torso.position.y = 0.97;
    const head = new THREE.Mesh(this.shared.head, this.mat(pick(SKIN, 0.13)));
    head.position.y = 1.42;
    for (const m of [legs, torso, head]) m.castShadow = true;
    g.add(legs, torso, head);
    g.position.copy(pos);
    this.scene.add(g);
    return { group: g, mode: 'waiting', home: pos.clone(), target: pos.clone(), t: 0, phase: p.look * 10 };
  }

  private mat(color: string): THREE.Material {
    let m = this.materials.get(color);
    if (!m) this.materials.set(color, (m = new THREE.MeshLambertMaterial({ color, flatShading: true })));
    return m;
  }
}
