// Geometry helpers behind the car bodies: rounded boxes, lofts, arches, wheels and the per-material merge.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { describe, expect, it } from 'vitest';
import { WHEEL_RADIUS } from '../src/physics/vehicle';
import {
  ARCH_Y,
  RUBBER,
  extrudeX,
  fenderGeometry,
  loftGeometry,
  mergeByMaterial,
  profileGeometry,
  rimGeometry,
  roundedBoxGeometry,
  tubeGeometry,
  tyreGeometry,
  wingGeometry,
} from '../src/render/carParts';

const box = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};

/** Triangles whose winding disagrees with their vertex normals (they would be culled from the wrong side). */
function flippedTriangles(g: THREE.BufferGeometry): number {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const ix = g.index;
  const tri = new THREE.Triangle();
  const fn = new THREE.Vector3();
  const n = new THREE.Vector3();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let bad = 0;
  for (let t = 0; t < (ix ? ix.count : pos.count) / 3; t++) {
    const i = [0, 1, 2].map((k) => (ix ? ix.getX(t * 3 + k) : t * 3 + k));
    tri.set(v[0].fromBufferAttribute(pos, i[0]), v[1].fromBufferAttribute(pos, i[1]), v[2].fromBufferAttribute(pos, i[2]));
    if (tri.getArea() < 1e-8) continue;
    tri.getNormal(fn);
    n.set(0, 0, 0);
    for (const k of i) n.add(v[0].fromBufferAttribute(nor, k));
    if (fn.dot(n) < 0) bad++;
  }
  return bad;
}

/** Height of the first surface straight above (x, y, z) in g, or null. */
function roofAbove(g: THREE.BufferGeometry, x: number, y: number, z: number): number | null {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const hit = new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(0, 1, 0)).intersectObject(m)[0];
  return hit ? hit.point.y : null;
}

describe('roundedBoxGeometry', () => {
  it('is three.js RoundedBoxGeometry, indexed', () => {
    const ours = roundedBoxGeometry(1.2, 0.5, 2, 2, 0.1);
    const ref = new RoundedBoxGeometry(1.2, 0.5, 2, 2, 0.1);
    expect(ours.index).not.toBeNull();
    expect(ours.attributes.position.count).toBe(6 * 6 * 6);
    expect(ref.attributes.position.count).toBeGreaterThan(3 * ours.attributes.position.count);
    // Every vertex of ours is a vertex of three's, with the same normal.
    const key = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) =>
      [a.getX(i), a.getY(i), a.getZ(i)].map((v) => Math.round(v * 1e5)).join();
    const refKeys = new Set<string>();
    for (let i = 0; i < ref.attributes.position.count; i++) {
      refKeys.add(key(ref.attributes.position, i) + '|' + key(ref.attributes.normal, i));
    }
    for (let i = 0; i < ours.attributes.position.count; i++) {
      expect(refKeys.has(key(ours.attributes.position, i) + '|' + key(ours.attributes.normal, i))).toBe(true);
    }
    expect(flippedTriangles(ours)).toBe(0);
  });

  it('keeps its size and clamps the radius to half the smallest side', () => {
    const b = box(roundedBoxGeometry(0.1, 1, 0.6, 2, 0.3));
    expect(b.min.x).toBeCloseTo(-0.05, 6);
    expect(b.max.x).toBeCloseTo(0.05, 6);
    expect(b.max.y).toBeCloseTo(0.5, 6);
    expect(b.max.z).toBeCloseTo(0.3, 6);
  });
});

