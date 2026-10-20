// Procedural race truck (original design): a cab-over cab and a box body on four wheels, duals at
// the rear. Local frame: +z forward, +y up, +x left. The wheels sit on the truck's physics anchors
// (physics/vehicle.ts) and everything is placed from them: the cab over the front axle, the box
// behind it, heights scaled with the wheel radius (designed at 0.55 m) from the ground under the
// settled body. Cab and box roll on their springs (visual only, CarView sets it); the wheels and
// the rear mudguards stay with the axles.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vehicleSpec, type VehicleSpec } from '../physics/vehicle';
import {
  addFlames,
  addParts,
  cachedGeometry,
  disposeTree,
  driver,
  FLAME_LEN,
  makeMats,
  mesh,
  partsTop,
  roundLamp,
  templateParts,
  wheelGeometry,
  type CarLight,
  type CarMats,
  type CarVisual,
  type ShellPart,
} from './carMesh';
import { extrudeX, fenderGeometry, profileGeometry, rbox, tyreGeometry, type Vec3 } from './carParts';

/** Design wheel radius: heights and overhangs are drawn for it and scaled with the physics radius. */
const R0 = 0.55;
/** Front tyre width, and each rear dual tyre's (design units). */
const FRONT_W = 0.38;
const DUAL_W = 0.3;
/** Rear duals: outer tyre centre and inner tyre centre across the hub (design units, outboard +x). */
const DUAL_OUT = 0.035;
const DUAL_IN = -0.285;
/** Largest visual body roll (rad): a few degrees, so the cab's arches stay clear of the front tyres. */
export const TRUCK_ROLL_MAX = 0.07;
/**
 * Highest the drawn wheels rise above their settled height (design units, CarVisual.maxRise): the cab's
 * front arches, the box floor and the rails are cut to clear the tyres and the rear mudguards up to it,
 * at full lock and full roll.
 */
const MAX_RISE = 0.16;

/** Truck dimensions from its physics geometry: axles, track, wheel radius and the scale of everything else. */
interface TruckDims {
  /** Front and rear axle z, half track. */
  fz: number;
  rz: number;
  x: number;
  R: number;
  s: number;
  /** Cab half width, front and rear (z). */
  hw: number;
  cf: number;
  cr: number;
  /** Box rear and front (z). */
  br: number;
  bf: number;
}

function dimsOf(spec: VehicleSpec): TruckDims {
  const R = spec.wheelRadius;
  const s = R / R0;
  const fz = spec.wheels[0].z;
  const rz = spec.wheels[2].z;
  const x = Math.abs(spec.wheels[0].x);
  const cr = fz - 1.05 * s;
  return { fz, rz, x, R, s, hw: x + 0.09 * s, cf: fz + 0.9 * s, cr, br: rz - 1.1 * s, bf: cr - 0.14 * s };
}

/** Hood camera eye (height above the ground and z): in the cab behind the screen, beside the driver. */
export function truckEye(spec: VehicleSpec = vehicleSpec('truck')): { h: number; z: number } {
  const d = dimsOf(spec);
  return { h: 1.95 * d.s, z: d.fz + 0.35 * d.s };
}

interface TruckTemplate {
  body: ShellPart[];
  guard: ShellPart[];
  stacks: Vec3[];
  lights: CarLight[];
}

const templates = new Map<string, TruckTemplate>();

function truckTemplate(d: TruckDims, ghost: boolean): TruckTemplate {
  const key = `${ghost}:${d.fz}:${d.rz}:${d.x}:${d.R}`;
  let t = templates.get(key);
  if (t) return t;
  const m = makeMats('#ffffff', ghost);
  const body = new THREE.Group();
  const extra = buildBody(body, m, d);
  const guard = new THREE.Group();
  // Rear mudguard over the duals, on the axle (pivot frame: origin at the hub, outboard +x).
  const s = d.s;
  guard.add(mesh(fenderGeometry(0, d.R + 0.04 * s, d.R + 0.08 * s, 0.05 * s, -0.45 * s, 0.2 * s, 0, 0.015), m.dark));
  t = { body: templateParts(body, m), guard: templateParts(guard, m), ...extra };
  for (const mat of Object.values(m)) mat?.dispose();
  templates.set(key, t);
  return t;
}

