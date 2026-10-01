import * as THREE from 'three';

const SKY_TOP = new THREE.Color('#5d9be0');
export const SKY_HORIZON = new THREE.Color('#dfe9ee');

/**
 * Vertical gradient sky dome that follows the camera. It belongs to the backdrop pass
 * (`backdrop.ts`), drawn before the city.
 */
export function skyDome(): THREE.Mesh {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
      vertexShader: `varying float vH;
        void main() { vH = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying float vH;
        void main() { gl_FragColor = vec4(mix(horizon, top, pow(clamp(vH, 0.0, 1.0), 0.6)), 1.0); }`,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.onBeforeRender = (_r, _s, camera) => sky.position.copy(camera.position);
  return sky;
}

/** Slowroads-style look: distance fog matching the sky's horizon, soft sun + sky light. */
export function setupSky(scene: THREE.Scene): THREE.DirectionalLight {
  scene.fog = new THREE.Fog(SKY_HORIZON, 120, 560);
  scene.add(new THREE.HemisphereLight('#cfe6ff', '#6b7a4a', 1.4));
  const sun = new THREE.DirectionalLight('#fff3dc', 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  const c = sun.shadow.camera;
  c.left = c.bottom = -60;
  c.right = c.top = 60;
  c.near = 1;
  c.far = 300;
  scene.add(sun, sun.target);

  return sun;
}

const SUN_OFFSET = new THREE.Vector3(60, 110, 40);

export function followSun(sun: THREE.DirectionalLight, focus: THREE.Vector3): void {
  sun.target.position.copy(focus);
  sun.position.copy(focus).add(SUN_OFFSET);
}
