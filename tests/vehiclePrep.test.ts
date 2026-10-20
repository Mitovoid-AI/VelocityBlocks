// The pure prep steps of scripts/build-vehicles.ts (scripts/vehiclePrep.ts): the canonical frame, wheel
// ordering, the bike's wheel split, baking geometry, pruning, material extensions and the paint whitening.

import { describe, expect, it } from 'vitest';
import {
  apply,
  bakeGroups,
  canonicalMatrix,
  decodePng,
  encodePng,
  findBikeWheels,
  orderWheels,
  pairAxles,
  pruneUnused,
  readAccessor,
  splitWheels,
  stripMaterialExtensions,
  whitenPaint,
  type Gltf,
  type M4,
} from '../scripts/vehiclePrep';

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe('canonical frame', () => {
  it('turns the given forward into +z, keeps up, puts the driver\'s left at +x and the origin at 0', () => {
    // A vehicle facing +x in its file (the truck and the bike): left is -z there.
    const m = canonicalMatrix([1, 0], [2, 0.5, 3]);
    close(apply(m, [2, 0.5, 3]), [0, 0, 0]);
    close(apply(m, [3, 0.5, 3]), [0, 0, 1]);
    close(apply(m, [2, 1.5, 3]), [0, 1, 0]);
    close(apply(m, [2, 0.5, 2]), [1, 0, 0]);
    // Any yaw: forward along (0.6, -0.8).
    const r = canonicalMatrix([0.6, -0.8], [0, 0, 0]);
    close(apply(r, [0.6, 0, -0.8]), [0, 0, 1]);
  });

  it('pairs wheels into axles and orders them FL, FR, RL, RR from a point near the front', () => {
    // A car facing -z (wheelbase 2.6, track 1.6) in shuffled order.
    const c: [number, number][] = [
      [0.8, 1.3],
      [-0.8, -1.3],
      [0.8, -1.3],
      [-0.8, 1.3],
    ];
    expect(pairAxles(c).axles).toEqual([
      [0, 3],
      [1, 2],
    ]);
    const { order, forward } = orderWheels(c, [0, -5]);
    close(forward, [0, -2.6]);
    // Facing -z, the driver's left is -x.
    expect(order).toEqual([1, 2, 3, 0]);
  });
});

/** Flattened xyz of a tyre (a ring of points about x) at (0, r, z), plus a frame bar above it. */
function bikePoints(): Float64Array {
  const pts: number[] = [];
  for (const [z, r] of [
    [0.7, 0.33],
    [-0.7, 0.33],
  ]) {
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      for (const x of [-0.06, 0, 0.06]) pts.push(x, r + Math.sin(a) * r, z + Math.cos(a) * r);
    }
  }
  pts.push(0, 0.9, -0.9, 0, 0.9, 0.9, 0.2, 0.5, 0.7);
  return Float64Array.from(pts);
}

describe('bike wheels', () => {
  it('finds both tyres from the ground contacts and splits only whole triangles inside them', () => {
    const pos = bikePoints();
    const [f, r] = findBikeWheels(pos);
    expect(f.centre[2]).toBeCloseTo(0.7, 2);
    expect(r.centre[2]).toBeCloseTo(-0.7, 2);
    expect(f.r).toBeCloseTo(0.33, 2);
    expect(f.halfW).toBeCloseTo(0.06, 2);
    const n = pos.length / 3;
    // Triangle 1: three tyre points (front); 2: two front tyre points and the frame; 3: rear tyre.
    const idx = Uint32Array.from([0, 1, 2, 0, 1, n - 3, 192, 193, 194]);
    const s = splitWheels(pos, idx, [f, r]);
    expect(s.wheels[0]).toEqual([0, 1, 2]);
    expect(s.wheels[1]).toEqual([192, 193, 194]);
    expect(s.body).toEqual([0, 1, n - 3]);
  });
});

/** A tiny glTF: one triangle, with normals, on buffer 0. */
function triangle(): { g: Gltf; bins: Buffer[] } {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nor = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2, 0]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(nor.buffer), Buffer.from(idx.buffer)]);
  const g: Gltf = {
    asset: { version: '2.0' },
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_1: 0 }, indices: 2, material: 1 }] }],
    materials: [{ name: 'unused' }, { name: 'used' }],
  };
  return { g, bins: [bin] };
}

