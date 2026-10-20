// Realistic models (src/core/vehicleModels.ts) as CarVisuals. A loaded glTF scene becomes a template once
// (prepareTemplate: fitted to its class, lamps, exhausts and the wheels' free travel derived from its
// meshes); every car, ghost and menu car is an instance of it (instantiate) that shares the template's
// geometry, textures and materials and owns only its paint, ghost material, rider and flames, so
// disposing one never blanks another. No loader code here: modelLoader.ts (loaded on demand) reads the
// files, and tests build templates from plain three.js scenes.

import * as THREE from 'three';
import { MODEL_LAMP, MODEL_PAINT, modelWheelNames, type VehicleModel } from '../core/vehicleModels';
import { vehicleSpec } from '../physics/vehicle';
import { riderParts } from './bikeMesh';
import { addFlames, addParts, disposeTree, FLAME_LEN, makeMats, partsTop, type CarLight, type CarVisual } from './carMesh';
import { fitTarget, fitVehicle, riseLimit, type Fit } from './vehicleFit';

/** Most metalness a model material keeps: without the baked environment (Low, or Medium before the bake) full metals render black. */
export const MODEL_METALNESS_MAX = 0.5;
/** Where the rider sits on a realistic bike, relative to the procedural bike's seat (design units). */
const RIDER: Record<string, { y: number; z: number }> = { cafe: { y: -0.07, z: -0.07 } };
/** Exhaust flame radius per class. */
const FLAME_R = { car: 0.13, bike: 0.08, truck: 0.15 } as const;

export interface ModelTemplate {
  readonly model: VehicleModel;
  /** The fitted scene (scale and offset on this group): shared by every instance. */
  readonly scene: THREE.Group;
  readonly fit: Fit;
  readonly lights: readonly CarLight[];
  readonly exhausts: readonly (readonly [number, number, number])[];
  readonly top: number;
  readonly maxRise: number;
  /** Live instances. */
  refs: number;
  /** Frees the shared geometry, materials and textures (only once no instance is left). */
  dispose(): void;
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

function meshMaterials(o: THREE.Mesh): THREE.Material[] {
  return Array.isArray(o.material) ? o.material : [o.material];
}

/** True for objects at or below a node named `prefix...`. */
function under(o: THREE.Object3D, test: (name: string) => boolean): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (test(p.name)) return true;
  return false;
}

/** Every vertex of the meshes under root that pass `keep`, in root's parent frame (matrixWorld must be current). */
function vertices(root: THREE.Object3D, keep: (m: THREE.Mesh) => boolean): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  root.traverse((o) => {
    if (!isMesh(o) || !keep(o)) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
  });
  return out;
}

/**
 * Lamp glow cards from the lamp meshes (nodes named vb_lamp*): the frontmost and rearmost lamps on each
 * side, each card at the lamp's face and about its size.
 */
export function lampsFrom(points: readonly THREE.Vector3[]): CarLight[] {
  if (!points.length) return [];
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of points) {
    zMin = Math.min(zMin, p.z);
    zMax = Math.max(zMax, p.z);
  }
  const mid = (zMin + zMax) / 2;
  const out: CarLight[] = [];
  for (const kind of ['head', 'tail'] as const) {
    const end = kind === 'head' ? zMax : zMin;
    const near = points.filter((p) => (kind === 'head' ? p.z > mid && p.z > end - 0.3 : p.z < mid && p.z < end + 0.3));
    for (const side of [1, -1]) {
      const pts = near.filter((p) => p.x * side > 0);
      if (!pts.length) continue;
      const b = new THREE.Box3().setFromPoints(pts);
      const size = Math.min(0.45, Math.max(0.18, Math.max(b.max.x - b.min.x, b.max.y - b.min.y) * 1.4));
      out.push({ pos: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, kind === 'head' ? b.max.z : b.min.z], kind, size });
    }
  }
  return out;
}

/**
 * Turn a loaded model scene (canonical frame from scripts/build-vehicles.ts: +z forward, +x left, ground at
 * y = 0) into a template: fitted to its class, materials capped for phones, lamps, exhausts, free wheel travel
 * and the top measured from its meshes. Throws when a wheel node is missing.
 */