/** Cab, box, skirts and stacks in the ground frame (y = 0 on the road). Returns the flame centres over the stacks and the lamps. */
function buildBody(g: THREE.Group, m: CarMats, d: TruckDims): { stacks: Vec3[]; lights: CarLight[] } {
  const { paint, dark, glass, accent, chrome } = m;
  const { s, hw, cf, cr, br, bf, fz, rz, x, R } = d;
  const boxTop = 2.85 * s;
  // The box floor clears the rear mudguards at full rise with the body rolled.
  const floor = 1.5 * s;

  // Cab: a raked screen over a flat front, the front wheel arch cut out of its lower edge (centred
  // over the wheel at full rise, so the tyre clears it while the cab rolls and the wheel steers).
  g.add(
    mesh(
      profileGeometry(
        {
          front: cf,
          rear: cr,
          foot: 0.62 * s,
          arches: [fz],
          archR: R + 0.14 * s,
          archY: R + MAX_RISE * s,
          top: (sh) => {
            sh.lineTo(cf, 1.45 * s);
            sh.lineTo(cf - 0.3 * s, 2.35 * s);
            sh.quadraticCurveTo(cf - 0.36 * s, 2.5 * s, cf - 0.5 * s, 2.5 * s);
            sh.lineTo(cr + 0.1 * s, 2.5 * s);
            sh.quadraticCurveTo(cr, 2.5 * s, cr, 2.4 * s);
          },
        },
        -hw,
        hw,
        0.04 * s,
      ),
      paint,
    ),
  );
  // Screen on the raked face (just proud of the bevel), side windows, and the driver behind the glass.
  // The panes are single-sided, facing out: the hood camera inside the cab looks straight through them.
  const rake = Math.atan2(0.3, 0.9);
  const lift = 0.04 * s + 0.012;
  const screen = mesh(new THREE.PlaneGeometry(2 * (hw - 0.14 * s), 0.82 * s), glass, 0, 1.9 * s + lift * Math.sin(rake), cf - 0.15 * s + lift * Math.cos(rake));
  screen.rotation.x = -rake;
  g.add(screen);
  for (const sd of [-1, 1]) {
    const side = mesh(new THREE.PlaneGeometry(0.8 * s, 0.6 * s), glass, sd * (hw + 0.006), 1.95 * s, cf - 0.72 * s);
    side.rotation.y = (sd * Math.PI) / 2;
    g.add(side);
  }
  driver(g, m, hw - 0.6 * s, 1.95 * s, cf - 0.85 * s, 0.17 * s);

  // Roof deflector up to the box line, a roof light bar, the stripe along the cab.
  const defl = new THREE.Shape();
  defl.moveTo(cf - 0.62 * s, 2.5 * s);
  defl.lineTo(cr + 0.25 * s, boxTop);
  defl.lineTo(cr, boxTop);
  defl.lineTo(cr, 2.45 * s);
  g.add(mesh(extrudeX(defl, -(hw - 0.06 * s), hw - 0.06 * s, 0.03 * s), paint));
  g.add(rbox(dark, 1.6 * s, 0.1 * s, 0.1 * s, 0, 2.56 * s, cf - 0.62 * s, 0.03, 1));
  // A strip on each side, not a bar through the cab: the hood camera sits inside the cab.
  for (const sd of [-1, 1]) g.add(rbox(accent, 0.012, 0.1 * s, cf - cr - 0.25 * s, sd * (hw + 0.004), 1.6 * s, (cf + cr) / 2 - 0.08 * s, 0.005, 1));

  // Grille with chrome bars, and the bumper below it.
  g.add(rbox(dark, 1.3 * s, 0.42 * s, 0.03, 0, 1.12 * s, cf + 0.04 * s + 0.01, 0.01, 1));
  for (const h of [0.98, 1.12, 1.26]) g.add(rbox(chrome, 1.24 * s, 0.04 * s, 0.03, 0, h * s, cf + 0.04 * s + 0.025, 0.01, 1));
  g.add(rbox(dark, 2 * hw + 0.04 * s, 0.3 * s, 0.32 * s, 0, 0.52 * s, cf + 0.02 * s, 0.04 * s));

  // Box body with a stripe, a floor rail and rear doors.
  const bl = bf - br;
  const bm = (bf + br) / 2;
  const doorY = (boxTop + floor) / 2;
  g.add(rbox(paint, 2 * (hw + 0.01), boxTop - floor, bl, 0, doorY, bm, 0.06 * s));
  g.add(rbox(accent, 2 * (hw + 0.02), 0.14 * s, bl - 0.3 * s, 0, 2.3 * s, bm, 0.02, 1));
  g.add(rbox(dark, 2 * (hw + 0.015), 0.1 * s, bl, 0, floor + 0.03 * s, bm, 0.02, 1));
  g.add(rbox(dark, 0.04 * s, boxTop - floor - 0.2 * s, 0.03, 0, doorY, br - 0.012, 0.01, 1));
  for (const sd of [-1, 1]) g.add(rbox(chrome, 0.03 * s, boxTop - floor - 0.4 * s, 0.03, sd * 0.2 * s, doorY, br - 0.025, 0.01, 1));

  // Side skirts between the wheels up to the box, chassis rails between the duals up to its floor (clear
  // of the inner tyres with the body rolled), the rear underrun bar.
  const sf = fz - R - 0.12 * s;
  const sr = rz + R + 0.1 * s;
  g.add(rbox(dark, 2 * (hw - 0.03 * s), floor - 0.62 * s, sf - sr, 0, (floor + 0.62 * s) / 2, (sf + sr) / 2, 0.04 * s, 1));
  const railF = rz + R + 0.1 * s;
  const railR = br + 0.1 * s;
  g.add(rbox(dark, 2 * (x - 0.55 * s), floor - 0.9 * s, railF - railR, 0, (floor + 0.9 * s) / 2, (railF + railR) / 2, 0.03, 1));
  g.add(rbox(dark, 2 * (hw - 0.12 * s), 0.2 * s, 0.12 * s, 0, 0.62 * s, br + 0.08 * s, 0.03, 1));
  for (const sd of [-1, 1]) g.add(rbox(dark, 0.08 * s, 0.4 * s, 0.08 * s, sd * 0.5 * s, 0.85 * s, br + 0.1 * s, 0.02, 1));

  // Exhaust stacks in the gap between cab and box, each with a dark bore.
  const stackX = hw - 0.16 * s;
  const stackZ = cr - 0.07 * s;
  const stacks: Vec3[] = [];
  for (const sd of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.075 * s, 0.075 * s, 1.6 * s, 14), chrome, sd * stackX, 2.1 * s, stackZ));
    g.add(mesh(new THREE.CylinderGeometry(0.055 * s, 0.055 * s, 0.02, 12), dark, sd * stackX, 2.9 * s + 0.002, stackZ));
    // The flame's base 2 cm down the bore, clear of the box top (2.85 s) its wide base would z-fight with.
    stacks.push([sd * stackX, 2.9 * s - 0.02 + FLAME_LEN / 2, stackZ]);
  }

  // Head lamps beside the grille and a roof bar of four; tail lamps on the bar and high on the box.
  const lights: CarLight[] = [];
  if (m.head && m.tail) {
    for (const sd of [-1, 1]) {
      g.add(rbox(m.head, 0.34 * s, 0.13 * s, 0.03, sd * (hw - 0.3 * s), 1.12 * s, cf + 0.04 * s + 0.015, 0.02, 1));
      for (const lx of [0.25, 0.65]) roundLamp(g, m.head, dark, sd * lx * s, 2.62 * s, cf - 0.55 * s, 0.055 * s);
      g.add(rbox(m.tail, 0.3 * s, 0.1 * s, 0.03, sd * (hw - 0.35 * s), 0.62 * s, br + 0.005, 0.015, 1));
      g.add(rbox(m.tail, 0.1 * s, 0.3 * s, 0.03, sd * (hw - 0.1 * s), 2.6 * s, br - 0.015, 0.015, 1));
    }
    for (const sd of [-1, 1]) {
      lights.push({ pos: [sd * (hw - 0.3 * s), 1.12 * s, cf + 0.04 * s + 0.035], kind: 'head', size: 0.6 * s });
    }
    for (const sd of [-1, 1]) lights.push({ pos: [sd * (hw - 0.35 * s), 0.62 * s, br - 0.015], kind: 'tail', size: 0.5 * s });
  }
  return { stacks, lights };
}

