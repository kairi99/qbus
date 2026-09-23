import type { BusPreset } from '../vehicle/busPreset';
import { BUSES, busStats } from '../vehicle/buses';
import { ZONE_LIST, loadZone } from '../world/loadCity';
import type { CityData } from '../world/cityData';
import { type RouteDef, routesFor } from '../gameplay/routes';
import { HILLS_OPTIONS, type Settings, loadSettings, saveSettings } from './settings';

export interface Selection {
  bus: string;
  zone: string;
  route: string;
}

/** URL that starts a shift with this selection (the game reads it on load). */
export function playUrl(s: Selection): string {
  return `?${new URLSearchParams({ play: '1', city: s.zone, bus: s.bus, route: s.route })}`;
}

/**
 * Title screen and shift setup (bus, zone, route) plus settings. Pure DOM; the game itself
 * isn't loaded until the player presses ¡Arranca!, which navigates to playUrl().
 */
export class Menu {
  private root: HTMLElement;
  private settings: Settings;
  private cities = new Map<string, Promise<CityData>>();

  constructor(host: HTMLElement) {
    this.settings = loadSettings();
    this.root = document.createElement('div');
    this.root.className = 'mn';
    host.appendChild(this.root);
    this.title();
  }

  // ---- screens ------------------------------------------------------------

