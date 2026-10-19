// Canvas helpers shared by the procedural texture factories. Nothing here touches the DOM at
// import time, and without a DOM (vitest runs under node) every factory returns one shared
// 1x1 white placeholder, so render modules can still be built and inspected in tests.

import * as THREE from 'three';

export const HAS_DOM = typeof document !== 'undefined';

let aniso = 4;
const cache = new Map<string, THREE.Texture>();
const shared = new Set<THREE.Texture>();
let placeholder: THREE.Texture | null = null;

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Colour textures are sRGB; data maps (roughness, cloud masks) pass srgb = false. */
export function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** One texture per key for the whole session. Never dispose what this returns (see isShared). */
export function memo(key: string, make: () => THREE.Texture): THREE.Texture {
  if (!HAS_DOM) {
    if (!placeholder) {
      placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      placeholder.needsUpdate = true;
      shared.add(placeholder);
    }
    return placeholder;
  }
  let t = cache.get(key);
  if (!t) {
    cache.set(key, (t = make()));
    shared.add(t);
  }
  return t;
}

/** Memoized textures are shared by every track and stadium: owners dispose only their own clones. */
export function isShared(t: THREE.Texture): boolean {
  return shared.has(t);
}

/** Every memoized texture so far (the shader warm-up uploads them before the race starts). */
export function sharedTextures(): Iterable<THREE.Texture> {
  return shared;
}

/** Dispose a material and the textures on it that are not memoized (clones, one-offs). */
export function disposeMaterial(m: THREE.Material): void {
  for (const v of Object.values(m)) if (v instanceof THREE.Texture && !shared.has(v)) v.dispose();
  m.dispose();
}

/** Anisotropic filtering for every memoized texture, now and later (set per quality tier). */
export function setAnisotropy(n: number): void {
  if (n === aniso) return;
  aniso = n;
  for (const t of cache.values()) {
    t.anisotropy = n;
    t.needsUpdate = true;
  }
}

/**
 * Tileable value noise in 0..1, one sample per pixel of a w x h image with `cell`-pixel cells
 * (w and h should be multiples of cell so the lattice wraps exactly).
 */
export function noiseField(w: number, h: number, cell: number, rnd: () => number): Float32Array {
  const gx = Math.max(1, Math.round(w / cell));
  const gy = Math.max(1, Math.round(h / cell));
  const lat = new Float32Array(gx * gy);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  // Per-column and per-row lattice indices and weights, so the inner loop is lookups and lerps.
  const axis = (n: number, g: number) => {
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const t = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const f = (p / n) * g;
      const k = Math.floor(f);
      const s = f - k;
      i0[p] = k % g;
      i1[p] = (k + 1) % g;
      t[p] = s * s * (3 - 2 * s);
    }
    return { i0, i1, t };
  };
  const ax = axis(w, gx);
  const ay = axis(h, gy);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = ay.i0[y] * gx;
    const r1 = ay.i1[y] * gx;
    const ty = ay.t[y];
    for (let x = 0; x < w; x++) {
      const tx = ax.t[x];
      const a = lat[r0 + ax.i0[x]];
      const b = lat[r0 + ax.i1[x]];
      const c = lat[r1 + ax.i0[x]];
      const d = lat[r1 + ax.i1[x]];
      const top = a + (b - a) * tx;
      out[y * w + x] = top + (c + (d - c) * tx - top) * ty;
    }
  }
  return out;
}
