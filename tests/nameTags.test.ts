import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { NameTags } from '../src/ui/nameTags';
import { AI_COLOR, SEAT_COLORS, seatColor } from '../src/net/colors';

describe('online name tags', () => {
  it('each seat its own color, the AI grey', () => {
    expect(new Set([0, 1, 2, 3, 4, 5].map(seatColor)).size).toBe(6);
    expect(seatColor(7)).toBe(SEAT_COLORS[1]);
    expect(SEAT_COLORS).not.toContain(AI_COLOR);
  });

  it('without a DOM makes no tags and updates without throwing', () => {
    const tags = new NameTags(new THREE.Scene());
    const bus = { preset: { body: { height: 3 } }, position: () => ({ x: 0, y: 1, z: 0 }) } as never;
    tags.add(bus, 'Ana', seatColor(0));
    expect(tags.count).toBe(0);
    tags.update(new THREE.PerspectiveCamera());
    tags.dispose();
  });
});