describe('baking', () => {
  it('bakes positions and normals by the matrix, merges unnamed groups by material and keeps named ones apart', () => {
    const { g, bins } = triangle();
    const prim = g.meshes![0].primitives[0];
    const move: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const out = bakeGroups(g, bins, [{ prims: [{ prim, matrix: move }] }, { prims: [{ prim, matrix: move }] }, { name: 'vb_wheel_f', prims: [{ prim, matrix: move }] }]);
    expect(out.nodes.map((n) => n.name)).toEqual([undefined, 'vb_wheel_f']);
    expect(out.meshes[0].primitives).toHaveLength(1);
    const p = out.meshes[0].primitives[0];
    // The unused UV set is dropped.
    expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL', 'POSITION']);
    const baked: Gltf = { asset: { version: '2.0' }, accessors: out.accessors, bufferViews: out.bufferViews };
    const pos = readAccessor(baked, [out.data], p.attributes.POSITION);
    expect(Array.from(pos)).toEqual([5, 0, 0, 6, 0, 0, 5, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0]);
    expect(Array.from(readAccessor(baked, [out.data], p.indices!))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.accessors[p.attributes.POSITION].min).toEqual([5, 0, 0]);
  });

  it('flips the winding and keeps normals outward under a mirroring matrix', () => {
    const { g, bins } = triangle();
    const prim = g.meshes![0].primitives[0];
    const mirror: M4 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const out = bakeGroups(g, bins, [{ prims: [{ prim, matrix: mirror }] }]);
    const p = out.meshes[0].primitives[0];
    const baked: Gltf = { asset: { version: '2.0' }, accessors: out.accessors, bufferViews: out.bufferViews };
    expect(Array.from(readAccessor(baked, [out.data], p.indices!))).toEqual([0, 2, 1]);
    close(Array.from(readAccessor(baked, [out.data], p.attributes.NORMAL)).slice(0, 3), [0, 0, 1]);
  });

  it('prunes what no node uses and strips material extensions but emissive strength', () => {
    const { g } = triangle();
    g.nodes = [{ mesh: 0 }];
    g.scenes = [{ nodes: [0] }];
    g.materials![1].extensions = { KHR_materials_clearcoat: {}, KHR_materials_transmission: {}, KHR_materials_emissive_strength: { emissiveStrength: 2 } };
    g.extensionsUsed = ['KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_emissive_strength'];
    g.extensionsRequired = ['KHR_materials_transmission'];
    pruneUnused(g);
    stripMaterialExtensions(g);
    expect(g.materials!.map((m) => m.name)).toEqual(['used']);
    expect(g.meshes![0].primitives[0].material).toBe(0);
    expect(Object.keys(g.materials![0].extensions!)).toEqual(['KHR_materials_emissive_strength']);
    expect(g.extensionsUsed).toEqual(['KHR_materials_emissive_strength']);
    expect(g.extensionsRequired).toBeUndefined();
  });
});

describe('paint whitening', () => {
  it('round-trips a PNG and turns baked paint into a tintable grey, keeping trim and shading', () => {
    // Bright red paint, the same paint in shadow, black trim, a grey grille.
    const data = Uint8Array.from([200, 10, 10, 100, 5, 5, 8, 8, 8, 120, 120, 120]);
    const img = decodePng(encodePng({ width: 4, height: 1, channels: 3, data }));
    expect(Array.from(img.data)).toEqual(Array.from(data));
    const w = whitenPaint(img).data;
    // Every pixel is grey.
    for (let i = 0; i < w.length; i += 3) expect(w[i]).toBe(w[i + 1]);
    // The paint is near white, its shadow half as bright; trim and grille keep their brightness.
    expect(w[0]).toBeGreaterThan(220);
    expect(w[3] / w[0]).toBeCloseTo(0.5, 1);
    expect(w[6]).toBe(8);
    expect(w[9]).toBe(120);
  });
});
