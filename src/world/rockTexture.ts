import * as THREE from 'three';

const SIZE = 256;
/** World meters one texture tile covers. */
const TILE_M = 9;

let cached: THREE.Texture | null | undefined;

/** Wrapping value noise on an n x n lattice. */
function lattice(n: number, seed: number): Float32Array {
  const g = new Float32Array(n * n);
  let s = seed >>> 0;
  for (let i = 0; i < g.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    g[i] = s / 4294967296;
  }
  return g;
}

function sample(g: Float32Array, n: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (a: number, b: number) => g[(((b % n) + n) % n) * n + (((a % n) + n) % n)];
  const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
  const bot = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
  return top + (bot - top) * sy;
}

/**
 * Grey rock with layered horizontal bands, grain and cracks, tileable, as a brightness multiplier
 * around 1 (RGB, slightly warm in the bands). Built once on a canvas; null without a DOM (Node tests),
 * where callers keep their plain colors.
 */
export function rockTexture(): THREE.Texture | null {
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') return (cached = null);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  if (!ctx) return (cached = null);
  const img = ctx.createImageData(SIZE, SIZE);
  // Mottling at ~0.5 m and ~4 m (the tile is TILE_M m wide), strata warp, and strata tone noise.
  const small = lattice(18, 31);
  const big = lattice(3, 19);
  const warp = lattice(3, 53);
  const strata = [lattice(4, 5), lattice(9, 6), lattice(21, 8)];
  // A few broad dark fractures, short and mostly near-vertical, blurred.
  const crack = new Float32Array(SIZE * SIZE);
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 3; k++) {
    let x = rnd() * SIZE;
    let y = rnd() * SIZE;
    let a = Math.PI / 2 + (rnd() - 0.5) * 0.5;
    const len = 30 + rnd() * 40;
    for (let i = 0; i < len; i++) {
      a += (rnd() - 0.5) * 0.25;
      x += Math.cos(a);
      y += Math.sin(a);
      for (let dx = -2; dx <= 2; dx++) {
        const px = (((Math.round(x) + dx) % SIZE) + SIZE) % SIZE;
        const py = ((Math.round(y) % SIZE) + SIZE) % SIZE;
        crack[py * SIZE + px] = 1;
      }
    }
  }
  const blur = new Float32Array(SIZE * SIZE);
  for (let pass = 0; pass < 4; pass++) {
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        let sum = 0;
        for (let d = -2; d <= 2; d++) sum += crack[y * SIZE + ((x + d + SIZE) % SIZE)] + crack[((y + d + SIZE) % SIZE) * SIZE + x];
        blur[y * SIZE + x] = sum / 10;
      }
    crack.set(blur);
  }
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // Strata: uneven bands from layered 1-D noise along a wavy v, soft edged, each a slightly different grey-brown.
      const w = v + (sample(warp, 3, u * 3, v * 3) - 0.5) * 0.09;
      const st = 0.5 * sample(strata[0], 4, w * 4, 0.5) + 0.3 * sample(strata[1], 9, w * 9, 1.5) + 0.2 * sample(strata[2], 21, w * 21, 2.5);
      const tone = 0.45 + 1.2 * st;
      const mott = 0.75 + 0.5 * sample(small, 18, u * 18, v * 18) + 0.55 * (sample(big, 3, u * 3, v * 3) - 0.5);
      let b = tone * mott;
      b *= 1 - 0.4 * Math.min(1, crack[y * SIZE + x] * 2.5);
      b = Math.max(0.2, Math.min(1.7, b));
      const k = (y * SIZE + x) * 4;
      const warm = tone - 1;
      img.data[k] = Math.min(255, b * 150 * (1 + 0.07 * warm));
      img.data[k + 1] = Math.min(255, b * 150);
      img.data[k + 2] = Math.min(255, b * 150 * (1 - 0.1 * warm));
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return (cached = tex);
}

function lattice1(i: number): number {
  let s = (Math.imul(i + 101, 2654435761) ^ 0x9e3779b9) >>> 0;
  s = (Math.imul(s ^ (s >>> 15), 2246822519) >>> 0) / 4294967296;
  return s;
}

/**
 * Lays the rock texture over a material's color in world space (triplanar: strata stay level on
 * every face). `slopeOnly`: only on faces steeper than the canyon's cliff slopes fades in (terrain);
 * otherwise everywhere (bore, portal rock). No-op without a texture (Node).
 */
export function applyRock(mat: THREE.Material, opts: { slopeOnly: boolean; strength?: number }): void {
  const tex = rockTexture();
  if (!tex) return;
  const strength = opts.strength ?? 1;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rockMap = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRockW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    // Face normal from the world position's derivatives: works on flat-shaded meshes with no normals.
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockW;\nuniform sampler2D rockMap;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 rn = normalize(cross(dFdx(vRockW), dFdy(vRockW)));
  vec3 w = pow(abs(rn), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-4);
  float sc = 1.0 / ${TILE_M.toFixed(1)};
  vec3 tx = texture2D(rockMap, vec2(vRockW.z, vRockW.y) * sc).rgb;
  vec3 ty = texture2D(rockMap, vec2(vRockW.x, vRockW.z) * sc * 1.3).rgb;
  vec3 tz = texture2D(rockMap, vec2(vRockW.x, vRockW.y) * sc).rgb;
  vec3 rock = tx * w.x + ty * w.y + tz * w.z;
  float m = ${opts.slopeOnly ? '(1.0 - smoothstep(0.76, 0.90, abs(rn.y)))' : '1.0'};
  diffuseColor.rgb *= mix(vec3(1.0), rock * 1.6, m * ${strength.toFixed(2)});
}`,
      );
  };
  mat.customProgramCacheKey = () => `rock-${opts.slopeOnly ? 's' : 'a'}-${strength}`;
  mat.needsUpdate = true;
}