describe('loftGeometry', () => {
  const secs = [
    { z: -1, hw: 0.5, top: 0.4, bottom: -0.2 },
    { z: 0, hw: 0.8, top: 0.6, bottom: -0.2, n: 2 },
    { z: 1, hw: 0.3, top: 0.2, bottom: -0.1 },
  ];

  it('has a ring per section plus two capped ends, spanning the sections', () => {
    const g = loftGeometry(secs, 16);
    expect(g.attributes.position.count).toBe(3 * 16 + 2 * 17);
    const b = box(g);
    expect(b.min.x).toBeCloseTo(-0.8, 6);
    expect(b.max.x).toBeCloseTo(0.8, 6);
    expect(b.max.y).toBeCloseTo(0.6, 6);
    expect(b.min.y).toBeCloseTo(-0.2, 6);
    expect(b.min.z).toBe(-1);
    expect(b.max.z).toBe(1);
  });

  it('points its normals outwards and winds its faces to match', () => {
    const g = loftGeometry(secs, 16);
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    // The middle ring (z = 0) is an ellipse (n = 2) around y = 0.2.
    for (let k = 16; k < 32; k++) {
      const x = pos.getX(k);
      const y = pos.getY(k) - 0.2;
      expect((x / 0.8) ** 2 + (y / 0.4) ** 2).toBeCloseTo(1, 6);
      expect(nor.getX(k) * x + nor.getY(k) * y).toBeGreaterThan(0);
    }
    // Cap vertices face along z.
    for (let k = 48; k < pos.count; k++) expect(Math.abs(nor.getZ(k))).toBeCloseTo(1, 6);
    expect(flippedTriangles(g)).toBe(0);
  });

  it('accepts sections in any order and off-centre', () => {
    const g = loftGeometry(
      [...secs].reverse().map((s) => ({ ...s, x: 0.5 })),
      12,
    );
    const b = box(g);
    expect(b.min.x).toBeCloseTo(-0.3, 6);
    expect(b.max.x).toBeCloseTo(1.3, 6);
    expect(flippedTriangles(g)).toBe(0);
  });
});

describe('extrusions', () => {
  it('extrudes a side profile across exactly x0..x1, growing the outline by the bevel', () => {
    const s = new THREE.Shape();
    s.moveTo(-1, -0.2);
    s.lineTo(-1, 0.3);
    s.lineTo(2, 0.3);
    s.lineTo(2, -0.2);
    const g = extrudeX(s, 0.4, 1.1, 0.05);
    const b = box(g);
    expect(b.min.x).toBeCloseTo(0.4, 6);
    expect(b.max.x).toBeCloseTo(1.1, 6);
    expect(b.min.z).toBeCloseTo(-1.05, 6);
    expect(b.max.z).toBeCloseTo(2.05, 6);
    expect(b.max.y).toBeCloseTo(0.35, 6);
    expect(g.index).not.toBeNull();
    expect(flippedTriangles(g)).toBe(0);
  });

  it('cuts wheel arches that leave room for the bevel', () => {
    const r = 0.44;
    const bevel = 0.03;
    const g = profileGeometry(
      {
        front: 2.4,
        rear: -2.2,
        foot: -0.4,
        arches: [1.45, -1.35],
        archR: r,
        top: (s) => {
          s.lineTo(2.4, 0.1);
          s.lineTo(-2.2, 0.1);
        },
      },
      0.6,
      1.3,
      bevel,
    );
    for (const zc of [1.45, -1.35]) expect(roofAbove(g, 0.95, ARCH_Y, zc)).toBeCloseTo(ARCH_Y + r - bevel, 3);
    // Between the arches the panel comes down to its foot (less the bevel).
    expect(roofAbove(g, 0.95, -1, 0)).toBeCloseTo(-0.4 - bevel, 3);
    expect(flippedTriangles(g)).toBe(0);
  });

  it('builds fenders as half rings over the wheel', () => {
    const g = fenderGeometry(1.45, 0.46, 0.52, -0.28, 0.76, 1.3, -0.4, 0.02);
    expect(roofAbove(g, 1.0, -0.4, 1.45)).toBeCloseTo(-0.4 + 0.46 - 0.02, 3);
    const b = box(g);
    expect(b.max.y).toBeCloseTo(-0.4 + 0.52 + 0.02, 3);
    expect(b.min.y).toBeCloseTo(-0.28 - 0.02, 3);
    expect(b.min.x).toBeCloseTo(0.76, 6);
    expect(b.max.x).toBeCloseTo(1.3, 6);
    expect(flippedTriangles(g)).toBe(0);
  });

  it('spans a wing across x with its chord along z', () => {
    const b = box(wingGeometry(2, 0.4, 0.05));
    expect(b.min.x).toBeCloseTo(-1, 6);
    expect(b.max.x).toBeCloseTo(1, 6);
    expect(b.max.z - b.min.z).toBeGreaterThan(0.4);
    expect(b.max.z - b.min.z).toBeLessThan(0.43);
    expect(b.max.y - b.min.y).toBeLessThan(0.08);
  });

  it('runs a tube through its end points', () => {
    const b = box(
      tubeGeometry(
        [
          [0, 0, 0],
          [1, 1, 0],
          [2, 0, 0],
        ],
        0.05,
      ),
    );
    expect(b.min.x).toBeCloseTo(0, 1);
    expect(b.max.x).toBeCloseTo(2, 1);
    expect(b.max.y).toBeGreaterThan(1);
  });
});

