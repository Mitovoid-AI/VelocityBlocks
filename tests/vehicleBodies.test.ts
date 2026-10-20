// The Bike and Truck meshes: built from their class's physics geometry (wheels on its rays), inside the
// phone budget, clean, with tyres that never poke through the bodywork, the bike's rider and linkages,
// and the truck's body roll. Each is also built for a retuned geometry, so a later spec change keeps
// all of this true.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { maxSteerAngle, vehicleSpec, type VehicleSpec } from '../src/physics/vehicle';
import { AVATAR_BOB_AMP, AVATAR_LIFT, AVATAR_SIZE, avatarLift } from '../src/render/avatar';
import { BIKE_FRONT_Z, BIKE_LEAN_MAX, buildBike } from '../src/render/bikeMesh';
import type { CarVisual } from '../src/render/carMesh';
import { buildTruck, TRUCK_ROLL_MAX } from '../src/render/truckMesh';
import { buildVehicle } from '../src/render/vehicleMesh';

const MESH_BUDGET = 20;
const VERTEX_BUDGET = 20000;

const BIKE = vehicleSpec('bike');
const TRUCK = vehicleSpec('truck');
const CAR = vehicleSpec('car');

/** The same class with its geometry scaled (a retune): anchors, wheel radius, ray and ride height. */
function retuned(S: VehicleSpec, k: number): VehicleSpec {
  return {
    ...S,
    wheels: S.wheels.map((w) => ({ x: w.x * k, y: w.y, z: w.z * k })),
    wheelRadius: S.wheelRadius * k,
    ray: S.ray * k,
    rideHeight: S.rideHeight * k + 0.02,
  };
}

type Build = (color: string, ghost: boolean) => CarVisual;
interface Case {
  name: string;
  spec: VehicleSpec;
  build: Build;
  wheels: number;
  flames: number;
  heads: number;
  tails: number;
  /** Checked for tyres inside the bodywork (the stand-in on the car's narrow geometry is not a shipped vehicle). */
  bodywork?: false;
}

const CASES: Case[] = [
  { name: 'bike', spec: BIKE, build: (c, g) => buildBike(c, g), wheels: 2, flames: 1, heads: 2, tails: 1 },
  { name: 'bike (retuned)', spec: retuned(BIKE, 1.1), build: (c, g) => buildBike(c, g, retuned(BIKE, 1.1)), wheels: 2, flames: 1, heads: 2, tails: 1 },
  { name: 'truck', spec: TRUCK, build: (c, g) => buildTruck(c, g), wheels: 4, flames: 2, heads: 2, tails: 2 },
  { name: 'truck (retuned)', spec: retuned(TRUCK, 0.9), build: (c, g) => buildTruck(c, g, retuned(TRUCK, 0.9)), wheels: 4, flames: 2, heads: 2, tails: 2 },
  {
    // A truck on the car's geometry (what the Truck had before its own spec).
    name: 'truck (car geometry)',
    spec: { ...TRUCK, wheels: CAR.wheels, wheelRadius: CAR.wheelRadius, ray: CAR.ray, rideHeight: CAR.rideHeight },
    build: (c, g) => buildTruck(c, g, { ...TRUCK, wheels: CAR.wheels, wheelRadius: CAR.wheelRadius, ray: CAR.ray, rideHeight: CAR.rideHeight }),
    wheels: 4,
    flames: 2,
    heads: 2,
    tails: 2,
    bodywork: false,
  },
];

function meshes(v: CarVisual): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  v.root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

/** Everything but the drawn wheels (tyre and rim) and the flames: body, rider, fork, mudguards. */
function bodyMeshes(v: CarVisual): THREE.Mesh[] {
  const skip = new Set<THREE.Object3D>(v.flames);
  return meshes(v).filter((m) => {
    if (skip.has(m)) return false;
    for (let p: THREE.Object3D | null = m; p; p = p.parent) if (v.wheels.includes(p)) return false;
    return true;
  });
}

function boxOf(ms: readonly THREE.Mesh[], root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3();
  for (const m of ms) b.union(new THREE.Box3().setFromObject(m));
  return b;
}

/** Pose the drawn wheels as CarView does for one compression on every ray. */
function poseWheels(v: CarVisual, S: VehicleSpec, comp: number): void {
  v.wheels.forEach((w, i) => {
    w.parent!.position.y = S.wheels[v.wheelSrc[i][0]].y - (S.ray - comp) + S.wheelRadius;
  });
  v.update?.();
  v.root.updateMatrixWorld(true);
}

