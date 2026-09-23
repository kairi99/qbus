/**
 * Regular height grid over the ground plane. Heights are meters above the city's lowest
 * point; `scale` exaggerates (or flattens) the relief at runtime without re-importing.
 */
export interface Terrain {
  minX: number;
  minZ: number;
  cell: number;
  /** Vertices along x. */
  cols: number;
  /** Vertices along z. */
  rows: number;
  /** Row-major: heights[row * cols + col], row along +z, col along +x. */
  heights: number[];
  scale: number;
}

export function terrainHeight(t: Terrain, x: number, z: number): number {
  const fx = Math.max(0, Math.min(t.cols - 1.0001, (x - t.minX) / t.cell));
  const fz = Math.max(0, Math.min(t.rows - 1.0001, (z - t.minZ) / t.cell));
  const c = Math.floor(fx);
  const r = Math.floor(fz);
  const u = fx - c;
  const v = fz - r;
  const h = t.heights;
  const i = r * t.cols + c;
  // Each cell is two triangles split along (r, c+1)-(r+1, c), exactly like the rendered mesh
  // and Rapier's heightfield, so whatever sits on the ground sits on what's drawn and simulated.
  const h00 = h[i];
  const h01 = h[i + 1];
  const h10 = h[i + t.cols];
  const h11 = h[i + t.cols + 1];
  const y = u + v <= 1 ? h00 + (h01 - h00) * u + (h10 - h00) * v : h11 + (h10 - h11) * (1 - u) + (h01 - h11) * (1 - v);
  return y * t.scale;
}

export function terrainMaxX(t: Terrain): number {
  return t.minX + (t.cols - 1) * t.cell;
}

export function terrainMaxZ(t: Terrain): number {
  return t.minZ + (t.rows - 1) * t.cell;
}

/** Separable box blur applied `passes` times (≈ gaussian); smooths away DSM building bumps. */
export function smoothHeights(h: number[], cols: number, rows: number, radius: number, passes = 3): number[] {
  let a = h.slice();
  let b = new Array<number>(h.length);
  const blur = (src: number[], dst: number[], along: 'x' | 'z') => {
    const n = along === 'x' ? cols : rows;
    const m = along === 'x' ? rows : cols;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -radius; k <= radius; k++) {
          const ii = Math.max(0, Math.min(n - 1, i + k));
          sum += along === 'x' ? src[j * cols + ii] : src[ii * cols + j];
          cnt++;
        }
        dst[along === 'x' ? j * cols + i : i * cols + j] = sum / cnt;
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    blur(a, b, 'x');
    blur(b, a, 'z');
  }
  return a;
}
