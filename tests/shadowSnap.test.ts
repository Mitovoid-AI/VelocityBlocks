// The shadow box follows the car in whole shadow-map texels (no crawling edges), and never puts NaN
// into the sun on the low tier, where there is no shadow box at all.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { QUALITY } from '../src/render/quality';
import { shadowFocus, snapToShadowTexel, SUN_DIR, SUN_OFFSET } from '../src/render/sky';

const MAP = QUALITY.medium.shadowMap;
const EXT = QUALITY.medium.shadowExtent;
const TEXEL = (2 * EXT) / MAP;

const F = SUN_DIR.clone().negate();
const R = new THREE.Vector3().crossVectors(F, new THREE.Vector3(0, 1, 0)).normalize();
const U = new THREE.Vector3().crossVectors(R, F);

const POINTS = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(5.3, 1, 2.2),
  new THREE.Vector3(100.7, 8, -42.9),
  new THREE.Vector3(-317.2, 0.4, 611.4),
  new THREE.Vector3(1023.9, 56, 1023.1),
];

/** Distance between two fractions on the unit circle (0.999 and 0.001 are close). */
const fracDist = (a: number, b: number) => {
  const d = Math.abs((a - Math.floor(a)) - (b - Math.floor(b)));
  return Math.min(d, 1 - d);
};

describe('snapToShadowTexel', () => {
  it('is idempotent', () => {
    for (const p of POINTS) {
      const once = snapToShadowTexel(p.clone(), TEXEL);
      const twice = snapToShadowTexel(once.clone(), TEXEL);
      expect(twice.distanceTo(once)).toBeLessThan(1e-9);
    }
  });

  it('keeps the depth along the light and moves at most half a texel diagonal', () => {
    for (const p of POINTS) {
      const s = snapToShadowTexel(p.clone(), TEXEL);
      expect(s.dot(F)).toBeCloseTo(p.dot(F), 9);
      expect(s.distanceTo(p)).toBeLessThanOrEqual((TEXEL * Math.SQRT2) / 2 + 1e-9);
    }
  });

  it('maps points within half a texel of a grid point to that grid point', () => {
    for (const p of POINTS) {
      const g = snapToShadowTexel(p.clone(), TEXEL);
      for (const [a, b] of [
        [0.49, 0],
        [-0.49, 0.3],
        [0.2, -0.45],
      ]) {
        const q = g.clone().addScaledVector(R, a * TEXEL).addScaledVector(U, b * TEXEL).addScaledVector(F, 3);
        const s = snapToShadowTexel(q, TEXEL);
        expect(s.clone().addScaledVector(F, -3).distanceTo(g)).toBeLessThan(1e-9);
      }
    }
  });

  it('lands on whole texels of the shadow camera three r186 builds', () => {
    const light = new THREE.DirectionalLight();
    light.shadow.mapSize.set(MAP, MAP);
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -EXT;
    cam.right = cam.top = EXT;
    cam.near = 10;
    cam.far = 600;
    cam.updateProjectionMatrix();
    // A fixed world point must sit at the same sub-texel offset whichever snapped box looks at it.
    const P = new THREE.Vector3(13.37, 2, -7.1);
    const texelOf = (target: THREE.Vector3) => {
      light.target.position.copy(target);
      light.position.copy(target).add(SUN_OFFSET);
      light.updateMatrixWorld();
      light.target.updateMatrixWorld();
      light.shadow.updateMatrices(light);
      const uv = P.clone().applyMatrix4(light.shadow.matrix);
      return [uv.x * MAP, uv.y * MAP];
    };
    const ref = texelOf(snapToShadowTexel(POINTS[1].clone(), TEXEL));
    for (const p of POINTS) {
      const t = texelOf(snapToShadowTexel(p.clone(), TEXEL));
      expect(fracDist(t[0], ref[0])).toBeLessThan(1e-4);
      expect(fracDist(t[1], ref[1])).toBeLessThan(1e-4);
    }
    // Sanity: without snapping the offset does change.
    const raw = texelOf(new THREE.Vector3(0.0173, 0, 0.0311));
    expect(Math.max(fracDist(raw[0], ref[0]), fracDist(raw[1], ref[1]))).toBeGreaterThan(1e-3);
  });
});

describe('shadowFocus', () => {
  it('never produces NaN on the low tier (no shadow box)', () => {
    const out = shadowFocus(new THREE.Vector3(), 10, 2, -5, 0.3, 0.9, QUALITY.low);
    expect(out.toArray()).toEqual([10, 2, -5]);
    expect(snapToShadowTexel(new THREE.Vector3(1, 2, 3), 0).toArray()).toEqual([1, 2, 3]);
  });

  it('pushes the box ahead of the camera and snaps it on medium and high', () => {
    for (const q of ['medium', 'high'] as const) {
      const p = QUALITY[q];
      const texel = (2 * p.shadowExtent) / p.shadowMap;
      const out = shadowFocus(new THREE.Vector3(), 40, 8, 40, 0, -2, p);
      expect(out.toArray().every(Number.isFinite)).toBe(true);
      expect(out.distanceTo(new THREE.Vector3(40, 8, 40 - p.shadowExtent * 0.4))).toBeLessThanOrEqual(texel + 1e-9);
      // Looking straight down (no horizontal direction): the box stays on the car.
      const down = shadowFocus(new THREE.Vector3(), 40, 8, 40, 0, 0, p);
      expect(down.distanceTo(new THREE.Vector3(40, 8, 40))).toBeLessThanOrEqual(texel);
    }
  });
});
