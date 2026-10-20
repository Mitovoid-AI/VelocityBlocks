import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAR_BODIES, CAR_ICON_WHEELS, DEFAULT_CAR_BODY, isCarBody, VEHICLE_INFO, VEHICLE_NOTE, vehicleInfo, type CarBody } from '../src/core/cars';
import { VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { WHEEL_ANCHORS, WHEEL_RADIUS } from '../src/physics/vehicle';
import { AVATAR_BOB_AMP, AVATAR_LIFT, AVATAR_SIZE } from '../src/render/avatar';
import { buildCar, type CarVisual } from '../src/render/carMesh';
import { RAY } from '../src/render/carView';

const r = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

// Record format of tests/fixtures/racer-meshes.json: traversal order, world boxes, material
// sharing and flags. Regenerate with `npx vitest run tests/carBodies.test.ts -u` and review the diff.
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

/** Body shell meshes only: no wheels (under pivots) and no flames. */
function shellMeshes(v: CarVisual): THREE.Mesh[] {
  const skip = new Set<THREE.Object3D>(v.flames);
  const out: THREE.Mesh[] = [];
  v.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || skip.has(o)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (v.pivots.includes(p)) return;
    out.push(o);
  });
  return out;
}

/** World box of the body shell only. */
function shellBox(v: CarVisual): THREE.Box3 {
  v.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of shellMeshes(v)) box.union(new THREE.Box3().setFromObject(m));
  return box;
}

function meshes(v: CarVisual): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  v.root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

const IDS: CarBody[] = ['racer', 'buggy', 'muscle', 'formula'];
/** Open-wheel bodies have no headlamps. */
const OPEN_WHEEL: CarBody[] = ['formula'];
/** Per car on a phone: draw calls (before the shadow pass) and vertices. */
const MESH_BUDGET = 20;
const VERTEX_BUDGET = 20000;
/** Settled, hard cornering, and a hard landing (about the 99th percentile over the campaign). */
const COMPS = [0.094, 0.2, 0.35];

describe('car body list', () => {
  it('has unique ids in picker order', () => {
    expect(CAR_BODIES.map((b) => b.id)).toEqual(IDS);
    expect(new Set(CAR_BODIES.map((b) => b.id)).size).toBe(CAR_BODIES.length);
    expect(isCarBody(DEFAULT_CAR_BODY)).toBe(true);
    expect(isCarBody('formula')).toBe(true);
  });

  it('rejects unknown ids', () => {
    expect(isCarBody('tank')).toBe(false);
    expect(isCarBody(undefined)).toBe(false);
    expect(isCarBody(3)).toBe(false);
  });

  it('draws every picker icon inside its 64x24 box with plain path commands', () => {
    for (const b of CAR_BODIES) {
      expect(b.icon, b.id).toMatch(/^M[\d. LZ]+$/);
      const nums = b.icon.match(/[\d.]+/g)!.map(Number);
      expect(nums.length % 2, b.id).toBe(0);
      nums.forEach((n, i) => expect(n, b.id).toBeLessThanOrEqual(i % 2 ? 24 : 64));
    }
  });
});

