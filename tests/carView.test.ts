// CarView pieces that are not the car mesh itself: the suspension ray it shares with the physics,
// the contact shadow (on the ground, also in replays and jumps) and the environment tagging.

import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createCar } from '../src/physics/vehicle';
import { CAR_FX, CarView, RAY } from '../src/render/carView';
import { DECK_LIFT } from '../src/render/trackMesh';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

const track = new Track(campaign()[0].data);

const blobOf = (scene: THREE.Scene) => scene.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;

describe('CarView', () => {
  afterEach(() => {
    CAR_FX.ground = null;
  });

  it('uses the suspension ray of the physics (wheels touch the road at rest)', () => {
    const c = createCar(track);
    const y = track.spawn().y;
    for (let i = 0; i < 4; i++) expect(c.pos.y - 0.15 - (RAY - c.comp[i])).toBeCloseTo(y, 6);
  });

  it('lays the contact shadow on the road and fades it out in the air', () => {
    CAR_FX.ground = (x, y, z) => track.surfaceAt(x, y, z, 0.2);
    const scene = new THREE.Scene();
    const v = new CarView(scene, { color: '#e8452c' });
    const blob = blobOf(scene)!;
    expect(blob).toBeDefined();
    const c = createCar(track);
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    const mat = blob.material as THREE.MeshBasicMaterial;
    expect(blob.visible).toBe(true);
    expect(blob.position.y).toBeCloseTo(track.spawn().y + DECK_LIFT + 0.015, 6);
    expect(mat.opacity).toBeCloseTo(CAR_FX.contactOpacity, 2);

    // Replays pose the car without wheel data: a jump must not leave the shadow hanging in mid-air.
    v.applyPose({ ...c.pos, y: c.pos.y + 0.75 }, c.rot, 0, 0);
    expect(blob.visible).toBe(true);
    expect(blob.position.y).toBeCloseTo(track.spawn().y + DECK_LIFT + 0.015, 6);
    expect(mat.opacity).toBeLessThan(CAR_FX.contactOpacity * 0.7);
    v.applyPose({ ...c.pos, y: c.pos.y + 3 }, c.rot, 0, 0);
    expect(blob.visible).toBe(false);

    v.applyPose(c.pos, c.rot, 0, 0);
    expect(blob.visible).toBe(true);
    v.setVisible(false);
    expect(blob.visible).toBe(false);
    v.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('gives ghosts no contact shadow', () => {
    const scene = new THREE.Scene();
    const v = new CarView(scene, { color: '#7fd3ff', ghost: true });
    expect(scene.children).toEqual([v.visual.root]);
    v.dispose();
  });

  it('tags the metallic car materials for the environment map', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c' });
    const tagged = new Set<THREE.Material>();
    v.visual.root.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.Material).userData.envLit) tagged.add(o.material);
    });
    expect(tagged.size).toBeGreaterThanOrEqual(3);
    v.dispose();
  });
});
