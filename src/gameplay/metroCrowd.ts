import { Rng } from '../core/rng';
import type { MetroEntrance, Vec2 } from '../world/cityData';
import { forward, right } from '../world/cityData';
import { metroStairs } from '../world/metro';

const PER_ENTRANCE = 6;
const WALK_SPEED = 1.3;
/** How far below street level the stairs reach before people vanish (under the terrain). */
const STAIR_DEPTH = 2.6;
/** Beyond this distance from the bus, entrances are left alone. */
const ACTIVE_RANGE = 300;

type Stage = 'up' | 'away' | 'linger' | 'toward' | 'down';

export interface MetroRider {
  pos: Vec2;
  heading: number;
  speed: number;
  /** 'walk' or 'idle', for the view's walking bob. */
  mode: 'walk' | 'idle';
  look: number;
  /** Negative while on the stairs: how far below street level. */
  hop: number;
  lean: number;
  entrance: number;
  stage: Stage;
  target: Vec2;
  timer: number;
}

/**
 * People using the Metro: they come up the stairs of each entrance and walk off, while others
 * walk in and go down. Nobody pops in or out where the player can see it: new arrivals start
 * off-screen (`hidden`), and riders leave by sinking below the street down the stairs.
 */
export class MetroCrowd {
  readonly peds: MetroRider[] = [];
  private rng: Rng;

  constructor(
    private entrances: MetroEntrance[],
    opts: { seed?: number; walkable?: (p: Vec2) => boolean } = {},
  ) {
    this.rng = new Rng(opts.seed ?? 3);
    this.walkable = opts.walkable ?? (() => true);
    entrances.forEach((e, i) => {
      for (let k = 0; k < PER_ENTRANCE; k++) {
        const r = this.spawnBelow(i);
        // Spread the first wave out: some already on their way in or out.
        if (k % 2) this.startToward(r, this.spot(i), false);
        else (r.stage = 'linger'), (r.pos = this.spot(i)), (r.timer = this.rng.range(0, 6)), (r.hop = 0), (r.mode = 'idle');
        this.peds.push(r);
      }
    });
  }

  private walkable: (p: Vec2) => boolean;

  /** `hidden(p)`: true where a person may appear or vanish unseen (off-screen or far away). */
  update(dt: number, bus: Vec2, hidden: (p: Vec2) => boolean): void {
    for (const r of this.peds) {
      const e = this.entrances[r.entrance];
      if (Math.hypot(e.pos.x - bus.x, e.pos.z - bus.z) > ACTIVE_RANGE) continue;
      const stairs = metroStairs(e);
      switch (r.stage) {
        case 'up':
          // Still underground, waiting for a train.
          if (r.timer > 0) {
            r.timer -= dt;
            break;
          }
          if (this.walk(r, stairs.mouth, dt)) (r.stage = 'away'), (r.target = this.spot(r.entrance));
          r.hop = -STAIR_DEPTH * this.stairLeft(r, stairs);
          break;
        case 'away':
          if (this.walk(r, r.target, dt)) (r.stage = 'linger'), (r.timer = this.rng.range(2, 8)), (r.mode = 'idle');
          break;
        case 'linger':
          r.timer -= dt;
          // Gone once no one's looking: back as someone new, heading for the stairs.
          if (r.timer <= 0 && hidden(r.pos)) {
            const from = this.spot(r.entrance);
            if (hidden(from)) this.startToward(r, from, true);
          }
          break;
        case 'toward':
          if (this.walk(r, stairs.mouth, dt)) (r.stage = 'down'), (r.target = stairs.bottom);
          break;
        case 'down':
          r.hop = -STAIR_DEPTH * this.stairLeft(r, stairs);
          if (this.walk(r, stairs.bottom, dt)) Object.assign(r, this.spawnBelow(r.entrance, r));
          break;
      }
    }
  }

  /** 0 at the mouth of the stairs, 1 at the bottom. */
  private stairLeft(r: MetroRider, s: { bottom: Vec2; mouth: Vec2 }): number {
    const total = Math.hypot(s.mouth.x - s.bottom.x, s.mouth.z - s.bottom.z);
    const fromMouth = Math.hypot(r.pos.x - s.mouth.x, r.pos.z - s.mouth.z);
    return Math.min(1, fromMouth / total);
  }

  /** Steps toward `to`; true on arrival. */
  private walk(r: MetroRider, to: Vec2, dt: number): boolean {
    const dx = to.x - r.pos.x;
    const dz = to.z - r.pos.z;
    const d = Math.hypot(dx, dz);
    r.mode = 'walk';
    if (d < 0.05) return true;
    const step = Math.min(d, r.speed * dt);
    r.pos = { x: r.pos.x + (dx / d) * step, z: r.pos.z + (dz / d) * step };
    r.heading = Math.atan2(-dz, dx);
    return step >= d;
  }

  /** A fresh rider at the bottom of the stairs, about to come up. */
  private spawnBelow(entrance: number, reuse?: MetroRider): MetroRider {
    const { bottom, mouth } = metroStairs(this.entrances[entrance]);
    return {
      pos: { ...bottom },
      heading: Math.atan2(-(mouth.z - bottom.z), mouth.x - bottom.x),
      speed: WALK_SPEED * this.rng.range(0.8, 1.25),
      mode: 'walk',
      look: this.rng.next(),
      hop: -STAIR_DEPTH,
      lean: 0,
      entrance,
      stage: 'up',
      target: mouth,
      timer: reuse ? this.rng.range(0, 3) : 0,
    };
  }

  private startToward(r: MetroRider, from: Vec2, fresh: boolean): void {
    r.pos = from;
    r.stage = 'toward';
    r.hop = 0;
    r.mode = 'walk';
    if (fresh) (r.look = this.rng.next()), (r.speed = WALK_SPEED * this.rng.range(0.8, 1.25));
  }

  /** A walkable spot out front of an entrance, off to one side along the sidewalk. */
  private spot(entrance: number): Vec2 {
    const e = this.entrances[entrance];
    const { mouth } = metroStairs(e);
    const fw = forward(e.heading);
    const rt = right(e.heading);
    for (let tries = 0; tries < 12; tries++) {
      const along = this.rng.range(1, 4);
      const side = (this.rng.next() < 0.5 ? -1 : 1) * this.rng.range(5, 16);
      const p = { x: mouth.x + fw.x * along + rt.x * side, z: mouth.z + fw.z * along + rt.z * side };
      if (this.walkable(p)) return p;
    }
    return { x: mouth.x + fw.x, z: mouth.z + fw.z };
  }
}
