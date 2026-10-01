import type { MetroEntrance, Vec2 } from './cityData';
import { forward } from './cityData';

/** Footprint of a Metro entrance canopy (length along its heading) and its roof height. */
export const METRO_ENTRANCE = { length: 5, width: 3.2, roof: 2.8 };

/** The spot at the bottom of an entrance's stairs, and the mouth at street level. */
export function metroStairs(e: MetroEntrance): { bottom: Vec2; mouth: Vec2 } {
  const fw = forward(e.heading);
  const k = METRO_ENTRANCE.length / 2;
  return {
    bottom: { x: e.pos.x - fw.x * (k - 0.6), z: e.pos.z - fw.z * (k - 0.6) },
    mouth: { x: e.pos.x + fw.x * (k + 0.4), z: e.pos.z + fw.z * (k + 0.4) },
  };
}
