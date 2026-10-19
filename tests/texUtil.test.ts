// Pure helpers behind the procedural textures: the tileable noise and the shared-texture disposal rule.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { disposeMaterial, isShared, memo, noiseField, seeded } from '../src/render/texUtil';

describe('noiseField', () => {
  const W = 64;
  const H = 32;
  const CELL = 8;
  const f = noiseField(W, H, CELL, seeded(7));
  const at = (x: number, y: number) => f[y * W + x];

  it('fills the image with values in 0..1', () => {
    expect(f.length).toBe(W * H);
    for (const v of f) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is the same for the same seed, and different for another', () => {
    expect(Array.from(noiseField(W, H, CELL, seeded(7)))).toEqual(Array.from(f));
    expect(Array.from(noiseField(W, H, CELL, seeded(8)))).not.toEqual(Array.from(f));
  });

  it('tiles: the step across each edge is no bigger than the steps inside', () => {
    let innerX = 0;
    let innerY = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x + 1 < W) innerX = Math.max(innerX, Math.abs(at(x + 1, y) - at(x, y)));
        if (y + 1 < H) innerY = Math.max(innerY, Math.abs(at(x, y + 1) - at(x, y)));
      }
    }
    let seamX = 0;
    let seamY = 0;
    for (let y = 0; y < H; y++) seamX = Math.max(seamX, Math.abs(at(0, y) - at(W - 1, y)));
    for (let x = 0; x < W; x++) seamY = Math.max(seamY, Math.abs(at(x, 0) - at(x, H - 1)));
    expect(innerX).toBeGreaterThan(0);
    expect(innerY).toBeGreaterThan(0);
    expect(seamX).toBeLessThanOrEqual(innerX);
    expect(seamY).toBeLessThanOrEqual(innerY);
  });
});

describe('disposeMaterial', () => {
  /** Counts 'dispose' events on t until the returned stop() is called. */
  function watch(t: THREE.EventDispatcher<{ dispose: object }>) {
    let n = 0;
    const on = () => n++;
    t.addEventListener('dispose', on);
    return {
      count: () => n,
      stop: () => t.removeEventListener('dispose', on),
    };
  }

  it('disposes the material and the textures it owns', () => {
    const own = new THREE.Texture();
    const rough = new THREE.Texture();
    const m = new THREE.MeshStandardMaterial({ map: own, roughnessMap: rough });
    const w = [watch(own), watch(rough), watch(m)];
    disposeMaterial(m);
    expect(w.map((x) => x.count())).toEqual([1, 1, 1]);
    w.forEach((x) => x.stop());
  });

  it('never disposes a memoized texture, even next to one it owns', () => {
    const shared = memo('texUtil-test', () => new THREE.Texture());
    const own = new THREE.Texture();
    expect(isShared(shared)).toBe(true);
    expect(isShared(own)).toBe(false);
    const m = new THREE.MeshStandardMaterial({ map: shared, alphaMap: own });
    const ws = watch(shared);
    const wo = watch(own);
    disposeMaterial(m);
    expect(ws.count()).toBe(0);
    expect(wo.count()).toBe(1);
    ws.stop();
    wo.stop();
  });
});