export function prepareTemplate(scene: THREE.Object3D, model: VehicleModel): ModelTemplate {
  const cls = model.cls;
  const spec = vehicleSpec(cls);
  const fitted = new THREE.Group();
  fitted.name = `model:${model.id}`;
  fitted.add(scene);
  fitted.updateMatrixWorld(true);

  const names = modelWheelNames(cls);
  const wheelObjs = names.map((n) => {
    const o = scene.getObjectByName(n);
    if (!o) throw new Error(`${model.id}: no wheel node ${n}`);
    return o;
  });
  const wheelBox = (o: THREE.Object3D) => {
    const b = new THREE.Box3().setFromObject(o);
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    return { cx: c.x, cy: c.y, cz: c.z, r: Math.max(s.y, s.z) / 2 };
  };
  const bounds = new THREE.Box3().setFromObject(scene);
  const fit = fitVehicle(wheelObjs.map(wheelBox), cls === 'bike' ? 1 : 2, bounds.min, bounds.max, fitTarget(cls, spec));
  fitted.scale.setScalar(fit.scale);
  fitted.position.set(fit.offset.x, fit.offset.y, fit.offset.z);
  fitted.updateMatrixWorld(true);

  // Phones: no physical materials, and metals keep some diffuse colour (see MODEL_METALNESS_MAX).
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    if (!isMesh(o)) return;
    for (const m of meshMaterials(o)) mats.add(m);
  });
  for (const m of mats) {
    const s = m as THREE.MeshStandardMaterial;
    if (s.isMeshStandardMaterial) s.metalness = Math.min(s.metalness, MODEL_METALNESS_MAX);
  }

  const isWheel = (n: string) => names.includes(n);
  const lamps = vertices(fitted, (m) => under(m, (n) => n.startsWith(MODEL_LAMP)));
  const bodyBox = new THREE.Box3();
  fitted.traverse((o) => {
    if (isMesh(o) && !under(o, isWheel)) bodyBox.expandByObject(o);
  });

  // Free travel: the smallest gap between a tyre's top and the bodywork right above it, found by casting up
  // from the axle across the tyre's footprint (hubs and anything inside the tyre are skipped).
  const bodyMeshes: THREE.Mesh[] = [];
  fitted.traverse((o) => {
    if (isMesh(o) && !under(o, isWheel)) bodyMeshes.push(o);
  });
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const gaps: number[] = [];
  wheelObjs.forEach((o, i) => {
    const w = fit.wheels[i];
    const b = new THREE.Box3().setFromObject(o);
    const hw = (b.max.x - b.min.x) / 2;
    const cx = (b.max.x + b.min.x) / 2;
    ray.far = w.r + 0.5;
    let gap = Infinity;
    for (const dx of [-0.8, 0, 0.8])
      for (const dz of [-0.6, 0, 0.6]) {
        ray.set(new THREE.Vector3(cx + dx * hw, w.y, w.z + dz * w.r), up);
        for (const h of ray.intersectObjects(bodyMeshes, false)) {
          if (h.distance < w.r - 0.02) continue;
          gap = Math.min(gap, h.distance - Math.sqrt(Math.max(0, w.r * w.r - (dz * w.r) ** 2)));
          break;
        }
      }
    if (gap < Infinity) gaps.push(Math.max(0, gap));
  });

  const rh = spec.rideHeight;
  let top = bodyBox.max.y;
  const exhausts: [number, number, number][] = [];
  const zTail = bodyBox.min.z + 0.05 - FLAME_LEN / 2;
  if (cls === 'bike') {
    const r = RIDER[model.id] ?? { y: 0, z: 0 };
    top = Math.max(top, partsTop(riderParts(false)) + r.y - rh);
    // Under the tail, on the centre line.
    exhausts.push([0, bodyBox.min.y + 0.45, zTail + 0.15]);
  } else {
    const x = (bodyBox.max.x - bodyBox.min.x) * 0.22;
    exhausts.push([-x, bodyBox.min.y + 0.2, zTail], [x, bodyBox.min.y + 0.2, zTail]);
  }

  return {
    model,
    scene: fitted,
    fit,
    lights: lampsFrom(lamps),
    exhausts,
    top,
    maxRise: riseLimit(gaps),
    refs: 0,
    dispose() {
      const tex = new Set<THREE.Texture>();
      fitted.traverse((o) => {
        if (!isMesh(o)) return;
        o.geometry.dispose();
        for (const m of meshMaterials(o)) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) tex.add(v);
          m.dispose();
        }
      });
      tex.forEach((t) => t.dispose());
    },
  };
}

