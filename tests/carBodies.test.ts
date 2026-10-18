import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAR_BODIES, DEFAULT_CAR_BODY, isCarBody, type CarBody } from '../src/core/cars';
import { WHEEL_ANCHORS } from '../src/physics/vehicle';
import { AVATAR_BOB_AMP, AVATAR_LIFT, AVATAR_SIZE } from '../src/render/avatar';
import { buildCar, type CarVisual } from '../src/render/carMesh';

const r = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

// Same record format as the generator that wrote tests/fixtures/racer-meshes.json from the
// pre-refactor carMesh.ts: traversal order, world boxes, material sharing and flags.
function snapshot(v: CarVisual) {
  v.root.updateMatrixWorld(true);
  const mats: THREE.Material[] = [];
  const out: unknown[] = [];
  v.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = o.material as THREE.Material;
    if (!mats.includes(m)) mats.push(m);
    const b = new THREE.Box3().setFromObject(o);
    out.push({
      geometry: o.geometry.type,
      vertices: o.geometry.attributes.position.count,
      min: [r(b.min.x), r(b.min.y), r(b.min.z)],
      max: [r(b.max.x), r(b.max.y), r(b.max.z)],
      material: mats.indexOf(m),
      mat: { type: m.type, transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite },
      castShadow: o.castShadow,
    });
  });
  return out;
}

/** World box of the body shell only: no wheels (under pivots) and no flames. */
function shellBox(v: CarVisual): THREE.Box3 {
  v.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const skip = new Set<THREE.Object3D>(v.flames);
  v.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || skip.has(o)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (v.pivots.includes(p)) return;
    box.union(new THREE.Box3().setFromObject(o));
  });
  return box;
}

const IDS: CarBody[] = ['racer', 'buggy', 'muscle'];

describe('car body list', () => {
  it('has unique ids in picker order', () => {
    expect(CAR_BODIES.map((b) => b.id)).toEqual(IDS);
    expect(new Set(CAR_BODIES.map((b) => b.id)).size).toBe(CAR_BODIES.length);
    expect(isCarBody(DEFAULT_CAR_BODY)).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(isCarBody('tank')).toBe(false);
    expect(isCarBody(undefined)).toBe(false);
    expect(isCarBody(3)).toBe(false);
  });
});

describe('racer identity', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/racer-meshes.json', 'utf8'));

  it('matches the pre-refactor racer exactly', () => {
    expect(snapshot(buildCar('#e8452c', false, 'racer'))).toEqual(fixture.normal);
    expect(snapshot(buildCar('#7fd3ff', true, 'racer'))).toEqual(fixture.ghost);
  });

  it('defaults to the racer, also for a stale body id', () => {
    expect(snapshot(buildCar())).toEqual(fixture.normal);
    const stale = buildCar('#e8452c', false, 'tank' as CarBody);
    expect(stale.body).toBe('racer');
    expect(snapshot(stale)).toEqual(fixture.normal);
  });
});

describe.each(IDS)('%s body', (id) => {
  const clearance = AVATAR_LIFT - AVATAR_SIZE / 2 - AVATAR_BOB_AMP - 0.1;

  for (const ghost of [false, true]) {
    it(`shares wheels, pivots and flames (ghost ${ghost})`, () => {
      const v = buildCar('#e8452c', ghost, id);
      expect(v.body).toBe(id);
      expect(v.wheels.length).toBe(4);
      expect(v.pivots.length).toBe(4);
      v.pivots.forEach((p, i) => {
        expect(p.position.x).toBeCloseTo(WHEEL_ANCHORS[i].x * 1.08, 9);
        expect(p.position.y).toBe(0);
        expect(p.position.z).toBeCloseTo(WHEEL_ANCHORS[i].z, 9);
        expect(v.wheels[i].parent).toBe(p);
      });
      expect(v.flames.length).toBe(ghost ? 0 : 2);
      v.flames.forEach((f) => expect(f.visible).toBe(false));
    });

    it(`stays inside the envelope and under the badge (ghost ${ghost})`, () => {
      const b = shellBox(buildCar('#e8452c', ghost, id));
      expect(b.min.x).toBeGreaterThanOrEqual(-1.34);
      expect(b.max.x).toBeLessThanOrEqual(1.34);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.45);
      expect(b.max.y).toBeLessThanOrEqual(0.95);
      expect(b.min.z).toBeGreaterThanOrEqual(-2.4);
      expect(b.max.z).toBeLessThanOrEqual(2.6);
      expect(b.max.y).toBeLessThanOrEqual(clearance);
    });
  }

  it('puts no light or flame materials on a ghost', () => {
    const v = buildCar('#7fd3ff', true, id);
    v.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      expect(m.type).toBe('MeshStandardMaterial');
      expect(m.emissive.getHex()).toBe(0);
    });
  });

  it('repaints the shared paint and disposes cleanly', () => {
    const v = buildCar('#e8452c', false, id);
    const paints = new Set<THREE.MeshStandardMaterial>();
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.MeshStandardMaterial).color.getHexString() === 'e8452c') {
        paints.add(o.material as THREE.MeshStandardMaterial);
      }
    });
    expect(paints.size).toBe(1);
    v.setColor('#00ff00');
    expect([...paints][0].color.getHexString()).toBe('00ff00');
    expect(() => v.dispose()).not.toThrow();
  });
});
