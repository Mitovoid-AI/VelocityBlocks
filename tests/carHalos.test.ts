// Lamp glow cards on the cars: one additive mesh per car, facing along each lamp, off on ghosts.

import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { CAR_BODIES } from '../src/core/cars';
import { CAR_FX, CarView, haloMesh } from '../src/render/carView';

const halosOf = (v: CarView) => v.visual.root.getObjectByName('halos') as THREE.Mesh | undefined;

describe('lamp halos', () => {
  afterEach(() => {
    CAR_FX.halos = true;
  });

  it('needs lamps', () => {
    expect(haloMesh([])).toBeNull();
  });

  it.each(CAR_BODIES.map((b) => b.id))('gives the %s one card per lamp, facing along it', (body) => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', body });
    const halo = halosOf(v)!;
    const lights = v.visual.lights;
    expect(halo.geometry.attributes.position.count).toBe(lights.length * 4);
    const mat = halo.material as THREE.MeshBasicMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.toneMapped).toBe(false);
    expect(mat.fog).toBe(false);
    expect(mat.side).toBe(THREE.FrontSide);
    expect(halo.castShadow).toBe(false);
    const pos = halo.geometry.attributes.position;
    const nor = halo.geometry.attributes.normal;
    lights.forEach((l, i) => {
      const centre = new THREE.Vector3();
      for (let k = 0; k < 4; k++) {
        // Head cards face forward, tail cards backward: culled when seen from the other side.
        expect(nor.getZ(i * 4 + k)).toBeCloseTo(l.kind === 'head' ? 1 : -1, 6);
        centre.add(new THREE.Vector3().fromBufferAttribute(pos, i * 4 + k).multiplyScalar(0.25));
      }
      expect(centre.distanceTo(new THREE.Vector3(...l.pos))).toBeLessThan(0.05);
      // In front of the lamp, not inside the body.
      expect(Math.abs(centre.z)).toBeGreaterThan(Math.abs(l.pos[2]));
    });
    v.dispose();
  });

  it('follows the tier switch and leaves ghosts without any', () => {
    const scene = new THREE.Scene();
    const v = new CarView(scene, { color: '#e8452c' });
    const halo = halosOf(v)!;
    CAR_FX.halos = false;
    v.applyPose({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
    expect(halo.visible).toBe(false);
    CAR_FX.halos = true;
    v.applyPose({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, 0, 0);
    expect(halo.visible).toBe(true);
    v.dispose();
    expect(scene.children.length).toBe(0);

    const ghost = new CarView(new THREE.Scene(), { color: '#7fd3ff', ghost: true });
    expect(halosOf(ghost)).toBeUndefined();
    ghost.dispose();
  });
});
