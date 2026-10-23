import * as THREE from 'three';
import type { TrackData } from './track';

export type BiomeId = NonNullable<TrackData['biome']>;

/** Everything about a race track that depends on what grows there (trackBuilder, backdrop). */
export interface Biome {
  /** Ground colors: `low`/`high` blend with altitude along the track, steep slopes turn `earth` then `rock`, `gravel` at the road. */
  terrain: { low: string; high: string; earth: string; rock: string; gravel: string };
  /** Far mountains by height over the valley floor (m): color bands. */
  far: [number, string][];
  plants: {
    /** Tries per `TREE_STEP` m of road per side, and how far out they range (m). */
    tries: number;
    reach: number;
    /** Share of trees at the bottom of the track, fading by `altFade` at the top. */
    treeProb: number;
    altFade: number;
    /** Of what isn't a tree: tree ferns and bamboo clumps (0 = none), then shrubs; the rest is rock. */
    fernProb: number;
    bambooProb: number;
    shrubProb: number;
    /** Size ranges (tree, shrub, rock, fern, bamboo) and trees' height over width. */
    size: { tree: [number, number]; shrub: [number, number]; rock: [number, number]; fern: [number, number]; bamboo: [number, number] };
    stretch: [number, number];
    /** Leaf hue and saturation, lightness range; rocks' hue, saturation, lightness range. */
    leaf: { h: number; s: number; l: [number, number] };
    stone: { h: number; s: number; l: [number, number] };
  };
  /** Big crowns leaning over the road (visual only), one every `every` m per side up to `reach` m past the trunk clearance, `lean` m of lean; null = none. */
  canopy: { every: number; reach: number; lean: number } | null;
  /** Slope (rise per run) where the ground turns bare earth, then rock (absent: 0.9, 1.3). */
  cliff?: { earth: number; rock: number };
  mist: {
    /** Where the misty stretches on the road start (share of the raced length) and how long they are (m). */
    zones: number[];
    length: number;
    /** Cloud banks on the valley sides: one per this many m of road, their height over the road (m), thickness. */
    bankStep: number;
    bankRise: [number, number];
    bankAlpha: [number, number];
    /** Puffs on the road per 7 m (and their thickest alpha). */
    perStep: number;
    roadAlpha: number;
  };
}

export const BIOMES: Record<BiomeId, Biome> = {
  // The páramo above Papallacta: grass and rock, trees only low down, two misty stretches.
  paramo: {
    terrain: { low: '#4d7337', high: '#a39f58', earth: '#8a7660', rock: '#77736d', gravel: '#9a907f' },
    far: [
      [0, '#4d6f37'],
      [600, '#5c7b43'],
      [1100, '#98985d'],
      [1700, '#8a857a'],
      [2300, '#7d7a74'],
      [2500, '#eef0f3'],
    ],
    plants: {
      tries: 3,
      reach: 240,
      treeProb: 0.8,
      altFade: 0.75,
      fernProb: 0,
      bambooProb: 0,
      shrubProb: 0.75,
      size: { tree: [0.8, 1.5], shrub: [0.6, 1.3], rock: [0.5, 1.6], fern: [1, 1], bamboo: [1, 1] },
      stretch: [0.85, 1.25],
      leaf: { h: 0.22, s: 0.45, l: [0.42, 0.58] },
      stone: { h: 0.08, s: 0.05, l: [0.42, 0.55] },
    },
    canopy: null,
    mist: { zones: [0.32, 0.7], length: 320, bankStep: 45, bankRise: [40, 250], bankAlpha: [0.35, 0.65], perStep: 2, roadAlpha: 0.32 },
  },
  // The cloud forest on the road to Santo Domingo: deep greens, red earth, tall dense trees, tree ferns,
  // guadua, mossy rocks, a roof of crowns over the road and mist sitting low in the quebradas.
  cloudforest: {
    terrain: { low: '#2f5a2c', high: '#436b30', earth: '#8a4f35', rock: '#5f6a52', gravel: '#8d7a66' },
    far: [
      [0, '#355b2d'],
      [600, '#3f6a33'],
      [1100, '#4d7539'],
      [1700, '#62804a'],
      [2300, '#7b8266'],
      [2500, '#9aa088'],
    ],
    plants: {
      tries: 4,
      reach: 180,
      treeProb: 0.7,
      altFade: 0.2,
      fernProb: 0.4,
      bambooProb: 0.3,
      shrubProb: 0.8,
      size: { tree: [1, 1.9], shrub: [0.7, 1.5], rock: [0.5, 1.7], fern: [0.9, 1.5], bamboo: [0.8, 1.4] },
      stretch: [0.9, 1.6],
      leaf: { h: 0.29, s: 0.55, l: [0.2, 0.34] },
      stone: { h: 0.25, s: 0.3, l: [0.32, 0.46] },
    },
    canopy: { every: 5, reach: 7, lean: 5 },
    mist: { zones: [0.1, 0.27, 0.44, 0.61, 0.78, 0.9], length: 420, bankStep: 30, bankRise: [-30, 130], bankAlpha: [0.4, 0.75], perStep: 3, roadAlpha: 0.4 },
  },
  // The Pastaza gorge on the Ruta de las Cascadas: grey-brown rock cliffs with subtropical green on the
  // gentler slopes and the tops, tree ferns and guadua, a little mist hanging in the gorge. No canopy
  // over the road: it is cut into the rock.
  canyon: {
    terrain: { low: '#3b6a33', high: '#587b3a', earth: '#7d6a56', rock: '#827b72', gravel: '#9a9082' },
    far: [
      [0, '#36602f'],
      [600, '#41703a'],
      [1100, '#55803f'],
      [1700, '#6f8758'],
      [2300, '#8d9378'],
      [2500, '#a7ab98'],
    ],
    plants: {
      tries: 3,
      reach: 200,
      treeProb: 0.65,
      altFade: 0.1,
      fernProb: 0.35,
      bambooProb: 0.25,
      shrubProb: 0.8,
      size: { tree: [0.9, 1.7], shrub: [0.7, 1.4], rock: [0.5, 1.7], fern: [0.9, 1.4], bamboo: [0.8, 1.3] },
      stretch: [0.9, 1.5],
      leaf: { h: 0.28, s: 0.5, l: [0.22, 0.38] },
      stone: { h: 0.09, s: 0.08, l: [0.36, 0.5] },
    },
    canopy: null,
    cliff: { earth: 0.55, rock: 0.85 },
    mist: { zones: [0.22, 0.6, 0.88], length: 300, bankStep: 55, bankRise: [-20, 120], bankAlpha: [0.25, 0.5], perStep: 1, roadAlpha: 0.2 },
  },
};

/** The biome of a track (páramo unless it says otherwise). */
export function biomeOf(race: Pick<TrackData, 'biome'> | undefined): Biome {
  return BIOMES[race?.biome ?? 'paramo'];
}

/** A biome's terrain colors as three.js colors. */
export function terrainColors(b: Biome): Record<keyof Biome['terrain'], THREE.Color> {
  const t = b.terrain;
  return { low: new THREE.Color(t.low), high: new THREE.Color(t.high), earth: new THREE.Color(t.earth), rock: new THREE.Color(t.rock), gravel: new THREE.Color(t.gravel) };
}
