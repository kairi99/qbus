import * as THREE from 'three';
import type { WeatherState } from '../gameplay/weather';
import { LIGHTING, type TimeOfDay } from './sky';

/** Raindrops at the heaviest, in a box around the camera (m). */
const DROPS = 7000;
const BOX = new THREE.Vector3(70, 34, 70);
/** Fall speed (m/s) and streak length (m) at the heaviest. */
const FALL = 22;
const STREAK = 0.9;
/** Overcast sky and fog under a downpour, by time of day. */
const OVERCAST: Record<TimeOfDay, string> = { day: '#8d969b', sunset: '#7a706d', night: '#10151e' };
/** How much of the light the clouds take at the heaviest: sky light, and the sun (gone behind them). */
const DIM_HEMI = 0.35;
const DIM_SUN = 0.7;
/** Fog closes in this much (share of its distances) at the heaviest. */
const FOG_IN = 0.5;
/** Lightning only in rain this heavy, every LIGHTNING_EVERY seconds or so. */
const LIGHTNING_RAIN = 0.75;
const LIGHTNING_EVERY: [number, number] = [9, 26];

/**
 * Rain as the player sees it: streaks falling around the camera (one draw call of line segments,
 * moved entirely in the vertex shader: nothing per frame but a few uniforms), the sky, fog and
 * light turning overcast with how hard it rains (in the city scene and the backdrop alike), and
 * lightning in a downpour (`onThunder` is called when the thunder should be heard). Under a roof
 * (`update`'s `covered`) the streaks fade out: no rain in a tunnel.
 */
export class RainView {
  readonly streaks: THREE.LineSegments;
  /** Called a moment after each flash, with how far it was (0..1). */
  onThunder: ((distance: number) => void) | null = null;
  private uniforms = {
    cam: { value: new THREE.Vector3() },
    time: { value: 0 },
    amount: { value: 0 },
    box: { value: BOX },
    color: { value: new THREE.Color('#c8d2dc') },
  };
  private base: {
    fog: THREE.Color;
    near: number;
    far: number;
    backFog: THREE.Color | null;
    hemi: { light: THREE.HemisphereLight; intensity: number }[];
    sun: { light: THREE.DirectionalLight; intensity: number }[];
    sky: { top: THREE.Color; horizon: THREE.Color; uTop: THREE.Color; uHorizon: THREE.Color } | null;
    clear: THREE.Color;
  };
  private overcast: THREE.Color;
  private covered = 0;
  private time = 0;
  private nextFlash = LIGHTNING_EVERY[0];
  private flash = 0;
  private thunderIn = -1;
  private thunderDistance = 0.5;
  private tmp = new THREE.Color();

