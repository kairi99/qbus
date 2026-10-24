import { type BusPreset, isTrain } from '../vehicle/busPreset';
import { BRT_BUS, BUSES, VEHICLES, busById, busStats } from '../vehicle/buses';
import { CIRCUIT_ZONES, TRACK_LIST, ZONE_LIST, loadZone } from '../world/loadCity';
import type { CityData, Vec2 } from '../world/cityData';
import { type RouteDef, routeLegs, routePaths, routeStops, routesFor, startPose } from '../gameplay/routes';
import { type StarThresholds, starThresholds, starsFor } from '../gameplay/stars';
import { buildRoadGraph } from '../world/roadGraph';
import { HILLS_OPTIONS, RAIN_OPTIONS, type RaceSetup, TIME_OPTIONS, type Settings, loadSettings, saveSettings } from './settings';
import { bestOnline, bestOnlineLap } from '../gameplay/onlineRecords';
import { bestLapRecord, bestRace } from '../gameplay/raceRecords';
import { SLIDE_TRACKS } from '../gameplay/landslides';
import { raceClock } from '../gameplay/raceGame';
import { RADIO_OFF, STATIONS } from '../core/radioStations';
import { type RouteRecords, loadRecords, routeKey } from '../gameplay/records';
import { MISSIONS } from '../gameplay/missions';
import { money, starText, targetsText } from '../ui/gameHud';
import { MenuSounds } from './menuSounds';
import { MAX_SEATS, cleanName, normalizeCode, type RoomSettings, type S2C, type Seat } from '../net/protocol';
import { buildGrid } from '../net/onlineGrid';
import { ONLINE, RoomConnection, clearSession, createRoom, lastSavedSeat, loadSession, roomInfo, savedSeat, type OnlineSession } from '../net/connection';

type RoomMsg = Extract<S2C, { t: 'room' }>;

export interface Selection {
  mode: 'route' | 'free' | 'race';
  bus: string;
  zone: string;
  route: string;
  race?: RaceSetup;
}

/** URL that starts a shift (or a free drive, or a race) with this selection (the game reads it on load). */
export function playUrl(s: Selection): string {
  if (s.mode === 'free') return `?${new URLSearchParams({ play: '1', mode: 'free', city: s.zone, bus: s.bus })}`;
  if (s.mode === 'race' && s.race) {
    const r = s.race;
    return `?${new URLSearchParams({ play: '1', mode: 'race', city: r.track, bus: s.bus, rivals: String(r.rivals), rivalBus: r.rivalBus, skill: r.skill, ...(r.traffic && !CIRCUIT_ZONES[r.track] ? { traffic: '1' } : {}), ...(SLIDE_TRACKS.has(r.track) && !r.slides ? { slides: '0' } : {}) })}`;
  }
  return `?${new URLSearchParams({ play: '1', city: s.zone, bus: s.bus, route: s.route })}`;
}

/** Which bus the menu has selected, and whether the player chose it themselves. */
export interface BusChoice {
  bus: string;
  /** The bus the menu swapped out when it picked the articulated one for a BRT route. */
  restore: string | null;
  /** The player picked a bus by hand while on a BRT route: leave it alone on BRT routes. */
  manual: boolean;
}

/**
 * Picking a Trolebús/Ecovía route selects the articulated bus (unless the player chose another
 * bus for BRT routes); going back to an ordinary route puts back the bus it replaced.
 */
export function busForRoute(c: BusChoice, brt: boolean): BusChoice {
  if (brt) return c.manual || c.bus === BRT_BUS ? c : { bus: BRT_BUS, restore: c.bus, manual: false };
  return { bus: c.restore ?? c.bus, restore: null, manual: false };
}

const MODES = [
  { id: 'route', name: 'Turno', blurb: 'Una ruta con paradas, pasajeros, reloj y plata' },
  { id: 'free', name: 'Paseo libre', blurb: 'Recorra la ciudad a su gusto, sin paradas ni reloj' },
  { id: 'race', name: 'Carrera', blurb: 'Contra otros buses, cuesta abajo por una vía de montaña de verdad' },
] as const;

/** Vehicles offered in a mode: buses on a route; buses and cars in free roam and races. */
const vehiclesFor = (mode: Selection['mode']) => (mode === 'route' ? BUSES : VEHICLES);

const RIVAL_COUNTS = [1, 2, 3, 4, 5];
const SKILL_OPTIONS: { value: RaceSetup['skill']; label: string }[] = [
  { value: 'easy', label: 'Tranquilos' },
  { value: 'normal', label: 'Normales' },
  { value: 'hard', label: 'Bravos' },
];

/**
 * Title screen and shift setup (bus, zone, route) plus settings. Pure DOM; the game itself
 * isn't loaded until the player presses ¡Arranca!, which navigates to playUrl().
 */
export class Menu {
  private root: HTMLElement;
  private settings: Settings;
  private cities = new Map<string, Promise<CityData>>();
  private sounds: MenuSounds;
  private busChoice: BusChoice;
  private routeDefs = new Map<string, RouteDef>();
  private onlineVehicle = '';

  constructor(host: HTMLElement) {
    this.settings = loadSettings();
    this.busChoice = { bus: this.settings.bus, restore: null, manual: false };
    this.root = document.createElement('div');
    this.root.className = 'mn';
    host.appendChild(this.root);
    this.sounds = new MenuSounds(this.root, () => this.settings.volume);
    if (import.meta.env.DEV) (window as any).__qbusMenu = { sounds: this.sounds };
    // Back from an online race (?lobby=K7Q2): straight into that room's lobby, with the seat's token.
    const back = new URLSearchParams(location.search).get('lobby');
    const seat = loadSession();
    if (back && seat && seat.code === back) {
      history.replaceState(null, '', location.pathname);
      this.lobby(this.reconnect(seat), seat.code);
    } else {
      this.title();
      // A reload (the tab's seat is still there): back to that room, if it is still on.
      if (seat) void this.rejoin(seat);
    }
  }

  /** A connection that takes `seat` back (name, ready flag and vehicle are the room's). */
  private reconnect(seat: OnlineSession): RoomConnection {
    return new RoomConnection(seat.code, { name: seat.name, vehicle: this.onlineVehicle || this.settings.bus, token: seat.token }, { giveUpMs: LOBBY_GIVE_UP });
  }

