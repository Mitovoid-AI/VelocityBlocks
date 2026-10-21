// Water surfaces (lakes and rivers on the Water tracks, the sea around their stadium, splash zones): one
// small shader cheap enough for phones. No reflection pass and no extra render target: ripples from a tiling
// noise texture drifting at two scales (one on Low), a Fresnel blend from the water's colour to the sky's
// horizon, and a sun glint. Opaque (lakes) or see-through (splash zones over the road). Fogged like the rest.

import * as THREE from 'three';
import { SUN_DIR } from './sky';
import { waterNoiseTexture } from './themeTextures';
import type { ThemeLook } from './themes';

/** Seconds of water animation, shared by every water material (World.update advances it). */
export const WATER_TIME = { value: 0 };

export interface WaterOptions {
  /** One noise fetch and no glint (the Low tier). */
  cheap?: boolean;
  /** See-through (splash zones over the road), with this opacity. */
  opacity?: number;
  /** World metres per noise tile (smaller: finer ripples). */
  scale?: number;
  /**
   * The geometry carries a `land` attribute (1 on the shore strips, 0 on the water): the shore is drawn in
   * this sand colour in the same draw call.
   */
  shore?: THREE.Color;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
#ifdef WATER_SHORE
attribute float land;
varying float vLand;
#endif
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
#ifdef WATER_SHORE
  vLand = land;
#endif
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float time;
uniform sampler2D noise;
uniform vec3 deep;
uniform vec3 shallow;
uniform vec3 skyCol;
uniform vec3 sunDir;
uniform vec3 sunCol;
uniform float opacity;
uniform float scale;
uniform vec3 shoreCol;
varying vec3 vWorld;
#ifdef WATER_SHORE
varying float vLand;
#endif
void main() {
  vec2 uv = vWorld.xz / scale;
  vec4 a = texture2D(noise, uv + vec2(time * 0.011, time * 0.007));
#ifdef WATER_HQ
  vec4 b = texture2D(noise, uv * 2.7 + vec2(-time * 0.019, time * 0.013));
  vec2 g = vec2(a.r - 0.5 + (b.g - 0.5) * 0.7, a.g - 0.5 + (b.r - 0.5) * 0.7);
#else
  vec2 g = vec2(a.r - 0.5, (a.g - 0.5) * 0.6);
#endif
  vec3 n = normalize(vec3(g.x * 0.35, 1.0, g.y * 0.35));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 col = mix(deep, shallow, clamp(0.3 + a.r * 0.45, 0.0, 1.0));
  col = mix(col, skyCol, clamp(0.12 + fres * 0.8, 0.0, 0.9));
#ifdef WATER_HQ
  vec3 h = normalize(sunDir + v);
  col += sunCol * pow(max(dot(n, h), 0.0), 220.0) * 1.6;
#endif
#ifdef WATER_SHORE
  col = mix(col, shoreCol * (0.84 + 0.12 * a.g), step(0.5, vLand));
#endif
  gl_FragColor = vec4(col, opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** A water material in a theme's colours. Dispose it with the mesh (the noise texture is shared). */
export function waterMaterial(look: ThemeLook, opts: WaterOptions = {}): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      noise: { value: null },
      deep: { value: new THREE.Color() },
      shallow: { value: new THREE.Color() },
      skyCol: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3() },
      sunCol: { value: new THREE.Color() },
      opacity: { value: 1 },
      scale: { value: 1 },
      shoreCol: { value: new THREE.Color() },
    },
  ]);
  // Shared by reference (merge clones), so one counter animates every water surface.
  uniforms.time = WATER_TIME;
  uniforms.noise.value = waterNoiseTexture();
  uniforms.deep.value.copy(look.waterDeep);
  uniforms.shallow.value.copy(look.waterShallow);
  uniforms.skyCol.value.copy(look.sky.horizon).lerp(look.sky.zenith, 0.25);
  uniforms.sunDir.value.copy(SUN_DIR);
  uniforms.sunCol.value.copy(look.sun);
  uniforms.opacity.value = opts.opacity ?? 1;
  uniforms.scale.value = opts.scale ?? 28;
  if (opts.shore) uniforms.shoreCol.value.copy(opts.shore);
  const see = opts.opacity !== undefined && opts.opacity < 1;
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    transparent: see,
    depthWrite: !see,
    defines: { ...(opts.cheap ? {} : { WATER_HQ: '' }), ...(opts.shore ? { WATER_SHORE: '' } : {}) },
  });
  m.name = 'water';
  return m;
}
