// Sky dome, fog, sun direction and the small scene baked into the environment map, all from one
// palette, plus the shadow-box placement that follows the car.

import * as THREE from 'three';
import type { QualityProfile } from './quality';
import { cloudTexture } from './textures';
import { STADIUM_LOOK, type SkyPalette } from './themes';

/** Sun position relative to the point it lights; the shadow camera sits there. */
export const SUN_OFFSET = new THREE.Vector3(-120, 220, 90);
export const SUN_DIR = SUN_OFFSET.clone().normalize();

/** Linear colours (THREE.Color converts the sRGB hex): the Stadium's daylight sky (themes.ts has the others). */
export const SKY: SkyPalette = STADIUM_LOOK.sky;

export const FOG_NEAR = 400;
export const FOG_FAR = 2600;

/**
 * Fog towards the horizon colour. three applies fog after tone mapping and the sRGB conversion, so
 * a fully fogged hill is exactly the sky's horizon colour (the sky shader is colour-managed too).
 */
export function makeFog(p: SkyPalette = SKY): THREE.Fog {
  return new THREE.Fog(p.horizon.getHex(), FOG_NEAR, FOG_FAR);
}

/** Clear colour behind the dome (only ever visible if the dome is culled). */
export function makeBackground(p: SkyPalette = SKY): THREE.Color {
  return p.horizon.clone();
}

/** Where the sun glow is drawn on the dome: the light's direction, lowered by the palette's glowDrop (a sunset). */
export function glowDirFor(p: SkyPalette): THREE.Vector3 {
  if (!p.glowDrop) return SUN_DIR.clone();
  const el = Math.max(0.035, Math.asin(SUN_DIR.y) - p.glowDrop);
  const h = Math.hypot(SUN_DIR.x, SUN_DIR.z) || 1;
  return new THREE.Vector3((SUN_DIR.x / h) * Math.cos(el), Math.sin(el), (SUN_DIR.z / h) * Math.cos(el));
}

/** The sky dome's render order: after every other opaque object (see skyMesh). */
export const SKY_RENDER_ORDER = 1000;

/** Gradient dome with a sun glow and a thin layer of cumulus (one texture fetch). */
export function skyMesh(p: SkyPalette = SKY): THREE.Mesh {
  const geo = new THREE.SphereGeometry(3500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      top: { value: p.zenith },
      horizon: { value: p.horizon },
      sunDir: { value: p.glowDrop ? glowDirFor(p) : SUN_DIR },
      clouds: { value: cloudTexture() },
      cloudAmount: { value: p.clouds },
      cloudColor: { value: p.cloudColor },
      glowColor: { value: p.glow },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform sampler2D clouds; uniform float cloudAmount;
      uniform vec3 cloudColor; uniform vec3 glowColor; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(d, sunDir), 0.0);
        // A flat cloud layer projected onto the dome, thinning out towards the horizon.
        vec2 uv = d.xz / (h + 0.15) * 0.6;
        float a = texture2D(clouds, uv).r * smoothstep(0.03, 0.3, h) * cloudAmount;
        c = mix(c, cloudColor + vec3(0.07, 0.05, 0.0) * s, clamp(a, 0.0, 1.0));
        c += glowColor * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  // Last of the opaque objects: it sits on the far plane (z = w), so the depth test skips every
  // pixel the ground, stands and hills already cover instead of shading the whole screen first.
  // Transparents draw after all opaques anyway.
  sky.renderOrder = SKY_RENDER_ORDER;
  return sky;
}

/** Repaint a dome from skyMesh with another palette (a track of another theme). */
export function applySkyPalette(sky: THREE.Mesh, p: SkyPalette): void {
  const u = (sky.material as THREE.ShaderMaterial).uniforms;
  u.top.value = p.zenith;
  u.horizon.value = p.horizon;
  u.sunDir.value = p.glowDrop ? glowDirFor(p) : SUN_DIR;
  u.cloudAmount.value = p.clouds;
  u.cloudColor.value = p.cloudColor;
  u.glowColor.value = p.glow;
}

