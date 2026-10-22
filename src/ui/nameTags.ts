import * as THREE from 'three';
import type { BusPhysics } from '../vehicle/bus';

/** Tags past this distance from the camera (m) are hidden; they fade from FADE_FROM on. */
const RANGE = 260;
const FADE_FROM = 120;
/** Height of a tag on screen (sizeAttenuation off: a share of the view's height). */
const SCREEN_H = 0.075;
/** Over the roof (m). */
const LIFT = 1.5;
const CANVAS_W = 256;
const CANVAS_H = 64;

interface Tag {
  bus: BusPhysics;
  sprite: THREE.Sprite;
  top: number;
  name: string;
  color: string;
  note: boolean;
}

/** Draws a pill in the racer's color with a dark rim, the name in white with a dark outline; `off`: dimmed, with a note. */
function paint(c: HTMLCanvasElement, name: string, color: string, off: boolean): void {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, CANVAS_W, CANVAS_H);
  g.font = '800 34px system-ui, sans-serif';
  const text = name.length > 14 ? `${name.slice(0, 13)}…` : name;
  const w = Math.min(CANVAS_W - 8, g.measureText(text).width + 40);
  const x = (CANVAS_W - w) / 2;
  g.globalAlpha = off ? 0.5 : 1;
  g.fillStyle = 'rgba(20, 22, 28, 0.85)';
  g.beginPath();
  g.roundRect(x - 3, 5, w + 6, off ? 40 : CANVAS_H - 10, 27);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(x, 8, w, off ? 34 : CANVAS_H - 16, 24);
  g.fill();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(20, 22, 28, 0.9)';
  const y = off ? 25 : CANVAS_H / 2 + 1;
  g.strokeText(text, CANVAS_W / 2, y);
  g.fillStyle = '#ffffff';
  g.fillText(text, CANVAS_W / 2, y);
  if (off) {
    g.font = '700 18px system-ui, sans-serif';
    g.lineWidth = 4;
    g.strokeText('(desconectado)', CANVAS_W / 2, 55);
    g.fillText('(desconectado)', CANVAS_W / 2, 55);
  }
}

/**
 * Racers' names floating over their buses (online: who is who), one sprite each in the racer's
 * color: the same screen size near and far, readable through other buses, gone past RANGE.
 * Without a DOM (Node tests) no tags are made.
 */
export class NameTags {
  private tags: Tag[] = [];
  private at = { x: 0, y: 0, z: 0 };

  constructor(private scene: THREE.Scene) {}

  add(bus: BusPhysics, name: string, color: string): void {
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = CANVAS_W;
    c.height = CANVAS_H;
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, fog: false }));
    sprite.scale.set((SCREEN_H * CANVAS_W) / CANVAS_H, SCREEN_H, 1);
    sprite.renderOrder = 10;
    sprite.name = `tag-${name}`;
    this.scene.add(sprite);
    const tag: Tag = { bus, sprite, top: bus.preset.body.height / 2 + LIFT, name, color, note: false };
    paint(c, name, color, false);
    this.tags.push(tag);
  }

  /** Marks (or not) a tag as disconnected: "(desconectado)" under a dimmed pill. */
  setNote(bus: BusPhysics, on: boolean): void {
    const t = this.tags.find((x) => x.bus === bus);
    if (!t || t.note === on) return;
    t.note = on;
    const map = t.sprite.material.map as THREE.CanvasTexture;
    paint(map.image as HTMLCanvasElement, t.name, t.color, on);
    map.needsUpdate = true;
  }

  /** Takes the tag over `bus` out for good. */
  remove(bus: BusPhysics): void {
    const i = this.tags.findIndex((x) => x.bus === bus);
    if (i < 0) return;
    const t = this.tags[i];
    this.scene.remove(t.sprite);
    t.sprite.material.map?.dispose();
    t.sprite.material.dispose();
    this.tags.splice(i, 1);
  }

  /** Each frame: over the middle of each vehicle (a train's too), faded with distance. */
  update(camera: THREE.Camera): void {
    const cam = camera.position;
    for (const t of this.tags) {
      const p = t.bus.position(this.at);
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      t.sprite.visible = d < RANGE;
      if (!t.sprite.visible) continue;
      t.sprite.position.set(p.x, p.y + t.top, p.z);
      (t.sprite.material as THREE.SpriteMaterial).opacity = d < FADE_FROM ? 1 : 1 - (0.6 * (d - FADE_FROM)) / (RANGE - FADE_FROM);
    }
  }

  /** The tag over `bus`, if any (tests). */
  of(name: string): THREE.Sprite | null {
    return this.tags.find((t) => t.sprite.name === `tag-${name}`)?.sprite ?? null;
  }

  get count(): number {
    return this.tags.length;
  }

  dispose(): void {
    for (const t of this.tags) {
      this.scene.remove(t.sprite);
      t.sprite.material.map?.dispose();
      t.sprite.material.dispose();
    }
    this.tags.length = 0;
  }
}