const CAR_WHEEL_SRC: readonly (readonly number[])[] = [[0], [1], [2], [3]];
const CAR_STEERED: readonly boolean[] = [true, true, false, false];
const BIKE_WHEEL_SRC: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3],
];
// The realistic bike's fork is part of its body, so its front wheel does not turn (it leans instead).
const BIKE_STEERED: readonly boolean[] = [false, false];

/**
 * A vehicle drawn with a template: root > tilt (the bike's lean about its ground line, the truck's roll about
 * its axles) > inner (the body frame) > the shared model, plus the instance's own pivots, rider and flames.
 */
export function instantiate(tpl: ModelTemplate, color: string, ghost: boolean): CarVisual {
  const cls = tpl.model.cls;
  const spec = vehicleSpec(cls);
  const rh = spec.rideHeight;
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  root.add(tilt);
  const inner = new THREE.Group();
  tilt.add(inner);
  if (cls === 'bike') tilt.position.y = -rh;
  else if (cls === 'truck') tilt.position.y = tpl.fit.wheels.reduce((a, w) => a + w.y, 0) / tpl.fit.wheels.length;
  inner.position.y = -tilt.position.y;
  const body = tpl.scene.clone(true);
  inner.add(body);
  root.updateMatrixWorld(true);

  // Each wheel spins in a group at its own centre: attach() keeps it where it was drawn.
  const wheels: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  modelWheelNames(cls).forEach((n, i) => {
    const w = body.getObjectByName(n)!;
    const c = tpl.fit.wheels[i];
    const pivot = new THREE.Group();
    pivot.position.set(c.x, c.y, c.z);
    (cls === 'bike' ? inner : root).add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    pivot.updateMatrixWorld(true);
    spin.attach(w);
    wheels.push(spin);
    pivots.push(pivot);
  });

  // Own materials: the tinted paint, or one translucent material for the whole ghost.
  const m = makeMats(color, ghost);
  const owned: THREE.Material[] = [];
  const paints = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  // The root: the wheels now hang from their pivots, outside the model group.
  root.traverse((o) => {
    if (!isMesh(o)) return;
    o.castShadow = !ghost;
    if (ghost) {
      o.material = m.paint;
      return;
    }
    const src = o.material as THREE.MeshStandardMaterial;
    if (src.name !== MODEL_PAINT || !tpl.model.tintable || !src.isMeshStandardMaterial) return;
    let p = paints.get(src);
    if (!p) {
      p = src.clone();
      p.color.set(color);
      paints.set(src, p);
      owned.push(p);
    }
    o.material = p;
  });

  // The bike's rider, in the profile colour.
  const extras = new THREE.Group();
  inner.add(extras);
  if (cls === 'bike') {
    const r = RIDER[tpl.model.id] ?? { y: 0, z: 0 };
    const rider = new THREE.Group();
    rider.position.set(0, r.y - rh, r.z);
    addParts(rider, riderParts(ghost), m, ghost);
    extras.add(rider);
  }
  const flames = addFlames(extras, m, tpl.exhausts as [number, number, number][], false, FLAME_R[cls]);

  tpl.refs++;
  let alive = true;
  return {
    vehicle: cls,
    body: null,
    model: tpl.model.id,
    root,
    lamps: inner,
    wheels,
    pivots,
    wheelR: tpl.fit.wheels.map((w) => w.r),
    wheelSrc: cls === 'bike' ? BIKE_WHEEL_SRC : CAR_WHEEL_SRC,
    steered: cls === 'bike' ? BIKE_STEERED : CAR_STEERED,
    steerScale: 1,
    maxRise: tpl.maxRise,
    lean: cls === 'bike' ? tilt : null,
    roll: cls === 'truck' ? tilt : null,
    top: tpl.top,
    flames,
    lights: ghost ? [] : tpl.lights,
    setColor(hex: string) {
      m.paint.color.set(hex);
      for (const p of owned) (p as THREE.MeshStandardMaterial).color.set(hex);
    },
    dispose() {
      if (!alive) return;
      alive = false;
      // Only what this instance owns: the shared model geometry, textures and materials stay.
      disposeTree(extras);
      for (const mat of Object.values(m)) mat?.dispose();
      owned.forEach((o) => o.dispose());
      tpl.refs--;
    },
  };
}
