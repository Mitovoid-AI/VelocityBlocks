import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY, type Quality } from '../src/render/quality';
import { FOG_FAR, markEnvLit } from '../src/render/sky';
import { buildStadium, TERRAIN_FAR, TREE_NEAR, type Extents } from '../src/render/stadium';
import { grassTexture } from '../src/render/textures';

const B: Extents = { x0: -64, z0: -64, x1: 352, z1: 576 };
const CX = (B.x0 + B.x1) / 2;
const CZ = (B.z0 + B.z1) / 2;

function draws(root: THREE.Object3D): (THREE.Mesh | THREE.Points)[] {
  const out: (THREE.Mesh | THREE.Points)[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Points) out.push(o);
  });
  return out;
}

function treePositions(t: THREE.InstancedMesh): THREE.Vector3[] {
  const m = new THREE.Matrix4();
  return Array.from({ length: t.count }, (_, i) => {
    t.getMatrixAt(i, m);
    return new THREE.Vector3().setFromMatrixPosition(m);
  });
}

describe.each(['low', 'medium', 'high'] as Quality[])('%s stadium', (q) => {
  const p = QUALITY[q];
  const s = buildStadium(B, p);
  const all = draws(s.group);
  const byName = (n: string) => all.find((o) => o.name === n)!;

  it('stays within a dozen draw calls', () => {
    expect(all.length).toBeLessThanOrEqual(12);
  });

  it("plants the tier's trees outside the extents", () => {
    const trees = byName('trees') as THREE.InstancedMesh;
    expect(trees).toBeInstanceOf(THREE.InstancedMesh);
    expect(trees.count).toBe(p.trees);
    for (const v of treePositions(trees)) {
      const inside = v.x > B.x0 - TREE_NEAR && v.x < B.x1 + TREE_NEAR && v.z > B.z0 - TREE_NEAR && v.z < B.z1 + TREE_NEAR;
      expect(inside).toBe(false);
    }
  });

  it('keeps everything but the lawn out of the play area (the camera clamp needs 1.5 m)', () => {
    const v = new THREE.Vector3();
    for (const o of all) {
      if (o.name === 'lawn' || o instanceof THREE.InstancedMesh) continue;
      const pos = o.geometry.attributes.position;
      let inside = 0;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (v.x > B.x0 + 0.6 && v.x < B.x1 - 0.6 && v.z > B.z0 + 0.6 && v.z < B.z1 - 0.6) inside++;
      }
      expect(inside, o.name).toBe(0);
    }
  });

  it('puts the hills inside the fog distance, facing up', () => {
    const t = byName('terrain') as THREE.Mesh;
    const pos = t.geometry.attributes.position;
    const nor = t.geometry.attributes.normal;
    expect(TERRAIN_FAR).toBeLessThan(FOG_FAR);
    let far = 0;
    let down = 0;
    for (let i = 0; i < pos.count; i++) {
      far = Math.max(far, Math.hypot(pos.getX(i) - CX, pos.getZ(i) - CZ));
      if (nor.getY(i) <= 0) down++;
    }
    expect(far).toBeLessThanOrEqual(TERRAIN_FAR + 0.01);
    expect(down).toBe(0);
  });

  it('uses Lambert on the cheap tier only, and halos on every tier', () => {
    const lawn = byName('lawn') as THREE.Mesh;
    expect((lawn.material as THREE.Material).type).toBe(p.cheapGround ? 'MeshLambertMaterial' : 'MeshStandardMaterial');
    expect(lawn.receiveShadow).toBe(true);
    expect(all.some((o) => o instanceof THREE.Points)).toBe(p.halos);
  });

  it('builds without three warnings (Lambert only gets the keys that were set)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      buildStadium(B, p).dispose();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the big stadium surfaces off the environment map', () => {
    markEnvLit(s.group);
    const tagged = all.filter((o) => (o.material as THREE.Material).userData.envLit).map((o) => o.name);
    expect(tagged).toEqual([]);
  });

  it('is deterministic', () => {
    const again = buildStadium(B, p);
    const a = byName('trees') as THREE.InstancedMesh;
    const b = draws(again.group).find((o) => o.name === 'trees') as THREE.InstancedMesh;
    expect(treePositions(b)).toEqual(treePositions(a));
    const ta = (byName('terrain') as THREE.Mesh).geometry.attributes.position.array;
    const tb = (draws(again.group).find((o) => o.name === 'terrain') as THREE.Mesh).geometry.attributes.position.array;
    expect(Array.from(tb)).toEqual(Array.from(ta));
    again.dispose();
  });

  it('disposes its own resources but never the shared textures', () => {
    let gone = false;
    const shared = grassTexture();
    const onDispose = () => (gone = true);
    shared.addEventListener('dispose', onDispose);
    s.dispose();
    shared.removeEventListener('dispose', onDispose);
    expect(gone).toBe(false);
  });
});