describe('wheels', () => {
  it('makes tyres of exactly the physics radius and width', () => {
    for (const w of [0.42, 0.52]) {
      const g = tyreGeometry(w);
      const b = box(g);
      expect(b.max.y).toBeCloseTo(WHEEL_RADIUS, 6);
      expect(b.max.z).toBeCloseTo(WHEEL_RADIUS, 6);
      expect(b.min.z).toBeCloseTo(-WHEEL_RADIUS, 6);
      expect(b.max.x - b.min.x).toBeCloseTo(w, 6);
      expect(g.attributes.color).toBeUndefined();
      expect(flippedTriangles(g)).toBe(0);
    }
  });

  it('paints a sidewall band only when asked', () => {
    const g = tyreGeometry(0.42, WHEEL_RADIUS, 0xffd21f);
    const col = g.attributes.color;
    const rubber = new THREE.Color(RUBBER);
    const band = new THREE.Color(0xffd21f);
    let nBand = 0;
    let nRubber = 0;
    for (let i = 0; i < col.count; i++) {
      if (Math.abs(col.getX(i) - band.r) < 1e-6 && Math.abs(col.getZ(i) - band.b) < 1e-6) {
        nBand++;
        // On the outboard sidewall.
        expect(g.attributes.position.getX(i)).toBeCloseTo(0.21, 6);
      } else if (Math.abs(col.getX(i) - rubber.r) < 1e-6) nRubber++;
    }
    expect(nBand).toBeGreaterThan(0);
    expect(nBand + nRubber).toBe(col.count);
  });

  it('keeps the rim inside the tyre with its spokes on the outboard side', () => {
    for (const w of [0.42, 0.52]) {
      const g = rimGeometry(w);
      const b = box(g);
      expect(b.min.x).toBeGreaterThanOrEqual(-w / 2);
      expect(b.max.x).toBeLessThanOrEqual(w / 2);
      expect(b.max.y).toBeLessThan(WHEEL_RADIUS * 0.7);
      // Spokes and hub sit near the outboard (+x) face, not the inboard one.
      const pos = g.attributes.position;
      let sx = 0;
      for (let i = 0; i < pos.count; i++) sx += pos.getX(i);
      expect(sx / pos.count).toBeGreaterThan(w / 8);
      expect(flippedTriangles(g)).toBe(0);
    }
  });
});

describe('mergeByMaterial', () => {
  it('merges per material in first-appearance order, keeping positions and mirrored faces', () => {
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    const g = new THREE.Group();
    const m1 = new THREE.Mesh(roundedBoxGeometry(1, 1, 1, 1, 0.1), a);
    m1.position.set(2, 0, 0);
    const m2 = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), b);
    m2.position.set(0, 1, 0);
    // Mirrored: a negative scale flips the winding, which the merge must undo.
    const m3 = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8).translate(0.3, 0, 0), a);
    m3.scale.set(-1, 1, 1);
    const kept = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), b));
    g.add(m1, m2, m3, kept);
    g.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(g);
    mergeByMaterial(g);
    expect(g.children[0]).toBe(kept);
    const merged = g.children.slice(1) as THREE.Mesh[];
    expect(merged.map((m) => m.material)).toEqual([a, b]);
    g.updateMatrixWorld(true);
    const after = new THREE.Box3().setFromObject(g);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(after.min[k]).toBeCloseTo(before.min[k], 6);
      expect(after.max[k]).toBeCloseTo(before.max[k], 6);
    }
    for (const m of merged) expect(flippedTriangles(m.geometry)).toBe(0);
    // The mirrored cone lands on the -x side.
    expect(box(merged[0].geometry).min.x).toBeCloseTo(-0.8, 6);
  });
});