  /** Back into a room whose seat this browser still holds. `note`: where to say it is gone (from the online screen); from the title screen that stays quiet. */
  private async rejoin(seat: OnlineSession, note?: (t: string) => void): Promise<void> {
    try {
      const info = await roomInfo(seat.code);
      if (!info) {
        clearSession(seat.code);
        note?.('Esa sala ya no existe');
        return;
      }
      // Still where it was asked for (not off in another menu).
      if (!note && !this.root.querySelector('.mn-title')) return;
      this.lobby(this.reconnect(seat), seat.code);
    } catch {
      note?.(NO_SERVER);
    }
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
          ${ONLINE ? '<button class="mn-btn" data-go="online">En línea</button>' : ''}
          <button class="mn-btn" data-go="settings">Ajustes</button>
          <button class="mn-btn" data-go="credits">Créditos</button>
        </nav>
        <p class="mn-foot">Mapa © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Relieve Copernicus GLO-30</p>
      </main>`;
    this.on('[data-go="setup"]', () => this.setup());
    this.on('[data-go="online"]', () => this.online());
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
            (<code>data/cities/*.json</code>) son una base de datos derivada y se comparten bajo la misma licencia. La pista
            Paso de la Muerte es un tramo real de la Vía Interoceánica (E20) entre Papallacta y Cuyuja, y la pista Bajada del
            Silante, un tramo real de la Vía Alóag–Santo Domingo (E20) entre Arrayán y el Río Silante; la pista Bajada de Río Verde,
            un tramo real de la Ruta de las Cascadas (E30, Baños–Puyo) sobre el Pastaza, con sus cuatro túneles, sus puentes y sus cascadas: las vías, sus ríos, los
            oleoductos, la línea de alta tensión, la capilla y las casas también salen de OpenStreetMap; los letreros de los negocios solo dicen lo que venden.</p>
          </section>
          <section>
            <h2>Relieve</h2>
            <p>Elaborado con Copernicus WorldDEM-30 © DLR e.V. 2010-2014 y © Airbus Defence and Space GmbH 2014-2018,
            proporcionado en el marco de COPERNICUS por la Unión Europea y la ESA; todos los derechos reservados. Las
            organizaciones a cargo del programa Copernicus, por ley o por delegación, no asumen responsabilidad alguna por
            el uso del Copernicus WorldDEM-30.</p>
          </section>
          <section>
            <h2>Sonidos</h2>
            <p>Grabaciones de dominio público (CC0) de ${link('https://freesound.org', 'Freesound')}: kyles, AndrewAlexander, rabbydaw,
            DigPro120, am7 y tt_runscript. Detalle en <code>public/sounds/CREDITS.md</code>. Los sonidos del menú, la lluvia y los truenos son sintetizados por código.</p>
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
            juego. Las operadoras de buses, comercios, vehículos (Toyoya, Taitar) y canciones son inventados o parodias; cualquier parecido es
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
        <section class="mn-step mn-step-zone">
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
        <section class="mn-step mn-step-race" hidden>
          <h2>La pista</h2>
          <div class="mn-routes">
            <div class="mn-placards">
              <div class="mn-row mn-tracks" role="radiogroup" aria-label="Pista"></div>
              <div class="mn-panel mn-race-opts"></div>
            </div>
            <canvas class="mn-map mn-track-map" width="360" height="360" aria-label="Mapa de la pista"></canvas>
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
      // Leave a moment for the horn (the game starts its own audio).
      const url = playUrl(this.settings);
      setTimeout(() => (location.search = url), this.sounds.leaveDelay);
    });
    this.showRoutes();
    this.root.querySelector<HTMLElement>('[data-mode][aria-checked="true"]')?.focus();
  }

  /** The vehicle cards for the current mode (cars only in free roam). */
  private showVehicles(): void {
    const list = vehiclesFor(this.settings.mode);
    if (!list.some((v) => v.preset.id === this.settings.bus)) this.pick('bus', list[0].preset.id);
    const pool = list.map((v) => v.preset);
    this.root.querySelector('.mn-vehicle-title')!.textContent = this.settings.mode === 'route' ? 'El bus' : 'El vehículo';
    const row = this.root.querySelector<HTMLElement>('.mn-vehicles')!;
    row.innerHTML = list.map((b) => busCard(b.preset, b.blurb, b.preset.id === this.settings.bus, pool)).join('');
    row.querySelectorAll<HTMLElement>('[data-bus]').forEach((el) =>
      el.addEventListener('click', () => {
        this.pick('bus', el.dataset.bus!);
        this.busChoice = { bus: el.dataset.bus!, restore: null, manual: this.isBrt(this.settings.route) };
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
            <legend>Lluvia</legend>
            ${RAIN_OPTIONS.map((o) => choice('rain', o.value, o.label, s.rain === o.value)).join('')}
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
        if (el.name === 'rain') this.settings.rain = el.value as Settings['rain'];
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


  // ---- online -----------------------------------------------------------------

  /** Name, vehicle, and either a new room or the code of a friend's. */
  private online(message = ''): void {
    const s = this.settings;
    if (!VEHICLES.some((v) => v.preset.id === this.onlineVehicle)) this.onlineVehicle = VEHICLES.some((v) => v.preset.id === s.bus) ? s.bus : VEHICLES[0].preset.id;
    // A seat this browser still holds in some room (a closed tab, a crashed page): a way back.
    const back = lastSavedSeat();
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-settings mn-online">
        <header class="mn-head">
          <button class="mn-back" data-go="back" aria-label="Volver">‹</button>
          <div class="mn-led mn-led-wide"><span>EN LÍNEA</span></div>
        </header>
        <div class="mn-panel">
          <label class="mn-field"><span>Su nombre</span>
            <input class="mn-text" name="name" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Ñaño" value="${esc(s.online.name)}" /></label>
          <label class="mn-field"><span>Qué maneja</span>
            <select class="mn-select" name="vehicle">${vehicleOptions(this.onlineVehicle)}</select></label>
          <div class="mn-online-split">
            <section>
              <h2>Una sala nueva</h2>
              <button class="mn-btn mn-btn-go" data-go="create">Crear sala</button>
            </section>
            <form class="mn-join" data-form="join">
              <h2>La sala de un pana</h2>
              <div class="mn-join-row">
                <input class="mn-text mn-code-input" name="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" aria-label="Código de la sala" />
                <button class="mn-btn" type="submit" data-go="join">Unirse</button>
              </div>
            </form>
          </div>
          ${back ? `<button class="mn-btn" data-go="rejoin">Volver a la sala ${back.code}</button>` : ''}
          <p class="mn-note" role="status" aria-live="polite">${esc(message)}</p>
        </div>
      </main>`;
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    const name = q<HTMLInputElement>('input[name="name"]');
    const vehicle = q<HTMLSelectElement>('select[name="vehicle"]');
    const code = q<HTMLInputElement>('input[name="code"]');
    const note = q('.mn-note');
    const buttons = this.root.querySelectorAll<HTMLButtonElement>('[data-go="create"], [data-go="join"]');
    const busy = (b: boolean) => buttons.forEach((el) => (el.disabled = b));
    name.addEventListener('input', () => {
      this.settings.online.name = name.value.trim() ? cleanName(name.value) : '';
      saveSettings(this.settings);
    });
    vehicle.addEventListener('change', () => (this.onlineVehicle = vehicle.value));
    code.addEventListener('input', () => (code.value = code.value.toUpperCase()));
    this.on('[data-go="back"]', () => this.title());
    if (back) this.on('[data-go="rejoin"]', () => void this.rejoin(back, (t) => (note.textContent = t)));
    this.on('[data-go="create"]', async () => {
      busy(true);
      note.textContent = 'Creando la sala…';
      try {
        const room = await createRoom();
        this.lobby(new RoomConnection(room, { name: cleanName(name.value), vehicle: this.onlineVehicle }, { giveUpMs: LOBBY_GIVE_UP }), room);
      } catch {
        note.textContent = NO_SERVER;
        busy(false);
      }
    });
    q('form[data-form="join"]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = normalizeCode(code.value);
      if (!c) {
        note.textContent = 'No existe esa sala';
        code.focus();
        return;
      }
      busy(true);
      note.textContent = 'Buscando la sala…';
      // A race on: wait for it to end (asking every few seconds), then walk in.
      for (let waited = 0; ; waited += RACE_POLL_MS) {
        try {
          const info = await roomInfo(c);
          if (!info) note.textContent = 'No existe esa sala';
          else {
            // A seat this browser had in that room (same name) comes back to it, even to a race on.
            const mine = savedSeat(c);
            const token = mine && mine.name === cleanName(name.value) ? mine.token : undefined;
            if (info.phase !== 'lobby' && !token) {
              note.textContent = RACE_ON;
              if (waited < RACE_WAIT_MS && note.isConnected) {
                await new Promise((r) => setTimeout(r, RACE_POLL_MS));
                if (note.isConnected) continue;
                return;
              }
            } else if (info.seats >= MAX_SEATS && !token) note.textContent = 'Sala llena';
            else return this.lobby(new RoomConnection(c, { name: cleanName(name.value), vehicle: this.onlineVehicle, token }, { giveUpMs: LOBBY_GIVE_UP }), c);
          }
        } catch {
          note.textContent = NO_SERVER;
        }
        break;
      }
      busy(false);
    });
    name.focus();
  }

  /** The waiting room: the code to share, who is in, the race options (the host's to change) and ready/start. */
  private lobby(conn: RoomConnection, code: string): void {
    let room: RoomMsg | null = null;
    let everOpen = false;
    let failure = '';
    let note = '';
    let finished = false;
    const offs: (() => void)[] = [];
    this.root.innerHTML = `
      ${SKYLINE}
      <main class="mn-settings mn-online mn-lobby">
        <header class="mn-head">
          <button class="mn-back" data-go="back" aria-label="Salir de la sala">‹</button>
          <div class="mn-led mn-led-wide"><span>LA SALA</span></div>
        </header>
        <div class="mn-panel">
          <div class="mn-code-box">
            <span class="mn-code-label">Código de la sala</span>
            <strong class="mn-code" data-room-code aria-label="Código ${code.split('').join(' ')}">${code}</strong>
            <span class="mn-code-hint">Pásales este código a tus panas</span>
          </div>
          <p class="mn-banner" role="status" aria-live="polite" hidden><span data-k="bannerText"></span> <button class="mn-btn" data-go="retry" hidden>Reconectar</button></p>
          <label class="mn-field"><span>Qué maneja</span>
            <select class="mn-select" name="vehicle">${vehicleOptions(this.onlineVehicle)}</select></label>
          <div class="mn-lobby-body"></div>
        </div>
      </main>`;
    const banner = this.root.querySelector<HTMLElement>('.mn-banner')!;
    const bannerText = banner.querySelector<HTMLElement>('[data-k="bannerText"]')!;
    const retry = banner.querySelector<HTMLElement>('[data-go="retry"]')!;
    retry.addEventListener('click', () => conn.retry());
    const body = this.root.querySelector<HTMLElement>('.mn-lobby-body')!;
    const leave = () => {
      offs.forEach((f) => f());
      conn.onState = null;
      conn.close();
      clearSession();
      this.online();
    };
    this.on('[data-go="back"]', leave);
    this.root.querySelector<HTMLSelectElement>('select[name="vehicle"]')!.addEventListener('change', (e) => {
      this.onlineVehicle = wanted = (e.target as HTMLSelectElement).value;
      conn.send({ t: 'me', vehicle: wanted });
    });

    let wanted: string | null = null;
    const status = () => {
      let text = '';
      if (failure) text = failure;
      else if (conn.state === 'connecting') text = everOpen ? 'Reconectando…' : 'Conectando…';
      else if (conn.state === 'closed') text = 'Se perdió la conexión con la sala';
      bannerText.textContent = text;
      banner.hidden = !text;
      retry.hidden = failure !== '' || conn.state === 'open';
      this.root.querySelector('.mn-code-box')!.classList.toggle('mn-dead', !!failure || conn.state === 'closed');
    };
    const render = () => {
      // Keep keyboard focus on the same control across a re-render.
      const act = document.activeElement as HTMLElement | null;
      const key = act && body.contains(act) ? act.dataset.k : undefined;
      body.innerHTML = room && !failure ? this.lobbyBody(room, conn.seat, note) : '';
      if (room && !failure) this.lobbyWire(body, room, conn, render, (n) => ((note = n), render()));
      if (key) body.querySelector<HTMLElement>(`[data-k="${key}"]`)?.focus();
    };
    conn.onState = (st) => {
      if (st === 'open') everOpen = true;
      if (st === 'rejected' && !failure) failure = conn.replaced ? 'Otra pestaña tomó tu lugar en la sala' : 'No se pudo entrar a la sala';
      status();
      render();
    };
    offs.push(
      conn.on('welcome', () => {
        everOpen = true;
        status();
      }),
      conn.on('room', (m) => {
        room = m;
        // A seat taken back keeps its vehicle: the picker shows it.
        // The picker shows what the room has. A pick not in yet (an older message crossing it, or sent while
        // the link was down) is sent again, not overwritten; one the room refuses is replaced by the room's.
        const mineSeat = m.seats.find((x) => x.id === conn.seat);
        const pick = this.root.querySelector<HTMLSelectElement>('select[name="vehicle"]');
        if (mineSeat && wanted !== null && mineSeat.vehicle === wanted) wanted = null;
        if (mineSeat && wanted !== null && m.phase === 'lobby') conn.send({ t: 'me', vehicle: wanted });
        else if (mineSeat && wanted !== null) {
          wanted = null;
          note = 'No se pudo cambiar el vehículo ahora';
        }
        if (mineSeat && wanted === null && pick && VEHICLES.some((v) => v.preset.id === mineSeat.vehicle)) pick.value = this.onlineVehicle = mineSeat.vehicle;
        // The host started: everyone's page goes to the game, which reconnects to this seat.
        if (m.phase === 'loading') {
          offs.forEach((f) => f());
          conn.onState = null;
          location.search = this.gameLink(m, code);
          return;
        }
        render();
      }),
      conn.on('result', (m) => {
        finished = m.rows.some((r) => 'seat' in r.who && r.who.seat === conn.seat && r.time !== null);
      }),
      // Back to a race already running (this seat was in it, a reload or a reopened tab): its game page takes over.
      conn.on('go', () => {
        if (finished || !room) return;
        offs.forEach((f) => f());
        conn.onState = null;
        location.search = this.gameLink(room, code);
      }),
      conn.on('error', (m) => {
        // The host's ¡Arrancar! refused (a guest un-readied or joined meanwhile): say why, the lobby stays usable.
        const soft = SOFT_ERROR_TEXT[m.code];
        if (soft) {
          note = soft;
          render();
          return;
        }
        failure = ERROR_TEXT[m.code] ?? 'No se pudo entrar a la sala';
        status();
        render();
        this.root.querySelector<HTMLElement>('[data-go="back"]')?.focus();
      }),
    );
    status();
    render();
    this.root.querySelector<HTMLElement>('[data-go="back"]')?.focus();
  }

  /** The game page of an online race. The room's light and weather ride in the link, so every page starts the same race. */
  private gameLink(m: RoomMsg, code: string): string {
    const sky = `&tod=${m.settings.tod ?? 'day'}&rain=${m.settings.rain ?? 'random'}&slides=${m.settings.slides === false ? 0 : 1}`;
    return `?play=1&mode=online&city=${encodeURIComponent(m.settings.track)}&room=${code}${sky}`;
  }

  /** Seats and race options for the current room message. */
  private lobbyBody(room: RoomMsg, me: number | null, note: string): string {
    const host = room.seats.find((x) => x.id === me)?.host === true;
    const st = room.settings;
    const humans = room.seats.length;
    const maxAi = Math.max(0, Math.min(MAX_SEATS - 1, MAX_SEATS - humans));
    const ai = Math.min(st.ai, maxAi);
    const rows = room.seats.map((x) => seatRow(x, x.id === me));
    for (let i = 0; i < MAX_SEATS - humans; i++) rows.push(`<li class="mn-seat mn-seat-empty"><span class="mn-seat-name">${i < ai ? 'IA' : 'Libre'}</span></li>`);
    const track = TRACK_LIST.find((t) => t.id === st.track)?.name ?? st.track;
    const skill = SKILL_OPTIONS.find((o) => o.value === st.skill)?.label ?? st.skill;
    const who = st.rivalBus === 'mixed' ? 'De todo un poco' : st.rivalBus === 'same' ? 'Lo mismo que los panas' : busById(st.rivalBus).name;
    const rain = RAIN_OPTIONS.find((o) => o.value === st.rain)?.label ?? RAIN_OPTIONS[0].label;
    const time = TIME_OPTIONS.find((o) => o.value === st.tod)?.label ?? TIME_OPTIONS[0].label;
    // Only the tracks with landslides ask.
    const slidesHere = SLIDE_TRACKS.has(st.track);
    let options: string;
    if (host) {
      const aiChoices = Array.from({ length: maxAi + 1 }, (_, n) => n);
      options = `
        <div class="mn-box mn-box-race" role="group" aria-label="Carrera">
        <h3 class="mn-box-title">Carrera</h3>
        <fieldset><legend>Pista</legend>${TRACK_LIST.map((t) => choice('track', t.id, t.name, st.track === t.id, `track-${t.id}`)).join('')}</fieldset>
        <fieldset><legend>Hora</legend>${TIME_OPTIONS.map((o) => choice('tod', o.value, o.label, st.tod === o.value, `tod-${o.value}`)).join('')}</fieldset>
        <fieldset><legend>Lluvia</legend>${RAIN_OPTIONS.map((o) => choice('rain', o.value, o.label, st.rain === o.value, `rain-${o.value}`)).join('')}</fieldset>${slidesHere ? `
        <fieldset><legend>Derrumbes</legend>${choice('slides', 'on', 'Sí', st.slides, 'slides-on')}${choice('slides', 'off', 'No', !st.slides, 'slides-off')}</fieldset>` : ''}
        </div>
        <div class="mn-box mn-box-ai" role="group" aria-label="Rivales de la IA">
        <h3 class="mn-box-title">Rivales de la IA</h3>
        <fieldset><legend>Cuántos</legend>${aiChoices.map((n) => choice('ai', String(n), String(n), ai === n, `ai-${n}`)).join('')}</fieldset>
        <fieldset><legend>Choferes</legend>${SKILL_OPTIONS.map((o) => choice('skill', o.value, o.label, st.skill === o.value, `skill-${o.value}`)).join('')}</fieldset>
        <fieldset><legend>Qué manejan</legend>
          ${choice('rivalBus', 'mixed', 'De todo un poco', st.rivalBus === 'mixed', 'rb-mixed')}
          ${choice('rivalBus', 'same', 'Lo mismo que los panas', st.rivalBus === 'same', 'rb-same')}
          ${VEHICLES.map((v) => choice('rivalBus', v.preset.id, v.preset.name, st.rivalBus === v.preset.id, `rb-${v.preset.id}`)).join('')}
        </fieldset>
        </div>`;
    } else {
      options = `<div class="mn-box mn-box-race" role="group" aria-label="Carrera"><h3 class="mn-box-title">Carrera</h3><dl class="mn-sum">
        <div><dt>Pista</dt><dd>${esc(track)}</dd></div>
        <div><dt>Hora</dt><dd>${esc(time)}</dd></div>
        <div><dt>Lluvia</dt><dd>${esc(rain)}</dd></div>${slidesHere ? `<div><dt>Derrumbes</dt><dd>${st.slides ? 'Sí' : 'No'}</dd></div>` : ''}</dl></div>
        <div class="mn-box mn-box-ai" role="group" aria-label="Rivales de la IA"><h3 class="mn-box-title">Rivales de la IA</h3><dl class="mn-sum">
        <div><dt>Cuántos</dt><dd>${ai}</dd></div>
        <div><dt>Choferes</dt><dd>${esc(skill)}</dd></div>
        <div><dt>Qué manejan</dt><dd>${esc(who)}</dd></div></dl></div>`;
    }
    const best = bestOnline(st.track);
    const bestLap = CIRCUIT_ZONES[st.track] ? bestOnlineLap(st.track) : null;
    const others = room.seats.filter((x) => !x.host && x.online);
    const mine = room.seats.find((x) => x.id === me);
    const action = room.phase === 'racing'
      ? '<span class="mn-wait">Todavía hay panas en carrera</span>'
      : host
      ? `<button class="mn-btn mn-btn-go" data-k="start" data-act="start" ${others.every((x) => x.ready) ? '' : 'disabled'}>¡Arrancar!</button>
         ${others.every((x) => x.ready) ? '' : '<span class="mn-wait">Esperando que todos estén listos</span>'}`
      : `<button class="mn-btn ${mine?.ready ? 'mn-btn-go' : ''}" data-k="ready" data-act="ready" aria-pressed="${mine?.ready === true}">¡Listo!</button>`;
    return `
      <h2>En la sala (${humans}/${MAX_SEATS})</h2>
      <ul class="mn-seats">${rows.join('')}</ul>
      <div class="mn-opts">${options}${best || bestLap !== null ? `<p class="mn-best" data-k="best">${best ? `Tu mejor en línea en ${esc(track)}: <b>${raceClock(best.time)}</b> · ${esc(best.bus)} · ${best.place}º de ${best.racers}` : `Tu mejor vuelta en línea en ${esc(track)}:`}${bestLap !== null ? `${best ? ' · mejor vuelta' : ''} <b>${raceClock(bestLap)}</b>` : ''}</p>` : ''}</div>
      <div class="mn-lobby-actions">${action}</div>
      <p class="mn-note" role="status" aria-live="polite">${esc(note)}</p>`;
  }

  private lobbyWire(body: HTMLElement, room: RoomMsg, conn: RoomConnection, render: () => void, setNote: (n: string) => void): void {
    const host = room.seats.find((x) => x.id === conn.seat)?.host === true;
    body.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((el) =>
      el.addEventListener('change', () => {
        const next: RoomSettings = { ...room.settings };
        if (el.name === 'track') next.track = el.value;
        if (el.name === 'ai') next.ai = Number(el.value);
        if (el.name === 'skill') next.skill = el.value as RoomSettings['skill'];
        if (el.name === 'rivalBus') next.rivalBus = el.value;
        if (el.name === 'tod') next.tod = el.value as RoomSettings['tod'];
        if (el.name === 'rain') next.rain = el.value as RoomSettings['rain'];
        if (el.name === 'slides') next.slides = el.value === 'on';
        conn.send({ t: 'set', settings: next });
      }),
    );
    body.querySelector('[data-act="ready"]')?.addEventListener('click', () => {
      const mine = room.seats.find((x) => x.id === conn.seat);
      conn.send({ t: 'me', ready: !mine?.ready });
    });
    if (host) body.querySelector('[data-act="start"]')?.addEventListener('click', () => this.onStartOnline(conn, room, setNote));
    void render;
  }

  /** The host's ¡Arrancar!: the grid (AI in front, the players shuffled) goes to the room, which loads everyone's game. */
  private onStartOnline(conn: RoomConnection, room: RoomMsg, setNote: (n: string) => void): void {
    if (room.phase !== 'lobby') {
      // Back from a race: the room returns to the lobby first (everyone readies again).
      conn.send({ t: 'set', settings: room.settings });
      setNote('Esperando que todos estén listos otra vez');
      return;
    }
    const seed = Math.floor(Math.random() * 2 ** 31);
    conn.send({ t: 'start', grid: buildGrid(room.seats, room.settings, VEHICLES.map((v) => v.preset.id), seed), seed });
    setNote('¡Arrancando!');
  }

  // ---- routes ---------------------------------------------------------------

  private async showRoutes(): Promise<void> {
    const zone = this.settings.zone;
    const box = this.root.querySelector<HTMLElement>('.mn-placards')!;
    const play = this.root.querySelector<HTMLButtonElement>('[data-go="play"]')!;
    // Free roam has no route to pick: nothing to load before playing.
    const free = this.settings.mode !== 'route';
    this.root.querySelector<HTMLElement>('.mn-step-route')!.hidden = free;
    const race = this.settings.mode === 'race';
    this.root.querySelector<HTMLElement>('.mn-step-zone')!.hidden = race;
    this.root.querySelector<HTMLElement>('.mn-step-race')!.hidden = !race;
    if (race) void this.showRace();
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
    this.routeDefs = new Map(routes.map((r) => [r.id, r]));
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
        this.chooseBusFor(el.dataset.route!);
        draw(el.dataset.route!);
      }),
    );
    draw(this.settings.route);
    play.disabled = false;
    this.summary();
  }

  /** A race: the track (with its best time), the rivals (how many, what they drive, how well), traffic, and the track's map. */
  private async showRace(): Promise<void> {
    const r = this.settings.race;
    if (!TRACK_LIST.some((t) => t.id === r.track)) r.track = TRACK_LIST[0].id;
    const tracks = this.root.querySelector<HTMLElement>('.mn-tracks')!;
    tracks.innerHTML = TRACK_LIST.map((t) => trackCard(t, t.id === r.track, bestRace(t.id)?.time ?? null, CIRCUIT_ZONES[t.id] ? bestLapRecord(t.id) : undefined)).join('');
    tracks.querySelectorAll<HTMLElement>('[data-track]').forEach((el) =>
      el.addEventListener('click', () => {
        r.track = el.dataset.track!;
        this.mark('[data-track]', el);
        void this.showRace();
      }),
    );
    if (!['mixed', 'same'].includes(r.rivalBus) && !VEHICLES.some((v) => v.preset.id === r.rivalBus)) r.rivalBus = 'mixed';
    const opts = this.root.querySelector<HTMLElement>('.mn-race-opts')!;
    opts.innerHTML = `
      <div class="mn-box mn-box-ai" role="group" aria-label="Rivales de la IA">
      <h3 class="mn-box-title">Rivales de la IA</h3>
      <fieldset>
        <legend>Rivales</legend>
        ${RIVAL_COUNTS.map((n) => choice('rivals', String(n), String(n), r.rivals === n)).join('')}
      </fieldset>
      <fieldset>
        <legend>Qué manejan</legend>
        ${choice('rivalBus', 'mixed', 'De todo un poco', r.rivalBus === 'mixed')}
        ${choice('rivalBus', 'same', 'Lo mismo que yo', r.rivalBus === 'same')}
        ${VEHICLES.map((v) => choice('rivalBus', v.preset.id, v.preset.name, r.rivalBus === v.preset.id)).join('')}
      </fieldset>
      <fieldset>
        <legend>Choferes</legend>
        ${SKILL_OPTIONS.map((o) => choice('skill', o.value, o.label, r.skill === o.value)).join('')}
      </fieldset>
      </div>
      ${CIRCUIT_ZONES[r.track] ? '' : `<fieldset>
        <legend>Tráfico en la vía</legend>
        ${choice('traffic', 'off', 'Vía libre', !r.traffic)}
        ${choice('traffic', 'on', 'Con carros y camiones', r.traffic)}
      </fieldset>`}
      ${SLIDE_TRACKS.has(r.track) ? `<fieldset class="mn-slides">
        <legend>Derrumbes</legend>
        ${choice('slides', 'on', 'Sí', r.slides)}
        ${choice('slides', 'off', 'No', !r.slides)}
      </fieldset>` : ''}`;
    opts.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.name === 'rivals') r.rivals = Number(el.value);
        if (el.name === 'rivalBus') r.rivalBus = el.value;
        if (el.name === 'skill') r.skill = el.value as RaceSetup['skill'];
        if (el.name === 'traffic') r.traffic = el.value === 'on';
        if (el.name === 'slides') r.slides = el.value === 'on';
        this.summary();
      }),
    );
    this.summary();
    await this.drawTrack();
  }

  private async drawTrack(): Promise<void> {
    const id = this.settings.race.track;
    if (!this.cities.has(id)) this.cities.set(id, loadZone(id));
    const city = await this.cities.get(id)!;
    const canvas = this.root.querySelector<HTMLCanvasElement>('.mn-track-map');
    if (canvas && city.race && this.settings.race.track === id) {
      drawTrackMap(canvas, city);
      // Which track the map shows (tests wait for it).
      canvas.dataset.drawn = id;
    }
  }

  // ---- helpers ---------------------------------------------------------------

  private isBrt(routeId: string): boolean {
    return !!this.routeDefs.get(routeId)?.system;
  }

  /** A BRT route selects the articulated bus (see `busForRoute`); the cards follow. */
  private chooseBusFor(routeId: string): void {
    this.busChoice = busForRoute({ ...this.busChoice, bus: this.settings.bus }, this.isBrt(routeId));
    if (this.busChoice.bus === this.settings.bus) return;
    this.pick('bus', this.busChoice.bus);
    const card = this.root.querySelector<HTMLElement>(`[data-bus="${this.busChoice.bus}"]`);
    if (card) this.mark('[data-bus]', card);
  }

  private pick<K extends keyof Selection>(k: K, v: Settings[K]): void {
    this.settings[k] = v;
    this.summary();
  }

  private summary(): void {
    const el = this.root.querySelector('.mn-summary');
    if (!el) return;
    const bus = VEHICLES.find((b) => b.preset.id === this.settings.bus)?.preset.name ?? '';
    const zone = ZONE_LIST.find((z) => z.id === this.settings.zone)?.name ?? '';
    if (this.settings.mode === 'race') {
      const r = this.settings.race;
      const track = TRACK_LIST.find((t) => t.id === r.track)?.name ?? '';
      const who = r.rivalBus === 'mixed' ? 'de todo un poco' : r.rivalBus === 'same' ? 'lo mismo que usted' : (VEHICLES.find((v) => v.preset.id === r.rivalBus)?.preset.name ?? '');
      el.textContent = `${bus}, ${track}, ${r.rivals} ${r.rivals === 1 ? 'rival' : 'rivales'} (${who})${r.traffic && !CIRCUIT_ZONES[r.track] ? ', con tráfico' : ''}${SLIDE_TRACKS.has(r.track) && !r.slides ? ', sin derrumbes' : ''}`;
      return;
    }
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

/**
 * Side view of the container truck, drawn from the preset's real layout (17.7 m over 208 px, nose right): the
 * tractor's steer axle + rear tandem, the 40 ft box on its trailer overlapping the tractor's tail at the fifth
 * wheel, and the trailer's three axles at its back.
 */
const TRUCK_ART = (() => {
  const px = (m: number): number => (m + 13.95) * 11.75; // metres from the tractor's center -> card x
  const wheel = (m: number): string =>
    `<circle cx="${px(m).toFixed(1)}" cy="50" r="6" fill="#1b1b1b"/><circle cx="${px(m).toFixed(1)}" cy="50" r="2.6" fill="#9a9da3"/>`;
  return `
  <g transform="translate(4,12)">
    <rect x="0" y="43" width="${px(-1.75).toFixed(1)}" height="4" fill="#2a2c30"/>
    <rect x="${px(-3.75).toFixed(1)}" y="44" width="${(208 - px(-3.75)).toFixed(1)}" height="5" fill="#2a2c30"/>
    <rect x="${px(1.2).toFixed(1)}" y="28" width="${(px(3.75) - px(1.2)).toFixed(1)}" height="16" rx="2" fill="#c8321e"/>
    <rect x="${px(-1).toFixed(1)}" y="14" width="${(px(1.2) - px(-1)).toFixed(1)}" height="30" rx="3" fill="#c8321e"/>
    <rect x="${px(-1).toFixed(1)}" y="11" width="${(px(1.2) - px(-1) - 2).toFixed(1)}" height="5" rx="2" fill="#e9e4d8"/>
    <rect x="${px(0).toFixed(1)}" y="19" width="${(px(1.2) - px(0) - 2).toFixed(1)}" height="11" fill="#1c2a38"/>
    <rect x="${px(3.6).toFixed(1)}" y="38" width="4" height="7" fill="#c9ccd1"/>
    <rect x="${px(-1.4).toFixed(1)}" y="0" width="3" height="28" fill="#c9ccd1"/>
    <rect x="${px(-2.75) - 8}" y="41" width="16" height="3" fill="#5b5e64"/>
    <rect x="0" y="6" width="${px(-1.75).toFixed(1)}" height="37" fill="#1f7a8c"/>
    ${Array.from({ length: 28 }, (_, i) => `<rect x="${3 + i * 5}" y="6" width="1.6" height="37" fill="#000" opacity=".18"/>`).join('')}
    <rect x="0" y="6" width="${px(-1.75).toFixed(1)}" height="3" fill="#15525f"/><rect x="0" y="40" width="${px(-1.75).toFixed(1)}" height="3" fill="#15525f"/>
    ${[2.1, -2.2, -3.5, -10.35, -11.65, -12.95].map(wheel).join('')}
  </g>`;
})();

/** The gusanito on its card: the worm's head (eye, lips, antenna) and four wagons with striped canopies. */
const GUSANITO_ART = (() => {
  const canopies = ['#ffd21f', '#3fc4ff', '#8fdc2c', '#ff8a2a'];
  const wagons = canopies
    .map((c, i) => {
      const x = 4 + i * 36;
      return `<rect x="${x}" y="30" width="32" height="16" rx="7" fill="${i % 2 ? '#5fd06a' : '#8fdc2c'}"/>
      <rect x="${x + 2}" y="38" width="28" height="3" fill="#ffd21f"/>
      <circle cx="${x + 10}" cy="27" r="3.5" fill="#c68642"/><circle cx="${x + 22}" cy="27" r="3.5" fill="#f1c27d"/>
      <rect x="${x + 2}" y="12" width="2" height="18" fill="#f4f4f4"/><rect x="${x + 28}" y="12" width="2" height="18" fill="#f4f4f4"/>
      <path d="M${x} 13 Q${x + 16} 2 ${x + 32} 13 Z" fill="${c}"/>
      <circle cx="${x + 9}" cy="48" r="5" fill="#1b1b1b"/><circle cx="${x + 9}" cy="48" r="2" fill="#d9d9d4"/>`;
    })
    .join('');
  return `
  <g transform="translate(10,12)">${wagons}
    <rect x="148" y="26" width="44" height="20" rx="9" fill="#8fdc2c"/>
    <ellipse cx="178" cy="24" rx="14" ry="10" fill="#8fdc2c"/>
    <path d="M148 13 Q160 3 172 13 Z" fill="#ff5fae"/><rect x="150" y="12" width="2" height="16" fill="#f4f4f4"/>
    <rect x="166" y="12" width="2" height="16" fill="#1c2a38"/>
    <circle cx="182" cy="20" r="6" fill="#fff"/><circle cx="185" cy="20" r="3" fill="#2f62ff"/>
    <path d="M176 13 Q182 9 188 13" stroke="#151515" stroke-width="1.5" fill="none"/>
    <path d="M180 14 Q178 4 172 0" stroke="#9b5cff" stroke-width="2" fill="none"/><circle cx="172" cy="0" r="3" fill="#ff3fa0"/>
    <ellipse cx="193" cy="38" rx="5" ry="4" fill="#e8262b"/><circle cx="194" cy="29" r="3" fill="#e8262b"/>
    <rect x="148" y="38" width="40" height="3" fill="#ffd21f"/>
    <circle cx="157" cy="48" r="5" fill="#1b1b1b"/><circle cx="157" cy="48" r="2" fill="#d9d9d4"/>
    <circle cx="181" cy="48" r="5" fill="#1b1b1b"/><circle cx="181" cy="48" r="2" fill="#d9d9d4"/>
  </g>`;
})();

function busCard(p: BusPreset, blurb: string, checked: boolean, pool?: BusPreset[]): string {
  const { color, stripe, roof } = p.body;
  // Side view scaled to the bus's real length, so the buseta looks small and the coach long.
  const art = p.articulated;
  // The articulated bus is squeezed to fit the card: two sections and a bellows.
  const w = art ? 200 : 70 + p.body.length * 11;
  const joint = art ? ((p.body.length - art.rearLength - art.gap / 2) / p.body.length) * w : 0;
  const body = art
    ? `
          <rect x="0" y="0" width="${w}" height="10" rx="4" fill="${roof}"/>
          <rect x="0" y="6" width="${w}" height="48" rx="6" fill="${color}"/>
          <rect x="${w - joint + 2 - 6}" y="6" width="12" height="48" fill="#202225"/>
          <rect x="${w - 34}" y="12" width="30" height="30" rx="2" fill="#1c2a38"/>
          <rect x="8" y="14" width="${w - joint - 46}" height="16" rx="2" fill="#1c2a38"/>
          <rect x="${w - joint + 14}" y="14" width="${joint - 60}" height="16" rx="2" fill="#1c2a38"/>
          <rect x="0" y="36" width="${w}" height="6" fill="${stripe}"/>
          <circle cx="${w * 0.2}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.2}" cy="56" r="3.5" fill="#bbb"/>
          <circle cx="${w * 0.62}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.62}" cy="56" r="3.5" fill="#bbb"/>
          <circle cx="${w * 0.93}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.93}" cy="56" r="3.5" fill="#bbb"/>`
    : `
          <rect x="0" y="0" width="${w}" height="10" rx="4" fill="${roof}"/>
          <rect x="0" y="6" width="${w}" height="48" rx="6" fill="${color}"/>
          <rect x="10" y="14" width="${w - 34}" height="16" rx="2" fill="#1c2a38"/>
          <rect x="${w - 20}" y="12" width="16" height="30" rx="2" fill="#1c2a38"/>
          <rect x="0" y="36" width="${w}" height="6" fill="${stripe}"/>
          <circle cx="${w * 0.2}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.2}" cy="56" r="3.5" fill="#bbb"/>
          <circle cx="${w * 0.8}" cy="56" r="9" fill="#1b1b1b"/><circle cx="${w * 0.8}" cy="56" r="3.5" fill="#bbb"/>`;
  return `
    <button class="mn-card mn-bus" role="radio" aria-checked="${checked}" data-bus="${p.id}">
      <svg class="mn-bus-art" viewBox="0 0 220 80" aria-hidden="true">${
        p.kind === 'car'
          ? AE86_ART
          : p.kind === 'truck'
            ? TRUCK_ART
            : isTrain(p)
            ? GUSANITO_ART
            : `
        <g transform="translate(${(220 - w) / 2},8)">${body}
        </g>`
      }
      </svg>
      <span class="mn-card-name">${p.name}</span>
      <span class="mn-card-blurb">${blurb}</span>
      <dl class="mn-stats">${busStats(p, pool)
        .map((st) => `<dt>${st.label}</dt><dd><span style="--v:${st.value.toFixed(2)}"></span></dd>`)
        .join('')}</dl>
      <span class="mn-card-cap">${p.kind === 'car' ? `${p.capacity + 1} puestos` : p.kind === 'truck' ? 'Contenedor de 40 pies' : `${p.capacity} pasajeros`} · ${p.topSpeedKmh} km/h</span>
    </button>`;
}

/** `bestLap`: circuits only (null: none yet; undefined: not a circuit, no line). */
function trackCard(t: { id: string; name: string; blurb: string }, checked: boolean, best: number | null, bestLap?: number | null): string {
  return `
    <button class="mn-card mn-zone" role="radio" aria-checked="${checked}" data-track="${t.id}">
      <span class="mn-card-name">${t.name}</span>
      <span class="mn-card-blurb">${t.blurb}</span>
      <span class="mn-card-cap">${best !== null ? `Su récord: ${raceClock(best)}` : 'Sin récord todavía'}${bestLap === undefined ? '' : ` · Mejor vuelta: ${bestLap === null ? '—' : raceClock(bestLap)}`}</span>
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
      ${r.system ? '<span class="mn-placard-tip">Carril exclusivo · Recomendado: Articulado</span>' : ''}
      <span class="mn-placard-goal" title="Plata para ganar cada estrella">${targetsText(targets)}</span>
    </button>`;
}

function slider(name: string, label: string, value: number): string {
  const pct = Math.round(value * 100);
  return `<label class="mn-volume"><span>${label}</span><input type="range" min="0" max="100" step="5" value="${pct}" name="${name}" /><output>${pct}%</output></label>`;
}

function choice(name: string, value: string, label: string, checked: boolean, key = ''): string {
  return `<label class="mn-choice"><input type="radio" name="${name}" value="${value}" ${key ? `data-k="${key}"` : ''} ${checked ? 'checked' : ''} /><span>${label}</span></label>`;
}

const RACE_ON = 'Carrera en curso: espera a que termine y entras solo…';
/** How often a join to a room with a race on asks again, and how long it keeps waiting. */
const RACE_POLL_MS = 3000;
const RACE_WAIT_MS = 600_000;
const NO_SERVER = 'No hay conexión con el servidor de salas';
/** The lobby keeps trying a lost link a little past the room's grace for a seat. */
const LOBBY_GIVE_UP = 65_000;

const ERROR_TEXT: Record<string, string> = {
  full: 'Sala llena',
  racing: 'Carrera en curso: espera a que termine',
  version: 'Actualiza la página',
  unknown: 'No existe esa sala',
};

const SOFT_ERROR_TEXT: Record<string, string> = {
  notready: 'Falta que todos estén listos',
  bad: 'La sala cambió: intenta de nuevo',
  nohost: 'Solo el anfitrión puede arrancar',
};

const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function vehicleOptions(selected: string): string {
  return VEHICLES.map((v) => `<option value="${v.preset.id}" ${v.preset.id === selected ? 'selected' : ''}>${esc(v.preset.name)}</option>`).join('');
}

function seatRow(x: Seat, mine: boolean): string {
  const badges = [x.host ? 'Anfitrión' : '', x.online ? (x.ready && !x.host ? 'Listo' : '') : 'Desconectado'].filter(Boolean);
  return `<li class="mn-seat${x.online ? '' : ' mn-seat-off'}" data-seat="${x.id}">
    <span class="mn-seat-name">${esc(x.name)}${mine ? ' <em>(tú)</em>' : ''}</span>
    <span class="mn-seat-bus">${esc(busById(x.vehicle).name)}</span>
    ${badges.map((b) => `<span class="mn-badge mn-badge-${b === 'Listo' ? 'ready' : b === 'Anfitrión' ? 'host' : 'off'}">${b}</span>`).join('')}
  </li>`;
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
    ctx.strokeStyle = r.access ? '#d9a898' : '#b8b0a0';
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

/** The track from above (start green, finish checkered), and under it its profile: how far it falls. */
function drawTrackMap(canvas: HTMLCanvasElement, city: CityData): void {
  const t = city.race!;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  // A circuit is flat-ish: a line of text under the map in place of a height profile.
  const strip = t.circuit ? 34 : 84;
  const pad = 18;
  // A circuit shows one lap (the details are the circuit card's), not its laps piled up.
  const end = t.circuit ? t.start + t.circuit.lap : t.finish;
  const i0 = t.cum.findIndex((c) => c >= t.start);
  const i1 = t.cum.findIndex((c) => c >= end);
  const pts = t.points.slice(i0, i1 + 1);
  const xs = pts.map((p) => p.x);
  const zs = pts.map((p) => p.z);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const k = Math.min((W - pad * 2) / (x1 - x0), (H - strip - pad * 2) / (z1 - z0));
  const X = (x: number) => W / 2 + (x - (x0 + x1) / 2) * k;
  const Z = (z: number) => (H - strip) / 2 + (z - (z0 + z1) / 2) * k;
  ctx.fillStyle = '#dfe6d3';
  ctx.fillRect(0, 0, W, H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [w, c] of [[7, '#1d1a14'], [3.5, '#d98a00']] as const) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
    ctx.stroke();
  }
  const dot = (p: Vec2, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(X(p.x), Z(p.z), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  dot(pts[0], '#2e7d4f');
  if (!t.circuit) dot(pts[pts.length - 1], '#1d1a14');
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = '#1d1a14';
  ctx.textAlign = 'center';
  // Names over the ends, kept inside the canvas.
  const label = (text: string, p: Vec2) => {
    const half = ctx.measureText(text).width / 2 + 4;
    ctx.fillText(text, Math.max(half, Math.min(W - half, X(p.x))), Z(p.z) - 13);
  };
  label(t.from, pts[0]);
  if (!t.circuit) label(t.to, pts[pts.length - 1]);
  if (t.circuit) {
    ctx.fillStyle = '#16283a';
    ctx.fillRect(0, H - strip, W, strip);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`${((end - t.start) / 1000).toFixed(1).replace('.', ',')} km por vuelta · ${t.circuit.laps} vueltas`, pad, H - strip + 21);
    return;
  }
  // The profile: height against distance, from the start line to the finish.
  const ys = t.y.slice(i0, i1 + 1);
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const top = H - strip + 22;
  const bottom = H - 10;
  const PX = (c: number) => pad + ((c - t.start) / (end - t.start)) * (W - pad * 2);
  const PY = (y: number) => bottom - ((y - y0) / (y1 - y0 || 1)) * (bottom - top);
  ctx.fillStyle = '#16283a';
  ctx.fillRect(0, H - strip, W, strip);
  ctx.fillStyle = '#8ea88a';
  ctx.beginPath();
  ctx.moveTo(PX(t.start), bottom);
  ys.forEach((y, i) => ctx.lineTo(PX(t.cum[i0 + i]), PY(y)));
  ctx.lineTo(PX(end), bottom);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  const km = ((end - t.start) / 1000).toFixed(1).replace('.', ',');
  ctx.fillText(`${km} km · baja ${Math.round(ys[0] - ys[ys.length - 1])} m`, pad, H - strip + 15);
}
