import type { BusPreset } from '../vehicle/busPreset';
import { BUSES, VEHICLES, busStats } from '../vehicle/buses';
import { ZONE_LIST, loadZone } from '../world/loadCity';
import type { CityData, Vec2 } from '../world/cityData';
import { type RouteDef, routeLegs, routePaths, routeStops, routesFor, startPose } from '../gameplay/routes';
import { type StarThresholds, starThresholds, starsFor } from '../gameplay/stars';
import { buildRoadGraph } from '../world/roadGraph';
import { HILLS_OPTIONS, TIME_OPTIONS, type Settings, loadSettings, saveSettings } from './settings';
import { RADIO_OFF, STATIONS } from '../core/radioStations';
import { type RouteRecords, loadRecords, routeKey } from '../gameplay/records';
import { MISSIONS } from '../gameplay/missions';
import { money, starText, targetsText } from '../ui/gameHud';

export interface Selection {
  mode: 'route' | 'free';
  bus: string;
  zone: string;
  route: string;
}

/** URL that starts a shift (or a free drive) with this selection (the game reads it on load). */
export function playUrl(s: Selection): string {
  if (s.mode === 'free') return `?${new URLSearchParams({ play: '1', mode: 'free', city: s.zone, bus: s.bus })}`;
  return `?${new URLSearchParams({ play: '1', city: s.zone, bus: s.bus, route: s.route })}`;
}

const MODES = [
  { id: 'route', name: 'Turno', blurb: 'Una ruta con paradas, pasajeros, reloj y plata' },
  { id: 'free', name: 'Paseo libre', blurb: 'Recorra la ciudad a su gusto, sin paradas ni reloj' },
] as const;