describe('vehicle picker', () => {
  it('lists every class once, in class order', () => {
    expect(VEHICLE_INFO.map((v) => v.id)).toEqual(VEHICLE_CLASSES);
    for (const v of VEHICLE_INFO) {
      expect(vehicleInfo(v.id)).toBe(v);
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.blurb.length).toBeGreaterThan(0);
    }
    expect(vehicleInfo('tank' as VehicleClass).id).toBe('car');
    expect(VEHICLE_INFO[0].icon).toBe(CAR_BODIES[0].icon);
    expect(VEHICLE_INFO[0].wheels).toBe(CAR_ICON_WHEELS);
    expect(VEHICLE_NOTE.length).toBeGreaterThan(0);
  });

  it('draws every class icon and its wheels inside the 64x24 box with plain path commands', () => {
    for (const v of VEHICLE_INFO) {
      expect(v.icon, v.id).toMatch(/^M[\d. LZM]+$/);
      const nums = v.icon.match(/[\d.]+/g)!.map(Number);
      expect(nums.length % 2, v.id).toBe(0);
      nums.forEach((n, i) => expect(n, v.id).toBeLessThanOrEqual(i % 2 ? 24 : 64));
      expect(v.wheels.length).toBe(2);
      for (const [cx, cy, r] of v.wheels) {
        expect(cx - r).toBeGreaterThanOrEqual(0);
        expect(cx + r).toBeLessThanOrEqual(64);
        expect(cy + r).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('racer identity', () => {
  it('matches the reviewed racer snapshot', async () => {
    const text = JSON.stringify(
      { normal: snapshot(buildCar('#e8452c', false, 'racer')), ghost: snapshot(buildCar('#7fd3ff', true, 'racer')) },
      null,
      1,
    );
    await expect(text + '\n').toMatchFileSnapshot('./fixtures/racer-meshes.json');
  });

  it('defaults to the racer, also for a stale body id', () => {
    const racer = snapshot(buildCar('#e8452c', false, 'racer'));
    expect(snapshot(buildCar())).toEqual(racer);
    const stale = buildCar('#e8452c', false, 'tank' as CarBody);
    expect(stale.body).toBe('racer');
    expect(snapshot(stale)).toEqual(racer);
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

    it(`fits the phone budget, one shell mesh per material (ghost ${ghost})`, () => {
      const v = buildCar('#e8452c', ghost, id);
      const all = meshes(v);
      expect(all.length).toBeLessThanOrEqual(MESH_BUDGET);
      expect(all.reduce((n, m) => n + m.geometry.attributes.position.count, 0)).toBeLessThanOrEqual(VERTEX_BUDGET);
      const shellMats = shellMeshes(v).map((m) => m.material);
      expect(new Set(shellMats).size).toBe(shellMats.length);
    });
  }

  it('has clean geometry: finite positions, unit normals, faces wound the way their normals point', () => {
    for (const m of meshes(buildCar('#e8452c', false, id))) {
      const g = m.geometry;
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      expect(nor, g.type).toBeDefined();
      expect(Array.from(pos.array as Float32Array).every(Number.isFinite)).toBe(true);
      for (let i = 0; i < nor.count; i++) {
        expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 3);
      }
      // A triangle wound against its normals is culled from the side it should be seen from.
      const ix = g.index;
      const tris = (ix ? ix.count : pos.count) / 3;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const n = new THREE.Vector3();
      const face = new THREE.Triangle();
      const fn = new THREE.Vector3();
      let flipped = 0;
      for (let t = 0; t < tris; t++) {
        const [i0, i1, i2] = [0, 1, 2].map((k) => (ix ? ix.getX(t * 3 + k) : t * 3 + k));
        face.set(a.fromBufferAttribute(pos, i0), b.fromBufferAttribute(pos, i1), c.fromBufferAttribute(pos, i2));
        if (face.getArea() < 1e-7) continue;
        face.getNormal(fn);
        n.fromBufferAttribute(nor, i0).add(c.fromBufferAttribute(nor, i1)).add(c.fromBufferAttribute(nor, i2));
        if (fn.dot(n) < 0) flipped++;
      }
      expect(flipped, `${g.type} with ${tris} triangles`).toBe(0);
    }
  });

  it('rolls on round tyres of the physics radius, with the rims inside them', () => {
    const v = buildCar('#e8452c', false, id);
    v.wheels.forEach((w, i) => {
      const [tyre, rim] = w.children as THREE.Mesh[];
      tyre.geometry.computeBoundingBox();
      rim.geometry.computeBoundingBox();
      const t = tyre.geometry.boundingBox!;
      const rb = rim.geometry.boundingBox!;
      for (const k of ['y', 'z'] as const) {
        expect(t.max[k]).toBeCloseTo(WHEEL_RADIUS, 6);
        expect(t.min[k]).toBeCloseTo(-WHEEL_RADIUS, 6);
      }
      expect(t.max.x - t.min.x).toBeCloseTo(i < 2 ? 0.42 : 0.52, 6);
      expect(rb.min.x).toBeGreaterThanOrEqual(t.min.x);
      expect(rb.max.x).toBeLessThanOrEqual(t.max.x);
      // Outboard faces out: the right wheels are mirrored.
      expect(w.scale.x).toBe(WHEEL_ANCHORS[i].x < 0 ? -1 : 1);
    });
  });

  it('keeps the tyres from poking up through the bodywork as the springs compress', () => {
    const v = buildCar('#e8452c', false, id);
    v.root.updateMatrixWorld(true);
    const shell = shellMeshes(v);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    WHEEL_ANCHORS.forEach((a, i) => {
      const w = i < 2 ? 0.42 : 0.52;
      for (const comp of COMPS) {
        // CarView's wheel centre for this compression.
        const cy = -0.15 - (RAY - comp) + WHEEL_RADIUS;
        for (const f of [-0.35, 0, 0.35]) {
          const x = a.x * 1.08 + f * w;
          ray.set(new THREE.Vector3(x, 5, a.z), down);
          const hit = ray.intersectObjects(shell, false)[0];
          if (!hit) continue;
          // The top surface over the wheel is either above the tyre or well clear below it.
          const y = hit.point.y;
          const clear = y > cy + WHEEL_RADIUS || y < cy - WHEEL_RADIUS + 0.05;
          expect(clear, `wheel ${i} comp ${comp} x ${x.toFixed(2)} hit ${y.toFixed(3)}`).toBe(true);
        }
      }
    });
  });

  it('lists its lamps where they are drawn (none on a ghost)', () => {
    const v = buildCar('#e8452c', false, id);
    const heads = v.lights.filter((l) => l.kind === 'head');
    const tails = v.lights.filter((l) => l.kind === 'tail');
    expect(heads.length).toBe(OPEN_WHEEL.includes(id) ? 0 : 2);
    expect(tails.length).toBeGreaterThanOrEqual(1);
    v.root.updateMatrixWorld(true);
    const lampBox = (emissive: number) => {
      const box = new THREE.Box3();
      for (const m of meshes(v)) {
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.emissive?.getHex() === emissive) box.union(new THREE.Box3().setFromObject(m));
      }
      return box;
    };
    const headBox = lampBox(0xfff2c0);
    const tailBox = lampBox(0xff1010);
    for (const l of v.lights) {
      const p = new THREE.Vector3(...l.pos);
      expect((l.kind === 'head' ? headBox : tailBox).distanceToPoint(p), `${l.kind} at ${l.pos}`).toBeLessThan(0.05);
      // Heads at the front facing forward, tails at the back.
      expect(Math.sign(p.z)).toBe(l.kind === 'head' ? 1 : -1);
      expect(l.size).toBeGreaterThan(0);
    }
    expect(buildCar('#7fd3ff', true, id).lights).toEqual([]);
  });

  it('puts no light or flame materials on a ghost', () => {
    const v = buildCar('#7fd3ff', true, id);
    v.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      expect(m.type).toBe('MeshStandardMaterial');
      expect(m.emissive.getHex()).toBe(0);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(o.castShadow).toBe(false);
    });
  });

  it('repaints the shared paint and disposes cleanly, without touching another car', () => {
    const v = buildCar('#e8452c', false, id);
    const other = buildCar('#e8452c', false, id);
    const paints = new Set<THREE.MeshStandardMaterial>();
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.MeshStandardMaterial).color.getHexString() === 'e8452c') {
        paints.add(o.material as THREE.MeshStandardMaterial);
      }
    });
    expect(paints.size).toBe(1);
    v.setColor('#00ff00');
    expect([...paints][0].color.getHexString()).toBe('00ff00');
    // Geometry comes from a per-body template but every car owns its copy.
    const mine = new Set(meshes(v).map((m) => m.geometry));
    expect(meshes(other).some((m) => mine.has(m.geometry))).toBe(false);
    expect(() => v.dispose()).not.toThrow();
  });
});
