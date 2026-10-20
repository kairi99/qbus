import * as THREE from 'three';

/** One puff of cloud or mist: where, how big (m across) and how thick (0..1). */
export interface Puff {
  x: number;
  y: number;
  z: number;
  size: number;
  alpha: number;
}

/** Mist color by time of day, and how thick it shows (night mist is dark and thin). */
export const MIST_LOOK = {
  day: { color: '#f3f5f7', alpha: 1 },
  sunset: { color: '#f2d6c6', alpha: 0.95 },
  night: { color: '#4a5464', alpha: 0.6 },
} as const;

/**
 * Clouds and mist as soft billboards, all of them one instanced draw call: each puff faces the
 * camera, drifts slowly on its own (moved in the vertex shader from the clock, nothing per frame
 * on the CPU), fades out when the camera is inside it (no wall of white popping in) and past
 * `far`. Lumpy edges come from a few sines of the puff's own seed: no texture.
 */
export function mistMesh(puffs: Puff[], look: { color: string; alpha: number }, far: number): THREE.Mesh {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const center = new Float32Array(puffs.length * 3);
  const shape = new Float32Array(puffs.length * 3);
  puffs.forEach((p, i) => {
    center.set([p.x, p.y, p.z], i * 3);
    shape.set([p.size, p.alpha * look.alpha, (i * 0.618034) % 1], i * 3);
  });
  geo.setAttribute('center', new THREE.InstancedBufferAttribute(center, 3));
  geo.setAttribute('shape', new THREE.InstancedBufferAttribute(shape, 3));
  geo.instanceCount = puffs.length;
  const uniforms = { time: { value: 0 }, color: { value: new THREE.Color(look.color) }, far: { value: far } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `
      uniform float time; uniform float far;
      attribute vec3 center; attribute vec3 shape;
      varying vec2 vUv; varying float vAlpha; varying float vSeed;
      void main() {
        float seed = shape.z;
        // A slow drift along the valley and a gentle bob, each puff its own way.
        vec3 c = center + vec3(sin(time * 0.05 + seed * 40.0), sin(time * 0.11 + seed * 17.0) * 0.15, cos(time * 0.04 + seed * 23.0)) * shape.x * 0.12;
        vec4 mv = modelViewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * shape.x;
        float d = -mv.z;
        // Thin out with the camera inside a puff (it fades in from its edge to its middle), and far off.
        float inside = smoothstep(shape.x * 0.08, shape.x * 0.55, d);
        vAlpha = shape.y * inside * (1.0 - smoothstep(far * 0.6, far, d));
        vUv = uv; vSeed = seed;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 color;
      varying vec2 vUv; varying float vAlpha; varying float vSeed;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float a = atan(p.y, p.x);
        // A lumpy outline: the radius wobbles around the puff.
        float r = 0.78 + 0.12 * sin(a * 3.0 + vSeed * 31.0) + 0.07 * sin(a * 5.0 + vSeed * 13.0);
        float k = 1.0 - smoothstep(r * 0.25, r, length(p));
        if (k * vAlpha < 0.004) discard;
        // A little shading: thicker and brighter on top, greyer underneath.
        vec3 c = color * (0.86 + 0.14 * vUv.y);
        gl_FragColor = vec4(c, k * k * vAlpha);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.name = 'mist';
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  mesh.onBeforeRender = () => {
    uniforms.time.value = (performance.now() - t0) / 1000;
  };
  return mesh;
}