/** Rear dual tyres as one geometry: the outer tyre and the inner one across the hub (outboard +x). */
function dualTyre(w: number, R: number, s: number): THREE.BufferGeometry {
  return cachedGeometry(`dual-tyre:${w}:${R}:${s}`, () => {
    const a = tyreGeometry(w, R).translate(DUAL_OUT * s, 0, 0);
    const b = tyreGeometry(w, R).translate(DUAL_IN * s, 0, 0);
    const g = mergeGeometries([a, b])!;
    a.dispose();
    b.dispose();
    return g;
  });
}

function dualRim(w: number, R: number, s: number): THREE.BufferGeometry {
  return cachedGeometry(`dual-rim:${w}:${R}:${s}`, () => wheelGeometry('rim', w, undefined, R, 8).clone().translate(DUAL_OUT * s, 0, 0));
}

/** Every physics wheel is drawn; the front axle steers. */
const TRUCK_WHEEL_SRC: readonly (readonly number[])[] = [[0], [1], [2], [3]];
const TRUCK_STEERED: readonly boolean[] = [true, true, false, false];

/** The truck for a class's physics geometry (the truck's spec by default). */
export function buildTruck(color = '#e8452c', ghost = false, spec: VehicleSpec = vehicleSpec('truck')): CarVisual {
  const d = dimsOf(spec);
  const rh = spec.rideHeight;
  const t = truckTemplate(d, ghost);
  const m = makeMats(color, ghost);

  // root > roll (about the axle line) > cabin (on the ground: the drawn body); wheels on the root.
  const root = new THREE.Group();
  const roll = new THREE.Group();
  roll.position.y = d.R - rh;
  root.add(roll);
  const cabin = new THREE.Group();
  cabin.position.y = -d.R;
  roll.add(cabin);
  addParts(cabin, t.body, m, ghost);
  const flames = addFlames(cabin, m, t.stacks, true, 0.12 * d.s);

  const wheels: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  spec.wheels.forEach((a, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(a.x, d.R - rh, a.z);
    root.add(pivot);
    const front = i < 2;
    const wheel = new THREE.Group();
    const tyre = new THREE.Mesh(
      (front ? wheelGeometry('tyre', FRONT_W * d.s, undefined, d.R) : dualTyre(DUAL_W * d.s, d.R, d.s)).clone(),
      m.tyre,
    );
    tyre.castShadow = !ghost;
    const rim = front ? wheelGeometry('rim', FRONT_W * d.s, undefined, d.R, 8) : dualRim(DUAL_W * d.s, d.R, d.s);
    wheel.add(tyre, new THREE.Mesh(rim.clone(), m.chrome));
    if (a.x < 0) wheel.scale.x = -1;
    pivot.add(wheel);
    if (!front) {
      // The mudguard rides with the axle (it does not spin): mirrored on the right like the wheel.
      const guard = new THREE.Group();
      addParts(guard, t.guard, m, ghost);
      if (a.x < 0) guard.scale.x = -1;
      pivot.add(guard);
    }
    wheels.push(wheel);
    pivots.push(pivot);
  });

  return {
    vehicle: 'truck',
    body: null,
    root,
    lamps: cabin,
    wheels,
    pivots,
    wheelSrc: TRUCK_WHEEL_SRC,
    steered: TRUCK_STEERED,
    steerScale: 1,
    maxRise: MAX_RISE * d.s,
    lean: null,
    roll,
    top: partsTop(t.body) - rh,
    flames,
    lights: ghost ? [] : t.lights,
    setColor(hex: string) {
      m.paint.color.set(hex);
    },
    dispose() {
      disposeTree(root);
    },
  };
}