const settledComp = (S: VehicleSpec) => S.ray - S.wheels[0].y - S.rideHeight;

describe.each(CASES)('$name', (c) => {
  const S = c.spec;

  for (const ghost of [false, true]) {
    it(`draws ${c.wheels} wheels on the physics rays, every ray used once (ghost ${ghost})`, () => {
      const v = c.build('#e8452c', ghost);
      expect(v.wheels.length).toBe(c.wheels);
      expect(v.pivots.length).toBe(c.wheels);
      v.wheels.forEach((w, i) => expect(w.parent).toBe(v.pivots[i]));
      expect(v.wheelSrc.flat().sort()).toEqual([0, 1, 2, 3]);
      // Front wheels steer, rear ones do not.
      v.wheelSrc.forEach((src, i) => expect(v.steered[i]).toBe(src[0] < 2));
      expect(v.flames.length).toBe(ghost ? 0 : c.flames);
      v.flames.forEach((f) => expect(f.visible).toBe(false));
      expect(v.steerScale).toBeGreaterThan(0.3);
      expect(v.steerScale).toBeLessThanOrEqual(1);
    });

    it(`fits the phone budget, one mesh per material in each group (ghost ${ghost})`, () => {
      const v = c.build('#e8452c', ghost);
      const all = meshes(v);
      expect(all.length).toBeLessThanOrEqual(MESH_BUDGET);
      expect(all.reduce((n, m) => n + m.geometry.attributes.position.count, 0)).toBeLessThanOrEqual(VERTEX_BUDGET);
      const byParent = new Map<THREE.Object3D, THREE.Material[]>();
      for (const m of bodyMeshes(v)) {
        const list = byParent.get(m.parent!) ?? [];
        list.push(m.material as THREE.Material);
        byParent.set(m.parent!, list);
      }
      for (const mats of byParent.values()) expect(new Set(mats).size).toBe(mats.length);
    });
  }

  it('has clean geometry: finite positions, unit normals, faces wound the way their normals point', () => {
    for (const m of meshes(c.build('#e8452c', false))) {
      const g = m.geometry;
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      expect(nor, g.type).toBeDefined();
      expect(Array.from(pos.array as Float32Array).every(Number.isFinite)).toBe(true);
      for (let i = 0; i < nor.count; i++) expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 3);
      const ix = g.index;
      const tris = (ix ? ix.count : pos.count) / 3;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3(), n = new THREE.Vector3();
      const face = new THREE.Triangle();
      const fn = new THREE.Vector3();
      let flipped = 0;
      for (let t = 0; t < tris; t++) {
        const [i0, i1, i2] = [0, 1, 2].map((k) => (ix ? ix.getX(t * 3 + k) : t * 3 + k));
        face.set(a.fromBufferAttribute(pos, i0), b.fromBufferAttribute(pos, i1), cc.fromBufferAttribute(pos, i2));
        if (face.getArea() < 1e-7) continue;
        face.getNormal(fn);
        n.fromBufferAttribute(nor, i0).add(cc.fromBufferAttribute(nor, i1)).add(cc.fromBufferAttribute(nor, i2));
        if (fn.dot(n) < 0) flipped++;
      }
      expect(flipped, `${g.type} with ${tris} triangles`).toBe(0);
    }
  });

  it('rolls on round tyres of the physics radius, the rims inside them', () => {
    const v = c.build('#e8452c', false);
    for (const w of v.wheels) {
      const [tyre, rim] = w.children as THREE.Mesh[];
      tyre.geometry.computeBoundingBox();
      rim.geometry.computeBoundingBox();
      const t = tyre.geometry.boundingBox!;
      const rb = rim.geometry.boundingBox!;
      for (const k of ['y', 'z'] as const) {
        expect(t.max[k]).toBeCloseTo(S.wheelRadius, 6);
        expect(t.min[k]).toBeCloseTo(-S.wheelRadius, 6);
      }
      expect(rb.min.x).toBeGreaterThanOrEqual(t.min.x - 1e-9);
      expect(rb.max.x).toBeLessThanOrEqual(t.max.x + 1e-9);
    }
  });

  it('stands its wheels on the ground at rest, and each at its rays mean compression', () => {
    const v = c.build('#e8452c', false);
    poseWheels(v, S, settledComp(S));
    const p = new THREE.Vector3();
    for (const w of v.wheels) {
      w.getWorldPosition(p);
      // The body centre is rideHeight above the road.
      expect(p.y - S.wheelRadius).toBeCloseTo(-S.rideHeight, 6);
    }
    // At rest the drawn wheels sit at their design positions under the body.
    if (c.wheels === 4) v.pivots.forEach((pv, i) => expect(pv.position.x).toBeCloseTo(S.wheels[i].x, 9));
  });

  it.skipIf(c.bodywork === false)('keeps the tyres out of the bodywork up to their highest drawn rise, steered, with the body rolled', () => {
    // A tyre surface point inside a closed body part (odd ray crossings, two of three directions) is a
    // tyre drawn through the bodywork. Linkages that ride with the wheel (fork, swingarm, mudguards) are
    // left out: they meet the hub by design. CarView never draws a wheel higher than maxRise.
    const v = c.build('#e8452c', false);
    const linkage = (m: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (v.pivots.includes(p) || p.name === 'swingarm') return true;
      return false;
    };
    const body = bodyMeshes(v).filter((m) => !linkage(m));
    for (const m of body) {
      const mat = (m.material as THREE.Material).clone();
      mat.side = THREE.DoubleSide;
      m.material = mat;
    }
    const rc = new THREE.Raycaster();
    const dirs = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0.01, 0.013).normalize(), new THREE.Vector3(-0.02, 0.01, 1).normalize()];
    // Two votes of three decide, so the third ray is cast only on a split. A point outside the part's
    // bounding box cannot be inside it: no ray at all (the raycasts are what make this test slow).
    const inside = (p: THREE.Vector3, m: THREE.Mesh, box: THREE.Box3) => {
      if (!box.containsPoint(p)) return false;
      let votes = 0;
      for (let d = 0; d < dirs.length; d++) {
        rc.set(p, dirs[d]);
        if (rc.intersectObject(m, false).length % 2 === 1) votes++;
        if (votes >= 2) return true;
        if (votes + dirs.length - 1 - d < 2) return false;
      }
      return false;
    };
    expect(Number.isFinite(v.maxRise)).toBe(true);
    const settled = settledComp(S);
    const lock = maxSteerAngle(0, S) * v.steerScale;
    const rolls = v.roll ? [-TRUCK_ROLL_MAX, 0, TRUCK_ROLL_MAX] : [0];
    for (const roll of rolls) {
      if (v.roll) v.roll.rotation.z = roll;
      for (const comp of [settled, settled + v.maxRise / 2, settled + v.maxRise]) {
        for (const steer of [0, lock, -lock]) {
          v.wheels.forEach((w, i) => {
            if (v.steered[i]) w.parent!.rotation.y = -steer;
          });
          poseWheels(v, S, comp);
          const boxes = body.map((m) => new THREE.Box3().setFromObject(m));
          v.wheels.forEach((w, i) => {
            // A wheel that does not steer is posed the same for every steer: checked once (steer 0).
            if (steer !== 0 && !v.steered[i]) return;
            const tyre = w.children[0] as THREE.Mesh;
            const tyreBox = new THREE.Box3().setFromObject(tyre);
            const near = body.map((m, j) => ({ m, box: boxes[j] })).filter((n) => n.box.intersectsBox(tyreBox));
            const pos = tyre.geometry.attributes.position;
            const p = new THREE.Vector3();
            let poked = 0;
            for (let k = 0; k < pos.count; k += 4) {
              p.fromBufferAttribute(pos, k).applyMatrix4(tyre.matrixWorld);
              if (near.some((n) => inside(p, n.m, n.box))) poked++;
            }
            expect(poked, `wheel ${i} roll ${roll} comp ${comp.toFixed(3)} steer ${steer.toFixed(2)}`).toBe(0);
          });
        }
      }
    }
    // About 10 s alone; generous for a full parallel run on a loaded machine (it once hit 60 s there).
  }, 180_000);

  it('stays inside its physics footprint, above the road and under its badge', () => {
    const v = c.build('#e8452c', false);
    poseWheels(v, S, settledComp(S));
    const b = boxOf(bodyMeshes(v), v.root);
    const hull = (c.name.startsWith('bike') ? BIKE : TRUCK).foot;
    const k = S.wheelRadius / (c.name.startsWith('bike') ? BIKE.wheelRadius : TRUCK.wheelRadius);
    expect(b.max.x).toBeLessThanOrEqual(hull.w * Math.max(1, k) + 0.12);
    expect(b.min.x).toBeGreaterThanOrEqual(-hull.w * Math.max(1, k) - 0.12);
    expect(b.max.z).toBeLessThanOrEqual(Math.max(hull.f * k, S.wheels[0].z + 1.2 * k) + 0.2);
    expect(b.min.z).toBeGreaterThanOrEqual(Math.min(-hull.r * k, S.wheels[2].z - 1.2 * k) - 0.2);
    expect(b.min.y).toBeGreaterThanOrEqual(-S.rideHeight);
    // `top` is the body's highest point, and the badge floats clear of it.
    expect(v.top).toBeCloseTo(b.max.y, 3);
    expect(b.max.y).toBeLessThanOrEqual(avatarLift(v.top) - AVATAR_SIZE / 2 - AVATAR_BOB_AMP - 0.1 + 1e-9);
  });

  it('lists its lamps where they are drawn (none on a ghost)', () => {
    const v = c.build('#e8452c', false);
    expect(v.lights.filter((l) => l.kind === 'head').length).toBe(c.heads);
    expect(v.lights.filter((l) => l.kind === 'tail').length).toBe(c.tails);
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
      const p = new THREE.Vector3(...l.pos).applyMatrix4(v.lamps.matrixWorld);
      expect((l.kind === 'head' ? headBox : tailBox).distanceToPoint(p), `${l.kind} at ${l.pos}`).toBeLessThan(0.05);
      expect(Math.sign(p.z)).toBe(l.kind === 'head' ? 1 : -1);
      expect(l.size).toBeGreaterThan(0);
    }
    expect(c.build('#7fd3ff', true).lights).toEqual([]);
  });

  it('puts no light or flame materials on a ghost, and no shadows', () => {
    c.build('#7fd3ff', true).root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      expect(m.type).toBe('MeshStandardMaterial');
      expect(m.emissive.getHex()).toBe(0);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(o.castShadow).toBe(false);
    });
  });

  it('repaints the shared paint and disposes cleanly, without touching another vehicle', () => {
    const v = c.build('#e8452c', false);
    const other = c.build('#e8452c', false);
    const paints = new Set<THREE.MeshStandardMaterial>();
    v.root.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.MeshStandardMaterial).color.getHexString() === 'e8452c') {
        paints.add(o.material as THREE.MeshStandardMaterial);
      }
    });
    expect(paints.size).toBe(1);
    v.setColor('#00ff00');
    expect([...paints][0].color.getHexString()).toBe('00ff00');
    const mine = new Set(meshes(v).map((m) => m.geometry));
    expect(meshes(other).some((m) => mine.has(m.geometry))).toBe(false);
    expect(() => v.dispose()).not.toThrow();
  });
});