/** Vehicles offered in a mode: buses on a route; buses and cars in free roam. */
const vehiclesFor = (mode: Selection['mode']) => (mode === 'free' ? VEHICLES : BUSES);

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
          <button class="mn-btn" data-go="credits">Créditos</button>
        </nav>
        <p class="mn-foot">Mapa © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Relieve Copernicus GLO-30</p>
      </main>`;
    this.on('[data-go="setup"]', () => this.setup());
    this.on('[data-go="settings"]', () => this.settingsScreen(() => this.title()));
    this.on('[data-go="credits"]', () => this.credits());
    this.focusFirst();
  }

  /** Who made what, the data licences, and that the game is nobody's official product. */
  private credits(): void {
    const link = (url: string, text: string) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-settings mn-credits">
        <header class="mn-head">
          <button class="mn-back" data-go="back" aria-label="Volver">‹</button>
          <div class="mn-led mn-led-wide"><span>CRÉDITOS</span></div>
        </header>
        <div class="mn-panel">
          <section>
            <h2>QBus</h2>
            <p>Juego gratuito, hecho por aficionados, de ficción y sin fines de lucro.</p>
          </section>
          <section>
            <h2>Mapa</h2>
            <p>Calles, edificios, paradas y rutas: © colaboradores de ${link('https://www.openstreetmap.org/copyright', 'OpenStreetMap')},
            bajo la licencia ${link('https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL 1.0')}. Los datos de la ciudad del juego
            (<code>data/cities/*.json</code>) son una base de datos derivada y se comparten bajo la misma licencia.</p>
          </section>
          <section>
            <h2>Relieve</h2>
            <p lang="en">Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
            provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the
            Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</p>
          </section>
          <section>
            <h2>Sonidos</h2>
            <p>Grabaciones de dominio público (CC0) de ${link('https://freesound.org', 'Freesound')}: kyles, AndrewAlexander, rabbydaw,
            DigPro120, am7 y tt_runscript. Detalle en <code>public/sounds/CREDITS.md</code>.</p>
          </section>
          <section>
            <h2>Música</h2>
            <p>Las seis canciones de la radio (dos por emisora) son originales, compuestas y sintetizadas por código para QBus (CC0).
            Las radios, locutores y artistas son inventados.</p>
          </section>
          <section>
            <h2>Aviso</h2>
            <p>QBus no está afiliado, patrocinado ni aprobado por el Municipio del Distrito Metropolitano de Quito, la Empresa
            Pública Metropolitana Metro de Quito, la EPMTPQ (Trolebús, Ecovía, Metrobus-Q), ninguna operadora de buses, ni
            ningún fabricante de vehículos. Los nombres de calles, lugares y sistemas de transporte se usan solo para ubicar el
            juego. Las operadoras de buses, comercios, vehículos y canciones son inventados o parodias; cualquier parecido es
            un guiño. Las marcas mencionadas pertenecen a sus dueños.</p>
          </section>
        </div>
      </main>`;
    this.on('[data-go="back"]', () => this.title());
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
          <h2>El modo</h2>
          <div class="mn-row" role="radiogroup" aria-label="Modo">${MODES.map((m) => modeCard(m, m.id === s.mode)).join('')}</div>
        </section>
        <section class="mn-step">
          <h2 class="mn-vehicle-title"></h2>
          <div class="mn-row mn-vehicles" role="radiogroup" aria-label="Vehículo"></div>
        </section>
        <section class="mn-step">
          <h2>La zona</h2>
          <div class="mn-row" role="radiogroup" aria-label="Zona">${ZONE_LIST.map((z) => zoneCard(z, z.id === s.zone)).join('')}</div>
        </section>
        <section class="mn-step mn-step-route">
          <h2>La ruta <small class="mn-missions-done"></small></h2>
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
    this.root.querySelectorAll<HTMLElement>('[data-mode]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('mode', el.dataset.mode as Selection['mode']);
        this.mark('[data-mode]', el);
        this.showVehicles();
        this.showRoutes();
      }),
    );
    this.showVehicles();
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
    this.root.querySelector<HTMLElement>('[data-mode][aria-checked="true"]')?.focus();
  }

  /** The vehicle cards for the current mode (cars only in free roam). */
  private showVehicles(): void {
    const list = vehiclesFor(this.settings.mode);
    if (!list.some((v) => v.preset.id === this.settings.bus)) this.pick('bus', list[0].preset.id);
    const pool = list.map((v) => v.preset);
    this.root.querySelector('.mn-vehicle-title')!.textContent = this.settings.mode === 'free' ? 'El vehículo' : 'El bus';
    const row = this.root.querySelector<HTMLElement>('.mn-vehicles')!;
    row.innerHTML = list.map((b) => busCard(b.preset, b.blurb, b.preset.id === this.settings.bus, pool)).join('');
    row.querySelectorAll<HTMLElement>('[data-bus]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('bus', el.dataset.bus!);
        this.mark('[data-bus]', el);
      }),
    );
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
          <fieldset>
            <legend>Hora</legend>
            ${TIME_OPTIONS.map((o) => choice('timeOfDay', o.value, o.label, s.timeOfDay === o.value)).join('')}
          </fieldset>
          <fieldset>
            <legend>Radio al arrancar</legend>
            ${choice('radio', 'off', RADIO_OFF, s.radio === 'off')}
            ${STATIONS.map((st) => choice('radio', st.id, st.name, s.radio === st.id)).join('')}
          </fieldset>
          <fieldset>
            <legend>Cómo jugar (al empezar)</legend>
            ${choice('tutorial', 'on', 'Mostrar', s.tutorial)}
            ${choice('tutorial', 'off', 'No mostrar', !s.tutorial)}
          </fieldset>
          ${slider('volume', 'Volumen', s.volume)}
          ${slider('musicVolume', 'Música', s.musicVolume)}
        </div>
      </main>`;
    this.on('[data-go="back"]', back);
    this.root.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.name === 'camera') this.settings.camera = el.value as Settings['camera'];
        if (el.name === 'hills') this.settings.hills = Number(el.value);
        if (el.name === 'timeOfDay') this.settings.timeOfDay = el.value as Settings['timeOfDay'];
        if (el.name === 'radio') this.settings.radio = el.value as Settings['radio'];
        if (el.name === 'tutorial') this.settings.tutorial = el.value === 'on';
        saveSettings(this.settings);
      }),
    );
    for (const key of ['volume', 'musicVolume'] as const) {
      const input = this.root.querySelector<HTMLInputElement>(`input[name="${key}"]`)!;
      input.addEventListener('input', () => {
        this.settings[key] = Number(input.value) / 100;
        input.nextElementSibling!.textContent = `${input.value}%`;
        saveSettings(this.settings);
      });
    }
    this.focusFirst();
  }

  // ---- routes ---------------------------------------------------------------

  private async showRoutes(): Promise<void> {
    const zone = this.settings.zone;
    const box = this.root.querySelector<HTMLElement>('.mn-placards')!;
    const play = this.root.querySelector<HTMLButtonElement>('[data-go="play"]')!;
    // Free roam has no route to pick: nothing to load before playing.
    const free = this.settings.mode === 'free';
    this.root.querySelector<HTMLElement>('.mn-step-route')!.hidden = free;
    if (free) {
      play.disabled = false;
      this.summary();
      return;
    }
    box.innerHTML = '<p class="mn-loading">Cargando rutas…</p>';
    play.disabled = true;
    if (!this.cities.has(zone)) this.cities.set(zone, loadZone(zone));
    const city = await this.cities.get(zone)!;
    if (this.settings.zone !== zone || !box.isConnected) return; // switched zone meanwhile
    const graph = buildRoadGraph(city);
    const routes = routesFor(city, graph);
    const draw = (id: string) => {
      const route = routes.find((r) => r.id === id)!;
      drawMap(this.root.querySelector('canvas')!, city, route, routePaths(city, route, graph));
    };
    if (!routes.some((r) => r.id === this.settings.route)) this.pick('route', routes[0].id);
    const names = new Map(city.stops.map((st) => [st.id, st.name]));
    const records = loadRecords();
    const targets = (r: RouteDef) => starThresholds(routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos);
    box.innerHTML = routes.map((r) => placard(r, names, r.id === this.settings.route, targets(r), records.routes[routeKey(zone, r.id)])).join('');
    const done = MISSIONS.filter((m) => records.missions[m.id]).length;
    this.root.querySelector('.mn-missions-done')!.textContent = done ? `Misiones cumplidas: ${done} de ${MISSIONS.length}` : '';
    box.querySelectorAll<HTMLElement>('[data-route]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('route', el.dataset.route!);
        this.mark('[data-route]', el);
        draw(el.dataset.route!);
      }),
    );
    draw(this.settings.route);
    play.disabled = false;
    this.summary();
  }

  // ---- helpers ---------------------------------------------------------------

  private pick<K extends keyof Selection>(k: K, v: Settings[K]): void {
    this.settings[k] = v;
    this.summary();
  }

  private summary(): void {
    const el = this.root.querySelector('.mn-summary');
    if (!el) return;
    const bus = VEHICLES.find((b) => b.preset.id === this.settings.bus)?.preset.name ?? '';
    const zone = ZONE_LIST.find((z) => z.id === this.settings.zone)?.name ?? '';
    const route =
      this.settings.mode === 'free' ? 'Paseo libre' : (this.root.querySelector(`[data-route="${this.settings.route}"] .mn-placard-name`)?.textContent ?? '');
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

function modeCard(m: { id: string; name: string; blurb: string }, checked: boolean): string {
  return `
    <button class="mn-card mn-zone" role="radio" aria-checked="${checked}" data-mode="${m.id}">
      <span class="mn-card-name">${m.name}</span>
      <span class="mn-card-blurb">${m.blurb}</span>
    </button>`;
}

/** Side view of the AE86 in its panda livery. */
const AE86_ART = `
  <g transform="translate(40,18)">
    <polygon points="4,26 22,20 52,19 70,6 104,6 128,20 140,22 140,40 4,40" fill="#f4f4f1"/>
    <polygon points="56,19 72,9 86,9 86,19" fill="#1c2a38"/><polygon points="90,9 103,9 122,20 90,20" fill="#1c2a38"/>
    <rect x="4" y="32" width="136" height="9" fill="#1b1b1d"/>
    <rect x="137" y="24" width="4" height="6" fill="#d42020"/>
    <circle cx="30" cy="41" r="8" fill="#1b1b1b"/><circle cx="30" cy="41" r="4" fill="#d9d9d4"/>
    <circle cx="114" cy="41" r="8" fill="#1b1b1b"/><circle cx="114" cy="41" r="4" fill="#d9d9d4"/>
  </g>`;

function busCard(p: BusPreset, blurb: string, checked: boolean, pool?: BusPreset[]): string {
  const { color, stripe, roof } = p.body;
  // Side view scaled to the bus's real length, so the buseta looks small and the coach long.
  const w = 70 + p.body.length * 11;
  return `
    <button class="mn-card mn-bus" role="radio" aria-checked="${checked}" data-bus="${p.id}">
      <svg class="mn-bus-art" viewBox="0 0 220 80" aria-hidden="true">${
        p.kind === 'car'
          ? AE86_ART
          : `
        <g transform="translate(${(220 - w) / 2},8)">
          <rect x="0" y="0" width="${w}" height="10" rx="4" fill="${roof}"/>
          <rect x="0" y="6" width="${w}" height="48" rx="6" fill="${color}"/>
          <rect x="10" y="14" width="${w - 34}" height="16" rx="2" fill="#1c2a38"/>
          <rect x="${w - 20}" y="12" width="16" height="30" rx="2" fill="#1c2a38"/>
          <rect x="0" y="36" width="${w}" height="6" fill="${stripe}"/>
          <circle cx="${w * 0.2}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.2}" cy="56" r="3.5" fill="#bbb"/>
          <circle cx="${w * 0.8}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.8}" cy="56" r="3.5" fill="#bbb"/>
        </g>`
      }
      </svg>
      <span class="mn-card-name">${p.name}</span>
      <span class="mn-card-blurb">${blurb}</span>
      <dl class="mn-stats">${busStats(p, pool)
        .map((st) => `<dt>${st.label}</dt><dd><span style="--v:${st.value.toFixed(2)}"></span></dd>`)
        .join('')}</dl>
      <span class="mn-card-cap">${p.kind === 'car' ? `${p.capacity + 1} puestos` : `${p.capacity} pasajeros`} · ${p.topSpeedKmh} km/h</span>
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
function placard(r: RouteDef, names: Map<string, string>, checked: boolean, targets: StarThresholds, best?: RouteRecords): string {
  const stops = r.stops.map((id) => names.get(id) ?? '');
  const shown = [...new Set(stops)];
  const list = shown.length > 4 ? [...shown.slice(0, 3), '…', shown[shown.length - 1]] : shown;
  // Stars always read from the best money against today's targets (older shifts were rated against easier ones).
  const top = best?.top[0];
  const stars = top ? starsFor(top.cents, targets) : 0;
  return `
    <button class="mn-placard" role="radio" aria-checked="${checked}" data-route="${r.id}">
      <span class="mn-placard-head">
        <span class="mn-placard-name">${r.name}</span>
        ${top ? `<span class="mn-placard-best" title="Su mejor turno"><span class="mn-stars" aria-label="${stars} de 3 estrellas">${starText(stars)}</span> ${money(top.cents)}</span>` : ''}
      </span>
      <span class="mn-placard-stops">${list.join(' · ')}</span>
      <span class="mn-placard-meta">${r.stops.length} paradas · ${(r.lengthM / 1000).toFixed(1)} km · ${r.blurb}</span>
      <span class="mn-placard-goal" title="Plata para ganar cada estrella">${targetsText(targets)}</span>
    </button>`;
}

function slider(name: string, label: string, value: number): string {
  const pct = Math.round(value * 100);
  return `<label class="mn-volume"><span>${label}</span><input type="range" min="0" max="100" step="5" value="${pct}" name="${name}" /><output>${pct}%</output></label>`;
}

function choice(name: string, value: string, label: string, checked: boolean): string {
  return `<label class="mn-choice"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} /><span>${label}</span></label>`;
}

/** Streets in grey, the chosen route in amber along the streets it drives, numbered stops. */
function drawMap(canvas: HTMLCanvasElement, city: CityData, route: RouteDef, legs: Vec2[][]): void {
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
  ctx.lineJoin = 'round';
  for (const leg of legs) {
    ctx.beginPath();
    leg.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
    ctx.stroke();
  }
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