  constructor(
    private scene: THREE.Scene,
    private backdrop: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    tod: TimeOfDay,
  ) {
    const pos = new Float32Array(DROPS * 6);
    const tip = new Float32Array(DROPS * 2);
    const seed = new Float32Array(DROPS * 2);
    for (let i = 0; i < DROPS; i++) {
      const [x, y, z, s] = [Math.random(), Math.random(), Math.random(), Math.random()];
      pos.set([x, y, z, x, y, z], i * 6);
      tip.set([0, 1], i * 2);
      seed.set([s, s], i * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('tip', new THREE.BufferAttribute(tip, 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        uniform vec3 cam; uniform float time; uniform float amount; uniform vec3 box;
        attribute float tip; attribute float seed;
        varying float vFade;
        void main() {
          // Fewer drops in lighter rain: the ones whose seed is over the amount aren't drawn.
          if (seed > amount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float fall = ${FALL.toFixed(1)} * (0.75 + 0.5 * seed);
          vec3 lo = cam - box * vec3(0.5, 0.35, 0.5);
          vec3 p = position * box;
          // Each drop stays put in the world (wrapping round the box as the camera moves) and falls.
          p.xz = lo.xz + mod(p.xz - lo.xz, box.xz);
          p.y = lo.y + mod(p.y - time * fall, box.y);
          // Its streak trails up and a little against the wind.
          p += tip * vec3(-0.08, ${STREAK.toFixed(2)}, 0.05) * (0.6 + 0.4 * amount);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vFade = clamp(1.0 - length(mv.xyz) / (box.x * 0.5), 0.0, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 color; uniform float amount; varying float vFade;
        void main() { gl_FragColor = vec4(color, (0.25 + 0.3 * amount) * vFade); }`,
    });
    this.streaks = new THREE.LineSegments(geo, mat);
    this.streaks.frustumCulled = false;
    this.streaks.visible = false;
    this.streaks.renderOrder = 5;
    scene.add(this.streaks);

    const fog = scene.fog as THREE.Fog;
    const lights = <T extends THREE.Light>(root: THREE.Object3D, is: (o: THREE.Object3D) => o is T) => {
      const out: { light: T; intensity: number }[] = [];
      root.traverse((o) => is(o) && out.push({ light: o, intensity: o.intensity }));
      return out;
    };
    const isHemi = (o: THREE.Object3D): o is THREE.HemisphereLight => (o as THREE.HemisphereLight).isHemisphereLight === true;
    const isSun = (o: THREE.Object3D): o is THREE.DirectionalLight => (o as THREE.DirectionalLight).isDirectionalLight === true;
    let sky: RainView['base']['sky'] = null;
    backdrop.traverse((o) => {
      const u = ((o as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms;
      if (u?.top && u.horizon) sky = { top: (u.top.value as THREE.Color).clone(), horizon: (u.horizon.value as THREE.Color).clone(), uTop: u.top.value, uHorizon: u.horizon.value };
    });
    this.base = {
      fog: fog.color.clone(),
      near: fog.near,
      far: fog.far,
      backFog: (backdrop.fog as THREE.Fog | null)?.color.clone() ?? null,
      hemi: [...lights(scene, isHemi), ...lights(backdrop, isHemi)],
      sun: [...lights(scene, isSun), ...lights(backdrop, isSun)],
      sky,
      clear: LIGHTING[tod].horizon.clone(),
    };
    // The uniforms are shared with LIGHTING's colors: give the sky its own copies to tint.
    if (this.base.sky) {
      const s = this.base.sky as NonNullable<RainView['base']['sky']>;
      backdrop.traverse((o) => {
        const u = ((o as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms;
        if (u?.top && u.horizon) {
          u.top.value = s.uTop = s.top.clone();
          u.horizon.value = s.uHorizon = s.horizon.clone();
        }
      });
    }
    this.overcast = new THREE.Color(OVERCAST[tod]);
  }

  /** `covered`: the camera is under a roof (a tunnel, a deck). */
  update(w: WeatherState, camera: THREE.Camera, dt: number, covered: boolean): void {
    this.time += dt;
    this.covered += ((covered ? 1 : 0) - this.covered) * Math.min(1, dt * 4);
    const r = w.rain;
    this.uniforms.time.value = this.time;
    this.uniforms.cam.value.copy(camera.position);
    this.uniforms.amount.value = r * (1 - this.covered);
    this.streaks.visible = this.uniforms.amount.value > 0.01;

    this.lightning(r, dt);
    // Clouds: the sky, fog and light go grey with the rain (and come back when it stops).
    const k = Math.min(1, r * 1.1);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.base.fog).lerp(this.overcast, k * 0.85);
    fog.near = this.base.near * (1 - FOG_IN * 1.2 * k);
    fog.far = this.base.far * (1 - FOG_IN * k);
    const backFog = this.backdrop.fog as THREE.Fog | null;
    if (backFog && this.base.backFog) backFog.color.copy(this.base.backFog).lerp(this.overcast, k * 0.85);
    const s = this.base.sky;
    if (s) {
      s.uTop.copy(s.top).lerp(this.overcast, k * 0.9);
      s.uHorizon.copy(s.horizon).lerp(this.overcast, k * 0.85);
    }
    const flash = this.flash;
    for (const h of this.base.hemi) h.light.intensity = h.intensity * (1 - DIM_HEMI * k) + flash * 2.2;
    for (const l of this.base.sun) l.light.intensity = l.intensity * (1 - DIM_SUN * k);
    if (s && flash > 0) {
      s.uTop.lerp(this.tmp.set('#e8ecff'), flash * 0.6);
      s.uHorizon.lerp(this.tmp, flash * 0.6);
    }
    this.renderer.setClearColor(this.tmp.copy(this.base.clear).lerp(this.overcast, k * 0.85));
  }

  /** A flash now and then in a downpour (a double flicker), its thunder a moment later. */
  private lightning(rain: number, dt: number): void {
    this.flash = 0;
    if (this.thunderIn >= 0 && (this.thunderIn -= dt) < 0) this.onThunder?.(this.thunderDistance);
    if (rain < LIGHTNING_RAIN) return;
    this.nextFlash -= dt;
    if (this.nextFlash < 0.35 && this.nextFlash > 0) {
      const t = 0.35 - this.nextFlash;
      this.flash = t < 0.08 ? 1 : t < 0.15 ? 0.15 : t < 0.22 ? 0.7 : Math.max(0, 1 - (t - 0.22) * 8) * 0.5;
    }
    if (this.nextFlash <= 0) {
      this.thunderDistance = Math.random();
      this.thunderIn = 0.3 + this.thunderDistance * 2.5;
      this.nextFlash = LIGHTNING_EVERY[0] + Math.random() * (LIGHTNING_EVERY[1] - LIGHTNING_EVERY[0]);
    }
  }
}