describe('bike', () => {
  it('has a rider in the paint colour who leans with the bike', () => {
    const v = buildBike('#e8452c', false);
    expect(v.lean).not.toBeNull();
    expect(v.roll).toBeNull();
    const paint = bodyMeshes(v).filter((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === 'e8452c');
    // The rider's suit is part of the paint: it reaches well above the seat (about 0.9 m up).
    const top = boxOf(paint, v.root).max.y;
    expect(top + BIKE.rideHeight).toBeGreaterThan(1.15);
    // The white helmet is the highest point.
    const helmet = bodyMeshes(v).filter((m) => (m.material as THREE.MeshStandardMaterial).color.getHexString() === 'f5f5f5');
    const hb = boxOf(helmet, v.root);
    expect(hb.max.y).toBeCloseTo(v.top, 3);
    const before = hb.getCenter(new THREE.Vector3());
    // Leaning right (+z rotation) swings the top of the bike and the rider to the right (-x), about the ground.
    v.lean!.rotation.z = BIKE_LEAN_MAX;
    const after = boxOf(helmet, v.root).getCenter(new THREE.Vector3());
    const h = before.y + BIKE.rideHeight;
    expect(after.x - before.x).toBeCloseTo(-h * Math.sin(BIKE_LEAN_MAX), 1);
    // The wheels lean too: still on the ground line under the centre.
    const w = new THREE.Vector3();
    v.wheels[0].getWorldPosition(w);
    expect(w.x).toBeLessThan(0);
  });

  it('slides the front wheel up its raked fork and keeps the swingarm on the rear axle', () => {
    const v = buildBike('#e8452c', false);
    const bars = v.root.getObjectByName('bars')!;
    const arm = v.root.getObjectByName('swingarm')!;
    let reach = -1;
    for (const comp of [settledComp(BIKE), 0.2, 0.35]) {
      poseWheels(v, BIKE, comp);
      // Front: the wheel centre stays on the fork axis (the bars group's y axis through its origin).
      const o = new THREE.Vector3().setFromMatrixPosition(bars.matrixWorld);
      const axis = new THREE.Vector3(0, 1, 0).transformDirection(bars.matrixWorld);
      const wc = v.wheels[0].getWorldPosition(new THREE.Vector3());
      expect(wc.clone().sub(o).cross(axis).length()).toBeLessThan(1e-6);
      // Rear: the arm (along its -z) points at the rear axle, which stays at the same reach from the pivot.
      const po = new THREE.Vector3().setFromMatrixPosition(arm.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(arm.matrixWorld);
      const rc = v.wheels[1].getWorldPosition(new THREE.Vector3()).sub(po);
      expect(rc.clone().normalize().distanceTo(dir)).toBeLessThan(1e-6);
      if (reach < 0) reach = rc.length();
      expect(rc.length()).toBeCloseTo(reach, 6);
    }
    // At rest the front axle is at its design place; compressed, it has moved up and back along the fork.
    poseWheels(v, BIKE, settledComp(BIKE));
    expect(v.pivots[0].position.z).toBeCloseTo(BIKE_FRONT_Z * (BIKE.wheelRadius / 0.33), 9);
    poseWheels(v, BIKE, 0.35);
    expect(v.pivots[0].position.z).toBeLessThan(BIKE_FRONT_Z * (BIKE.wheelRadius / 0.33) - 0.05);
  });

  it('turns the bars with the front wheel', () => {
    const v = buildBike('#e8452c', false);
    v.pivots[0].rotation.y = -0.3;
    v.update!();
    const bars = v.root.getObjectByName('bars')!;
    expect(bars.rotation.y).toBe(-0.3);
    expect(bars.rotation.x).toBe(v.pivots[0].rotation.x);
    // The steering axis is raked back.
    expect(v.pivots[0].rotation.x).toBeLessThan(-0.2);
  });

  it('keeps the photo badge at the car height', () => {
    expect(avatarLift(buildBike().top)).toBe(AVATAR_LIFT);
  });
});

describe('truck', () => {
  it('rolls its body on the springs; wheels and mudguards stay on the axles', () => {
    const v = buildTruck('#e8452c', false);
    expect(v.roll).not.toBeNull();
    expect(v.lean).toBeNull();
    poseWheels(v, TRUCK, settledComp(TRUCK));
    const wheelsAt = () => v.wheels.map((w) => w.getWorldPosition(new THREE.Vector3()));
    const guards = bodyMeshes(v).filter((m) => v.pivots.includes(m.parent!.parent!));
    expect(guards.length).toBe(2);
    const guardBox = () => boxOf(guards, v.root).clone();
    const cab = () => boxOf(bodyMeshes(v).filter((m) => !guards.includes(m)), v.root).clone();
    const w0 = wheelsAt();
    const g0 = guardBox();
    const c0 = cab();
    v.roll!.rotation.z = TRUCK_ROLL_MAX;
    v.root.updateMatrixWorld(true);
    wheelsAt().forEach((p, i) => expect(p.distanceTo(w0[i])).toBeLessThan(1e-9));
    expect(guardBox().equals(g0)).toBe(true);
    // The body, mostly above the roll axis, swings to the -x side for a + roll.
    expect(cab().getCenter(new THREE.Vector3()).x).toBeLessThan(c0.getCenter(new THREE.Vector3()).x - 0.05);
  });

  it('lifts the photo badge over the cab and box', () => {
    const v = buildTruck();
    expect(avatarLift(v.top)).toBeGreaterThan(AVATAR_LIFT);
  });

  it('steers the front axle only and mirrors the right-hand wheels', () => {
    const v = buildTruck();
    expect(v.steered).toEqual([true, true, false, false]);
    v.wheels.forEach((w, i) => expect(w.scale.x).toBe(TRUCK.wheels[i].x < 0 ? -1 : 1));
  });
});

describe('buildVehicle', () => {
  it('builds each class, with body styles for cars only', () => {
    expect(buildVehicle('car', '#e8452c', false, 'buggy').body).toBe('buggy');
    const bike = buildVehicle('bike', '#e8452c', false, 'buggy');
    expect(bike.vehicle).toBe('bike');
    expect(bike.body).toBeNull();
    const truck = buildVehicle('truck', '#e8452c', true);
    expect(truck.vehicle).toBe('truck');
    expect(truck.lights).toEqual([]);
    expect(buildVehicle('car', '#e8452c').vehicle).toBe('car');
  });
});
