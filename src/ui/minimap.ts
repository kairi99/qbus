import type { CityData, Vec2 } from '../world/cityData';

const SIZE = 210;
/** Meters from the bus to the edge of the map. */
const RANGE = 230;
/** Resolution of the pre-rendered street map. */
const PX_PER_M = 1;

/**
 * Round, heading-up minimap: streets (pre-rendered once), the stops of the route, the legal
 * path to the next stop, and the bus in the middle pointing up.
 */
export class MiniMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private streets: HTMLCanvasElement;
  private min: Vec2;

  constructor(
    host: HTMLElement,
    private city: CityData,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gh-minimap';
    this.canvas.width = this.canvas.height = SIZE * devicePixelRatio;
    this.canvas.style.width = this.canvas.style.height = `${SIZE}px`;
    this.canvas.setAttribute('aria-label', 'Mapa');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const { min, max } = city.bounds;
    this.min = { x: min.x - 50, z: min.z - 50 };
    this.streets = document.createElement('canvas');
    this.streets.width = Math.ceil((max.x - min.x + 100) * PX_PER_M);
    this.streets.height = Math.ceil((max.z - min.z + 100) * PX_PER_M);
    this.drawStreets();
  }

  update(bus: Vec2, heading: number, path: Vec2[] | null, target: Vec2 | null, targetColor: string, stops: Vec2[]): void {
    const c = this.ctx;
    const k = (SIZE * devicePixelRatio) / 2 / RANGE;
    const half = (SIZE * devicePixelRatio) / 2;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.save();
    c.beginPath();
    c.arc(half, half, half, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#e8e2d2';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // World → map: bus at the center, its forward direction pointing up.
    c.translate(half, half);
    c.rotate(heading - Math.PI / 2);
    c.scale(k, k);
    c.translate(-bus.x, -bus.z);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.streets, this.min.x, this.min.z, this.streets.width / PX_PER_M, this.streets.height / PX_PER_M);

    if (path && path.length > 1) {
      c.strokeStyle = targetColor;
      c.lineWidth = 7;
      c.lineJoin = c.lineCap = 'round';
      c.beginPath();
      path.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.stroke();
    }
    c.fillStyle = '#1d1a14';
    for (const s of stops) {
      c.beginPath();
      c.arc(s.x, s.z, 5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // Target: on the map if in range, otherwise pinned to the rim in its direction.
    if (target) {
      const dx = target.x - bus.x;
      const dz = target.z - bus.z;
      const a = heading - Math.PI / 2;
      const sx = (dx * Math.cos(a) - dz * Math.sin(a)) * k;
      const sy = (dx * Math.sin(a) + dz * Math.cos(a)) * k;
      const r = Math.hypot(sx, sy);
      const lim = half - 12 * devicePixelRatio;
      const f = r > lim ? lim / r : 1;
      c.fillStyle = targetColor;
      c.strokeStyle = '#1d1a14';
      c.lineWidth = 2 * devicePixelRatio;
      c.beginPath();
      c.arc(half + sx * f, half + sy * f, 8 * devicePixelRatio, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }

    // The bus: an arrowhead in the middle, always pointing up.
    const s = devicePixelRatio;
    c.fillStyle = '#1f5fbf';
    c.strokeStyle = '#fff';
    c.lineWidth = 2 * s;
    c.beginPath();
    c.moveTo(half, half - 11 * s);
    c.lineTo(half + 8 * s, half + 9 * s);
    c.lineTo(half, half + 4 * s);
    c.lineTo(half - 8 * s, half + 9 * s);
    c.closePath();
    c.fill();
    c.stroke();

    // Rim.
    c.strokeStyle = '#1d1a14';
    c.lineWidth = 4 * s;
    c.beginPath();
    c.arc(half, half, half - 2 * s, 0, Math.PI * 2);
    c.stroke();
  }

  private drawStreets(): void {
    const c = this.streets.getContext('2d')!;
    c.scale(PX_PER_M, PX_PER_M);
    c.translate(-this.min.x, -this.min.z);
    c.lineCap = c.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const r of this.city.roads) {
        // Outline pass, then fill: gives streets a crisp edge.
        c.strokeStyle = pass === 0 ? '#b9b0a0' : r.kind === 'avenue' ? '#ffffff' : '#fbf8f1';
        c.lineWidth = r.width + (pass === 0 ? 3 : 0);
        c.beginPath();
        r.points.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
        c.stroke();
      }
    }
    c.fillStyle = '#9bbf85';
    for (const park of this.city.parks ?? []) {
      c.beginPath();
      park.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.fill();
    }
  }
}
