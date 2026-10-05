import * as THREE from 'three';

/** Time of day of a game (a setting): fixed for the whole session, baked into the city when it's built. */
export type TimeOfDay = 'day' | 'sunset' | 'night';
export const TIMES_OF_DAY: readonly TimeOfDay[] = ['day', 'sunset', 'night'];

export function parseTimeOfDay(s: unknown): TimeOfDay | null {
  return TIMES_OF_DAY.includes(s as TimeOfDay) ? (s as TimeOfDay) : null;
}

/** Everything the light of a time of day sets: sky, fog, ambient, sun (or moon), city lights. */
export interface Lighting {
  skyTop: THREE.Color;
  /** Sky at the horizon; also the fog and the far haze, so the city fades into the sky. */
  horizon: THREE.Color;
  /** Glow around the sun low on the horizon (black: none). */
  glow: THREE.Color;
  /** Faint stars. */
  stars: boolean;
  fogNear: number;
  fogFar: number;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sunColor: string;
  sun: number;
  /** Where the sun is, from what it lights. */
  sunOffset: THREE.Vector3;
  shadows: boolean;
  /** Street lamps on, with pools of light under them (only in the dark). */
  lamps: boolean;
  pools: boolean;
  /** Share of windows lit from inside. */
  litWindows: number;
  /** Headlights: lit lamps and beams on the road. */
  headlights: boolean;
}

export const LIGHTING: Record<TimeOfDay, Lighting> = {
  day: {
    skyTop: new THREE.Color('#5d9be0'),
    horizon: new THREE.Color('#dfe9ee'),
    glow: new THREE.Color('#000000'),
    stars: false,
    fogNear: 120,
    fogFar: 560,
    hemiSky: '#cfe6ff',
    hemiGround: '#6b7a4a',
    hemi: 1.4,
    sunColor: '#fff3dc',
    sun: 2.2,
    sunOffset: new THREE.Vector3(60, 110, 40),
    shadows: true,
    lamps: false,
    pools: false,
    litWindows: 0,
    headlights: false,
  },
  // Quito's sun sets behind Pichincha, to the west, fast and orange.
  sunset: {
    skyTop: new THREE.Color('#41609c'),
    horizon: new THREE.Color('#eeb08a'),
    glow: new THREE.Color('#ff9a4a'),
    stars: false,
    fogNear: 110,
    fogFar: 520,
    hemiSky: '#c7b2c6',
    hemiGround: '#5a4a3c',
    hemi: 1.15,
    sunColor: '#ffb070',
    sun: 2.0,
    sunOffset: new THREE.Vector3(-150, 42, 25),
    shadows: true,
    lamps: true,
    pools: false,
    litWindows: 0.14,
    headlights: true,
  },
  night: {
    skyTop: new THREE.Color('#050a1a'),
    horizon: new THREE.Color('#1b2540'),
    glow: new THREE.Color('#000000'),
    stars: true,
    fogNear: 70,
    fogFar: 430,
    hemiSky: '#5a6fa8',
    hemiGround: '#2a2a30',
    hemi: 0.75,
    sunColor: '#9fb6ff',
    sun: 0.35,
    sunOffset: new THREE.Vector3(40, 110, -60),
    shadows: false,
    lamps: true,
    pools: true,
    litWindows: 0.38,
    headlights: true,
  },
};

/**
 * Vertical gradient sky dome that follows the camera, with the sun's glow at sunset and
 * stars at night. It belongs to the backdrop pass (`backdrop.ts`), drawn before the city.
 */
export function skyDome(tod: TimeOfDay = 'day'): THREE.Mesh {
  const l = LIGHTING[tod];
  const sunDir = l.sunOffset.clone().normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: l.skyTop },
        horizon: { value: l.horizon },
        glow: { value: l.glow },
        sunDir: { value: sunDir },
        stars: { value: l.stars ? 1 : 0 },
      },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 glow; uniform vec3 sunDir; uniform float stars; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.6));
          // Sun glow: wide and low, hugging the horizon on the sun's side.
          float s = max(dot(d, sunDir), 0.0);
          c += glow * (pow(s, 6.0) * 0.55 + pow(s, 60.0) * 0.6) * (1.0 - clamp(d.y * 1.5, 0.0, 1.0));
          if (stars > 0.5 && d.y > 0.08) {
            vec3 cell = floor(d * 180.0);
            float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            c += vec3(step(0.9975, h) * 0.8 * clamp((d.y - 0.08) * 4.0, 0.0, 1.0));
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.onBeforeRender = (_r, _s, camera) => sky.position.copy(camera.position);
  return sky;
}

/** Slowroads-style look: distance fog matching the sky's horizon, soft sun + sky light. */
export function setupSky(scene: THREE.Scene, tod: TimeOfDay = 'day'): THREE.DirectionalLight {
  const l = LIGHTING[tod];
  scene.userData.timeOfDay = tod;
  scene.fog = new THREE.Fog(l.horizon, l.fogNear, l.fogFar);
  scene.add(new THREE.HemisphereLight(l.hemiSky, l.hemiGround, l.hemi));
  const sun = new THREE.DirectionalLight(l.sunColor, l.sun);
  sun.castShadow = l.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  const c = sun.shadow.camera;
  c.left = c.bottom = -60;
  c.right = c.top = 60;
  c.near = 1;
  c.far = 400;
  sun.userData.offset = l.sunOffset;
  scene.add(sun, sun.target);

  return sun;
}

/** The time of day a scene was set up for (`setupSky`); day if it wasn't. */
export function timeOfDayOf(scene: THREE.Object3D): TimeOfDay {
  return parseTimeOfDay(scene.userData.timeOfDay) ?? 'day';
}

export function followSun(sun: THREE.DirectionalLight, focus: THREE.Vector3): void {
  sun.target.position.copy(focus);
  sun.position.copy(focus).add(sun.userData.offset ?? LIGHTING.day.sunOffset);
}