  private title(): void {
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-title">
        <div class="mn-led mn-logo" aria-label="QBus"><span>QBUS</span></div>
        <p class="mn-tag">Maneje como chofer quiteño: rápido, sin frenar y pitando.</p>
        <nav class="mn-title-actions">
          <button class="mn-btn mn-btn-go" data-go="setup">Jugar</button>
          <button class="mn-btn" data-go="settings">Ajustes</button>
        </nav>
        <p class="mn-foot">Mapa © OpenStreetMap · Relieve Copernicus GLO-30</p>
      </main>`;
    this.on('[data-go="setup"]', () => this.setup());
    this.on('[data-go="settings"]', () => this.settingsScreen(() => this.title()));
    this.focusFirst();
  }

  private setup(): void {
    const s = this.settings;
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-setup">
        <header class="mn-head">
          <button class="mn-back" data-go="back" aria-label="Volver">‹</button>
          <div class="mn-led mn-led-wide"><span>ELIJA SU TURNO</span></div>
        </header>
        <section class="mn-step">
          <h2>El bus</h2>
          <div class="mn-row" role="radiogroup" aria-label="Bus">${BUSES.map((b) => busCard(b.preset, b.blurb, b.preset.id === s.bus)).join('')}</div>
        </section>
        <section class="mn-step">
          <h2>La zona</h2>
          <div class="mn-row" role="radiogroup" aria-label="Zona">${ZONE_LIST.map((z) => zoneCard(z, z.id === s.zone)).join('')}</div>
        </section>
        <section class="mn-step mn-step-route">
          <h2>La ruta</h2>
          <div class="mn-routes">
            <div class="mn-placards" role="radiogroup" aria-label="Ruta"><p class="mn-loading">Cargando rutas…</p></div>
            <canvas class="mn-map" width="360" height="360" aria-label="Mapa de la ruta"></canvas>
          </div>
        </section>
        <footer class="mn-bar">
          <p class="mn-summary"></p>
          <button class="mn-btn mn-btn-go" data-go="play" disabled>¡Arranca!</button>
        </footer>
      </main>`;
    this.on('[data-go="back"]', () => this.title());
    this.root.querySelectorAll<HTMLElement>('[data-bus]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('bus', el.dataset.bus!);
        this.mark('[data-bus]', el);
      }),
    );
    this.root.querySelectorAll<HTMLElement>('[data-zone]').forEach((el) =>
      el.addEventListener('click', () => {
        if (this.settings.zone !== el.dataset.zone) this.pick('route', 'circuito');
        this.pick('zone', el.dataset.zone!);
        this.mark('[data-zone]', el);
        this.showRoutes();
      }),
    );
    this.on('[data-go="play"]', () => {
      saveSettings(this.settings);
      location.search = playUrl(this.settings);
    });
    this.showRoutes();
    this.root.querySelector<HTMLElement>('[data-bus][aria-checked="true"]')?.focus();
  }

  private settingsScreen(back: () => void): void {
    const s = this.settings;
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-settings">
        <header class="mn-head">
          <button class="mn-back" data-go="back" aria-label="Volver">‹</button>
          <div class="mn-led mn-led-wide"><span>AJUSTES</span></div>
        </header>
        <div class="mn-panel">
          <fieldset>
            <legend>Cámara al empezar</legend>
            ${choice('camera', 'chase', 'Tercera persona', s.camera === 'chase')}
            ${choice('camera', 'cockpit', 'Conductor', s.camera === 'cockpit')}
          </fieldset>
          <fieldset>
            <legend>Cuestas (zonas reales)</legend>
            ${HILLS_OPTIONS.map((o) => choice('hills', String(o.value), o.label, s.hills === o.value)).join('')}
          </fieldset>
          <label class="mn-volume">
            <span>Volumen</span>
            <input type="range" min="0" max="100" step="5" value="${Math.round(s.volume * 100)}" name="volume" />
            <output>${Math.round(s.volume * 100)}%</output>
          </label>
        </div>
      </main>`;
    this.on('[data-go="back"]', back);
    this.root.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.name === 'camera') this.settings.camera = el.value as Settings['camera'];
        if (el.name === 'hills') this.settings.hills = Number(el.value);
        saveSettings(this.settings);
      }),
    );
    const vol = this.root.querySelector<HTMLInputElement>('input[name="volume"]')!;
    vol.addEventListener('input', () => {
      this.settings.volume = Number(vol.value) / 100;
      this.root.querySelector('output')!.textContent = `${vol.value}%`;
      saveSettings(this.settings);
    });
    this.focusFirst();
  }

  // ---- routes ---------------------------------------------------------------

  private async showRoutes(): Promise<void> {
    const zone = this.settings.zone;
    const box = this.root.querySelector<HTMLElement>('.mn-placards')!;
    const play = this.root.querySelector<HTMLButtonElement>('[data-go="play"]')!;
    box.innerHTML = '<p class="mn-loading">Cargando rutas…</p>';
    play.disabled = true;
    if (!this.cities.has(zone)) this.cities.set(zone, loadZone(zone));
    const city = await this.cities.get(zone)!;
    if (this.settings.zone !== zone || !box.isConnected) return; // switched zone meanwhile
    const routes = routesFor(city);
    if (!routes.some((r) => r.id === this.settings.route)) this.pick('route', routes[0].id);
    const names = new Map(city.stops.map((st) => [st.id, st.name]));
    box.innerHTML = routes.map((r) => placard(r, names, r.id === this.settings.route)).join('');
    box.querySelectorAll<HTMLElement>('[data-route]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('route', el.dataset.route!);
        this.mark('[data-route]', el);
        drawMap(this.root.querySelector('canvas')!, city, routes.find((r) => r.id === el.dataset.route)!);
      }),
    );
    drawMap(this.root.querySelector('canvas')!, city, routes.find((r) => r.id === this.settings.route)!);
    play.disabled = false;
    this.summary();
  }

  // ---- helpers ---------------------------------------------------------------

  private pick<K extends keyof Selection>(k: K, v: string): void {
    this.settings[k] = v;
    this.summary();
  }

  private summary(): void {
    const el = this.root.querySelector('.mn-summary');
    if (!el) return;
    const bus = BUSES.find((b) => b.preset.id === this.settings.bus)?.preset.name ?? '';
    const zone = ZONE_LIST.find((z) => z.id === this.settings.zone)?.name ?? '';
    const route = this.root.querySelector(`[data-route="${this.settings.route}"] .mn-placard-name`)?.textContent ?? '';
    el.textContent = [bus, zone, route].filter(Boolean).join(', ');
  }

  private mark(selector: string, chosen: HTMLElement): void {
    this.root.querySelectorAll<HTMLElement>(selector).forEach((el) => el.setAttribute('aria-checked', String(el === chosen)));
  }

  private on(selector: string, fn: () => void): void {
    this.root.querySelector(selector)?.addEventListener('click', fn);
  }

  private focusFirst(): void {
    this.root.querySelector<HTMLElement>('button, input')?.focus();
  }
}

// ---- markup ------------------------------------------------------------------

/** Low-poly Pichincha and friends behind every menu screen. */
const SKYLINE = `
  <svg class="mn-sky" viewBox="0 0 1600 500" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <polygon points="0,500 0,300 170,190 330,270 520,120 700,250 860,170 1010,260 1180,150 1360,240 1600,180 1600,500" fill="#a9bba5"/>
    <polygon points="0,500 0,360 220,300 420,360 640,280 880,350 1100,300 1330,360 1600,310 1600,500" fill="#8ea88a"/>
    <polygon points="1180,150 1230,185 1150,190" fill="#f4f6f8"/>
  </svg>`;

function busCard(p: BusPreset, blurb: string, checked: boolean): string {
  const { color, stripe, roof } = p.body;
  // Side view scaled to the bus's real length, so the buseta looks small and the coach long.
  const w = 70 + p.body.length * 11;
  return `
    <button class="mn-card mn-bus" role="radio" aria-checked="${checked}" data-bus="${p.id}">
      <svg class="mn-bus-art" viewBox="0 0 220 80" aria-hidden="true">
        <g transform="translate(${(220 - w) / 2},8)">
          <rect x="0" y="0" width="${w}" height="10" rx="4" fill="${roof}"/>
          <rect x="0" y="6" width="${w}" height="48" rx="6" fill="${color}"/>
          <rect x="10" y="14" width="${w - 34}" height="16" rx="2" fill="#1c2a38"/>
          <rect x="${w - 20}" y="12" width="16" height="30" rx="2" fill="#1c2a38"/>
          <rect x="0" y="36" width="${w}" height="6" fill="${stripe}"/>
          <circle cx="${w * 0.2}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.2}" cy="56" r="3.5" fill="#bbb"/>
          <circle cx="${w * 0.8}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.8}" cy="56" r="3.5" fill="#bbb"/>
        </g>
      </svg>
      <span class="mn-card-name">${p.name}</span>
      <span class="mn-card-blurb">${blurb}</span>
      <dl class="mn-stats">${busStats(p)
        .map((st) => `<dt>${st.label}</dt><dd><span style="--v:${st.value.toFixed(2)}"></span></dd>`)
        .join('')}</dl>
      <span class="mn-card-cap">${p.capacity} pasajeros · ${p.topSpeedKmh} km/h</span>
    </button>`;
}

function zoneCard(z: { id: string; name: string; blurb: string }, checked: boolean): string {
  return `
    <button class="mn-card mn-zone" role="radio" aria-checked="${checked}" data-zone="${z.id}">
      <span class="mn-card-name">${z.name}</span>
      <span class="mn-card-blurb">${z.blurb}</span>
    </button>`;
}

/** Route as a windshield placard: route name on top, main stops underneath. */
function placard(r: RouteDef, names: Map<string, string>, checked: boolean): string {
  const stops = r.stops.map((id) => names.get(id) ?? '');
  const shown = [...new Set(stops)];
  const list = shown.length > 4 ? [...shown.slice(0, 3), '…', shown[shown.length - 1]] : shown;
  return `
    <button class="mn-placard" role="radio" aria-checked="${checked}" data-route="${r.id}">
      <span class="mn-placard-name">${r.name}</span>
      <span class="mn-placard-stops">${list.join(' · ')}</span>
      <span class="mn-placard-meta">${r.stops.length} paradas · ${(r.lengthM / 1000).toFixed(1)} km · ${r.blurb}</span>
    </button>`;
}

function choice(name: string, value: string, label: string, checked: boolean): string {
  return `<label class="mn-choice"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} /><span>${label}</span></label>`;
}

/** Streets in grey, the chosen route in amber with numbered stops. */
function drawMap(canvas: HTMLCanvasElement, city: CityData, route: RouteDef): void {
  const ctx = canvas.getContext('2d')!;
  const { min, max } = city.bounds;
  const size = Math.max(max.x - min.x, max.z - min.z);
  const pad = 16;
  const k = (canvas.width - pad * 2) / size;
  const X = (x: number) => pad + (x - min.x) * k;
  const Z = (z: number) => pad + (z - min.z) * k;
  ctx.fillStyle = '#e9e3d3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#b8b0a0';
  ctx.lineCap = 'round';
  for (const r of city.roads) {
    ctx.lineWidth = Math.max(1, r.width * k * 0.8);
    ctx.beginPath();
    r.points.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
    ctx.stroke();
  }
  const byId = new Map(city.stops.map((s) => [s.id, s]));
  const pts = route.stops.map((id) => byId.get(id)!.pos);
  ctx.strokeStyle = '#d98a00';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  pts.forEach((p, i) => {
    ctx.fillStyle = i === 0 ? '#2e7d4f' : '#1d1a14';
    ctx.beginPath();
    ctx.arc(X(p.x), Z(p.z), 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffb000';
    ctx.fillText(String(i + 1), X(p.x), Z(p.z) + 0.5);
  });
}