/**
 * What metallic paint, glass and chrome reflect: a paler version of the sky gradient, a dark band
 * of stands up to about 15 degrees, the ground below and four floodlight strips (HDR) for crisp
 * highlights. The stands band also keeps grazing reflections on the road from turning sky blue on
 * High. No sun disc: the directional light already makes that highlight, and an HDR sun here would
 * leak light into the shadows.
 */
export function buildEnvScene(p: SkyPalette = SKY): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 48, 24);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    if (y >= 0.25) c.copy(p.horizon).lerp(p.zenith, 0.6 * Math.pow((y - 0.25) / 0.75, 0.55));
    else if (y >= 0) c.copy(p.stands).lerp(p.horizon, Math.pow(y / 0.25, 2));
    else c.copy(p.stands).lerp(p.ground, Math.min(1, -y / 0.25));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const strip = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4) });
  const stripGeo = new THREE.BoxGeometry(40, 0.8, 0.5);
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * (Math.PI / 2);
    const m = new THREE.Mesh(stripGeo, strip);
    m.position.set(Math.cos(a) * 40, 9, Math.sin(a) * 40);
    m.lookAt(0, 9, 0);
    scene.add(m);
  }
  return scene;
}

/** Baked environment for metallic materials (cars, gate posts); World sets it once the PMREM bake is done. */
export const ENV_LIGHT: { map: THREE.Texture | null; intensity: number } = { map: null, intensity: 0.6 };

function eachStandard(root: THREE.Object3D, fn: (m: THREE.MeshStandardMaterial) => void): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) if (mm instanceof THREE.MeshStandardMaterial) fn(mm);
  });
}

/**
 * Tag the metallic materials under root (car paint, glass and chrome, gate posts) and point them
 * at the environment. Metals reflect nothing else, so without it they read black.
 */
export function markEnvLit(root: THREE.Object3D): void {
  eachStandard(root, (m) => {
    if (m.metalness > 0.2) m.userData.envLit = true;
  });
  refreshEnvLit(root);
}

/** Re-point every tagged material under root at ENV_LIGHT (after a bake, a tier change or a lost context). */
export function refreshEnvLit(root: THREE.Object3D): void {
  eachStandard(root, (m) => {
    if (!m.userData.envLit) return;
    m.envMap = ENV_LIGHT.map;
    m.envMapIntensity = ENV_LIGHT.intensity;
  });
}

// Shadow camera axes. DirectionalLightShadow points the camera from the light at its target with
// world up, so the camera's right is cross(forward, up) and its up is cross(right, forward).
const UP = new THREE.Vector3(0, 1, 0);
const L_F = SUN_DIR.clone().negate();
const L_R = new THREE.Vector3().crossVectors(L_F, UP).normalize();
const L_U = new THREE.Vector3().crossVectors(L_R, L_F);

/**
 * Snap p to whole shadow-map texels in light space, keeping its depth along the light. A shadow
 * box that moves in texel steps keeps every edge on the same texels, so shadows stop crawling.
 * texel <= 0 (no shadow box) leaves p alone.
 */
export function snapToShadowTexel(p: THREE.Vector3, texel: number): THREE.Vector3 {
  if (!(texel > 0)) return p;
  const lx = Math.round(p.dot(L_R) / texel) * texel;
  const ly = Math.round(p.dot(L_U) / texel) * texel;
  const lz = p.dot(L_F);
  return p.copy(L_R).multiplyScalar(lx).addScaledVector(L_U, ly).addScaledVector(L_F, lz);
}

/**
 * Where the sun's target goes for a car at (x, y, z) with the camera looking along (lookX, lookZ):
 * the box is pushed 40% of its half-size ahead of the camera, then snapped to texels. With shadows
 * off (or no box) it is simply the car.
 */
export function shadowFocus(
  out: THREE.Vector3,
  x: number,
  y: number,
  z: number,
  lookX: number,
  lookZ: number,
  p: QualityProfile,
): THREE.Vector3 {
  const e = p.shadowExtent;
  if (!p.shadows || !(e > 0)) return out.set(x, y, z);
  const l = Math.hypot(lookX, lookZ);
  const k = l > 1e-6 ? (e * 0.4) / l : 0;
  out.set(x + lookX * k, y, z + lookZ * k);
  return snapToShadowTexel(out, (2 * e) / p.shadowMap);
}
