// Procedural sport bike and its rider (original design). Local frame: +z forward, +y up, +x left.
// The physics drives a bike on four suspension rays with a car-length footprint
// (physics/vehicle.ts); two wheels are drawn, the front one at the mean of the front pair and the
// rear one at the mean of the rear pair. The lean is visual only (CarView sets it from the yaw
// rate) and pivots about the ground line under the centre, so the rider leans with the bike.
// Everything but the wheels is drawn for a design wheel radius of 0.33 m and scaled to the physics
// radius, with the ground at y = 0 in the scaled frame.

import * as THREE from 'three';
import { vehicleSpec, type VehicleSpec } from '../physics/vehicle';
import {
  addFlames,
  addParts,
  cachedGeometry,
  disposeTree,
  driver,
  exhaustTip,
  FLAME_LEN,
  makeMats,
  mesh,
  partsTop,
  roundLamp,
  stripe,
  templateParts,
  wheelGeometry,
  type CarLight,
  type CarMats,
  type CarVisual,
  type ShellPart,
} from './carMesh';
import { fenderGeometry, loftGeometry, rbox, strut, tubeGeometry, tyreGeometry, type LoftSection, type Vec3 } from './carParts';

/** Design wheel radius: the frame, rider and fork are drawn for it and scaled to the physics radius. */
const R0 = 0.33;
/** Drawn axles (z, design units): a 1.44 m wheelbase, a real sport bike's, inside the physics footprint. */
export const BIKE_FRONT_Z = 0.74;
export const BIKE_REAR_Z = -0.7;
/** Fork rake (rad): the front wheel steers about this tilted axis and slides up it as the fork compresses. */
const RAKE = 0.42;
const TAN_RAKE = Math.tan(RAKE);
/** Swingarm pivot (height above the ground and z, design units) and the arm's length to the rear axle. */
const SWING_H = 0.44;
const SWING_Z = -0.1;
const SWING_L = Math.hypot(SWING_H - R0, SWING_Z - BIKE_REAR_Z);
/** Front and rear tyre widths (design units). */
const TYRE_W = [0.12, 0.17] as const;
/** Centre (z, design units) of the muffler's 0.14 m tip (carMesh exhaustTip). */
const TIP_Z = -0.92;
/**
 * Exhaust flame centre (design units): behind the muffler tip on the right (-x), its base 2 cm inside the
 * tip's open end, so no gap shows and its wider cone does not collar the pipe.
 */
const FLAME: Vec3 = [-0.22, 0.62, TIP_Z - 0.07 + 0.02 - FLAME_LEN / 2];
/**
 * Hood camera eye (design units): just over the rider's helmet, an onboard camera. Nothing of the bike
 * comes within the camera's 0.3 m near plane in view, even at the widest speed FOV.
 */
const EYE = { h: 1.56, z: 0.32 } as const;
/** Largest visual lean (rad): about 40 degrees, so the rider's head stays near the bike's footprint. */
export const BIKE_LEAN_MAX = 0.7;
/**
 * Highest the drawn wheels rise above their settled height (design units, CarVisual.maxRise): about a
 * sport bike's travel. Up to it the front tyre clears the fairing, the engine and the bars (the fork legs
 * just reach the lower clamp), and the rear one the tail and the seat.
 */
const MAX_RISE = 0.12;

/** The bike's parts merged once per material: frame and rider, the fork legs (front pivot), bars (steering) and swingarm. */
interface BikeTemplate {
  shell: ShellPart[];
  /** The rider on his own (the shell includes him): for the realistic bike. */
  rider: ShellPart[];
  fork: ShellPart[];
  steer: ShellPart[];
  swing: ShellPart[];
  lights: CarLight[];
}

const templates = new Map<boolean, BikeTemplate>();

function bikeTemplate(ghost: boolean): BikeTemplate {
  let t = templates.get(ghost);
  if (t) return t;
  const m = makeMats('#ffffff', ghost);
  const parts = (build: (g: THREE.Group, m: CarMats) => void): ShellPart[] => {
    const g = new THREE.Group();
    build(g, m);
    return templateParts(g, m);
  };
  t = {
    shell: parts(buildFrame),
    rider: parts(buildRider),
    fork: parts(buildForkLegs),
    steer: parts(buildBars),
    swing: parts(buildSwingarm),
    lights: [
      { pos: [0.05, 0.86, 1.1], kind: 'head', size: 0.3 },
      { pos: [-0.05, 0.86, 1.1], kind: 'head', size: 0.3 },
      { pos: [0, 0.97, -0.98], kind: 'tail', size: 0.35 },
    ],
  };
  for (const mat of Object.values(m)) mat?.dispose();
  templates.set(ghost, t);
  return t;
}

/** The rider's merged parts (design units, ground frame), shared like the bike's: addParts copies them. */
export function riderParts(ghost: boolean): readonly ShellPart[] {
  return bikeTemplate(ghost).rider;
}

/** Fairing, tank, tail, engine, exhaust and the rider, in the ground frame (design units). */
function buildFrame(g: THREE.Group, m: CarMats): void {
  const { paint, dark, glass, accent, chrome } = m;

  // Fairing from the nose back past the engine: the upper part rides over the front wheel, clear of it
  // up to MAX_RISE; the lower part drops down beside the engine behind the wheel.
  g.add(
    mesh(
      loftGeometry(
        [
          { z: 1.08, hw: 0.1, top: 0.92, bottom: 0.8, n: 2.6, nb: 2.2 },
          { z: 0.98, hw: 0.17, top: 1.0, bottom: 0.72, n: 2.6, nb: 2.2 },
          { z: 0.8, hw: 0.24, top: 1.07, bottom: 0.82, n: 2.8, nb: 2.2 },
          { z: 0.55, hw: 0.28, top: 1.05, bottom: 0.82, n: 2.8, nb: 2.2 },
          { z: 0.38, hw: 0.27, top: 1.0, bottom: 0.72, n: 2.8, nb: 2.2 },
          { z: 0.3, hw: 0.26, top: 0.97, bottom: 0.3, n: 2.8, nb: 2.2 },
          { z: 0.12, hw: 0.2, top: 0.84, bottom: 0.28, n: 2.8, nb: 2.2 },
        ],
        18,
      ),
      paint,
    ),
  );
  // Screen over the nose.
  g.add(
    mesh(
      loftGeometry(
        [
          { z: 0.95, hw: 0.12, top: 1.02, bottom: 0.96, n: 2.2 },
          { z: 0.75, hw: 0.18, top: 1.16, bottom: 1.04, n: 2.2 },
          { z: 0.6, hw: 0.17, top: 1.14, bottom: 1.03, n: 2.2 },
        ],
        14,
      ),
      glass,
    ),
  );

  // Tank and tail with a stripe each, the seat between them.
  const tank: LoftSection[] = [
    { z: 0.46, hw: 0.15, top: 1.0, bottom: 0.82, n: 2.6 },
    { z: 0.3, hw: 0.21, top: 1.08, bottom: 0.76, n: 2.6 },
    { z: 0.05, hw: 0.21, top: 1.06, bottom: 0.74, n: 2.6 },
    { z: -0.14, hw: 0.16, top: 0.95, bottom: 0.78, n: 2.6 },
  ];
  const tail: LoftSection[] = [
    { z: -0.12, hw: 0.17, top: 0.92, bottom: 0.72, n: 2.8 },
    { z: -0.5, hw: 0.16, top: 0.98, bottom: 0.79, n: 2.8 },
    { z: -0.82, hw: 0.12, top: 1.02, bottom: 0.86, n: 2.8 },
    { z: -0.96, hw: 0.08, top: 1.02, bottom: 0.92, n: 2.8 },
  ];
  g.add(mesh(loftGeometry(tank, 16), paint), mesh(loftGeometry(tail, 16), paint));
  g.add(mesh(stripe(tank, 0.04), accent), mesh(stripe(tail.slice(0, 3), 0.035), accent));
  g.add(rbox(dark, 0.26, 0.06, 0.38, 0, 0.865, -0.33, 0.025));

  // Engine, cylinder head and the clutch cover; frame spars from the steering head to the swingarm pivot.
  g.add(rbox(dark, 0.32, 0.36, 0.44, 0, 0.47, 0.09, 0.05));
  g.add(rbox(dark, 0.28, 0.14, 0.28, 0, 0.68, 0.2, 0.04));
  const cover = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 16), chrome, -0.17, 0.42, 0.1);
  cover.rotation.z = Math.PI / 2;
  g.add(cover);
  for (const s of [-1, 1]) {
    g.add(strut(dark, [s * 0.13, 0.9, 0.44], [s * 0.15, 0.52, -0.1], 0.035));
    // Footpeg on its hanger.
    g.add(rbox(dark, 0.02, 0.14, 0.12, s * 0.12, 0.47, -0.27, 0.01));
    g.add(strut(chrome, [s * 0.11, 0.42, -0.3], [s * 0.22, 0.42, -0.3], 0.014, 6));
    // Mirror on a stalk.
    g.add(strut(dark, [s * 0.24, 0.98, 0.7], [s * 0.3, 1.03, 0.66], 0.012, 6));
    g.add(rbox(dark, 0.09, 0.05, 0.04, s * 0.31, 1.04, 0.65, 0.015));
  }

  // Exhaust: header under the engine to a side muffler on the right, clear of the swingarm.
  g.add(
    mesh(
      tubeGeometry(
        [
          [-0.06, 0.32, 0.29],
          [-0.1, 0.22, 0.05],
          [-0.16, 0.3, -0.3],
          [-0.22, 0.62, -0.5],
        ],
        0.035,
        20,
      ),
      chrome,
    ),
  );
  const muffler = mesh(new THREE.CylinderGeometry(0.065, 0.06, 0.42, 14), chrome, -0.22, 0.62, -0.66);
  muffler.rotation.x = Math.PI / 2;
  g.add(muffler);
  exhaustTip(g, chrome, dark, -0.22, 0.62, TIP_Z, 0.05);

  // Lamps: twin round heads in the nose, a light bar in the tail.
  if (m.head && m.tail) {
    for (const s of [-1, 1]) roundLamp(g, m.head, dark, s * 0.05, 0.86, 1.085, 0.035);
    g.add(rbox(m.tail, 0.12, 0.04, 0.02, 0, 0.97, -0.965, 0.01));
  }

  buildRider(g, m);
}

/**
 * The rider in a racing tuck, in the ground frame (design units): torso, helmet, arms to the grips at
 * (+-0.28, 0.875, 0.41) and legs to the pegs at (+-0.19, 0.45, -0.24). Also drawn on the realistic bike
 * (modelVisual.ts), placed on its seat.
 */
export function buildRider(g: THREE.Group, m: CarMats): void {
  const { paint, dark } = m;
  // The rider in a racing tuck, suited in the paint colour (a white helmet stands out against it):
  // torso over the tank, helmet just behind the screen.
  g.add(
    mesh(
      loftGeometry(
        [
          { z: -0.4, hw: 0.16, top: 1.01, bottom: 0.86, n: 2.4 },
          { z: -0.24, hw: 0.19, top: 1.09, bottom: 0.87, n: 2.4 },
          { z: -0.02, hw: 0.21, top: 1.18, bottom: 0.95, n: 2.4 },
          { z: 0.14, hw: 0.22, top: 1.24, bottom: 1.03, n: 2.4 },
          { z: 0.23, hw: 0.18, top: 1.24, bottom: 1.1, n: 2.4 },
        ],
        16,
      ),
      paint,
    ),
  );
  driver(g, m, 0, 1.32, 0.29, 0.145);
  for (const s of [-1, 1]) {
    // Shoulder, upper arm, elbow and forearm down to the grip.
    g.add(mesh(new THREE.SphereGeometry(0.085, 12, 8), paint, s * 0.17, 1.17, 0.15));
    g.add(strut(paint, [s * 0.18, 1.17, 0.16], [s * 0.25, 1.03, 0.3], 0.058));
    g.add(mesh(new THREE.SphereGeometry(0.058, 10, 8), paint, s * 0.25, 1.03, 0.3));
    g.add(strut(paint, [s * 0.25, 1.03, 0.3], [s * 0.275, 0.9, 0.4], 0.05));
    g.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), dark, s * 0.28, 0.875, 0.41));
    // Thigh along the tank, knee against it, shin back to the peg.
    g.add(strut(paint, [s * 0.11, 0.93, -0.27], [s * 0.24, 0.8, 0.04], 0.085));
    g.add(mesh(new THREE.SphereGeometry(0.085, 12, 8), paint, s * 0.24, 0.8, 0.04));
    g.add(strut(paint, [s * 0.24, 0.8, 0.04], [s * 0.19, 0.48, -0.25], 0.065));
    g.add(rbox(dark, 0.1, 0.11, 0.24, s * 0.19, 0.45, -0.24, 0.03));
  }
}

/** Fork legs, axle and front fender, in the front pivot's raked frame (origin at the axle, +y up the fork). */
function buildForkLegs(g: THREE.Group, m: CarMats): void {
  for (const s of [-1, 1]) g.add(strut(m.dark, [s * 0.105, -0.06, 0], [s * 0.105, 0.4, 0], 0.036));
  g.add(strut(m.dark, [-0.14, 0, 0], [0.14, 0, 0], 0.025, 8));
  // A short fender over the front and top of the tyre (level in the body frame, tipped a little forward).
  const fender = fenderGeometry(0, R0 + 0.025, R0 + 0.05, 0.2, -0.075, 0.075, 0, 0.01);
  fender.rotateX(RAKE + 0.25);
  g.add(mesh(fender, m.paint));
}

/** Fork tubes, triple clamps and clip-on bars, in the steering frame (origin at the front axle at rest, +y up the fork). */
function buildBars(g: THREE.Group, m: CarMats): void {
  for (const s of [-1, 1]) {
    g.add(strut(m.chrome, [s * 0.105, 0.2, 0], [s * 0.105, 0.7, 0], 0.028));
    g.add(strut(m.dark, [s * 0.12, 0.64, 0], [s * 0.25, 0.62, -0.08], 0.02, 6));
    g.add(strut(m.dark, [s * 0.24, 0.62, -0.075], [s * 0.31, 0.61, -0.1], 0.026));
  }
  g.add(rbox(m.dark, 0.3, 0.05, 0.1, 0, 0.56, -0.01, 0.015, 1));
  g.add(rbox(m.dark, 0.3, 0.04, 0.12, 0, 0.69, -0.02, 0.015, 1));
}

/** Swingarm from its pivot back to the rear axle along -z (rotated about x to meet the axle). */
function buildSwingarm(g: THREE.Group, m: CarMats): void {
  for (const s of [-1, 1]) g.add(rbox(m.dark, 0.05, 0.09, SWING_L + 0.05, s * 0.13, 0, -SWING_L / 2, 0.02, 1));
  g.add(rbox(m.dark, 0.3, 0.07, 0.07, 0, 0, -0.12, 0.02, 1));
  g.add(strut(m.dark, [-0.17, 0, -SWING_L], [0.17, 0, -SWING_L], 0.022, 8));
}

/** Hood camera eye for a bike spec: height above the ground and z (m). */
export function bikeEye(spec: VehicleSpec = vehicleSpec('bike')): { h: number; z: number } {
  const s = spec.wheelRadius / R0;
  return { h: EYE.h * s, z: EYE.z * s };
}

/** A bike tyre: round crown (shoulders of nearly half the width). */
function bikeTyre(w: number, R: number): THREE.BufferGeometry {
  return cachedGeometry(`bike-tyre:${w}:${R}`, () => tyreGeometry(w, R, undefined, w * 0.42));
}

/** The front wheel rides on the front pair of rays, the rear wheel on the rear pair. */
const BIKE_WHEEL_SRC: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3],
];
const BIKE_STEERED: readonly boolean[] = [true, false];

/**
 * The bike for a class's physics geometry (the bike's spec by default): wheel radius and ride height
 * come from it, so the drawn wheels sit on its suspension rays.
 */
export function buildBike(color = '#e8452c', ghost = false, spec: VehicleSpec = vehicleSpec('bike')): CarVisual {
  const R = spec.wheelRadius;
  const rh = spec.rideHeight;
  const s = R / R0;
  const t = bikeTemplate(ghost);
  const m = makeMats(color, ghost);

  // root > lean (on the ground under the centre) > inner (back at the centre: the body frame) >
  // frame (on the ground again, scaled: the drawn parts) and the wheel pivots.
  const root = new THREE.Group();
  const lean = new THREE.Group();
  lean.position.y = -rh;
  root.add(lean);
  const inner = new THREE.Group();
  inner.position.y = rh;
  lean.add(inner);
  const frame = new THREE.Group();
  frame.position.y = -rh;
  frame.scale.setScalar(s);
  inner.add(frame);
  addParts(frame, t.shell, m, ghost);
  const steer = new THREE.Group();
  steer.name = 'bars';
  steer.position.set(0, R0, BIKE_FRONT_Z);
  steer.rotation.x = -RAKE;
  frame.add(steer);
  addParts(steer, t.steer, m, ghost);
  const swing = new THREE.Group();
  swing.name = 'swingarm';
  swing.position.set(0, SWING_H, SWING_Z);
  frame.add(swing);
  addParts(swing, t.swing, m, ghost);
  const flames = addFlames(frame, m, [FLAME], false, 0.08);

  // Wheels, centred on the bike; the front pivot is raked, so it steers about the fork axis.
  const restY = R - rh;
  const wheels: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  [BIKE_FRONT_Z, BIKE_REAR_Z].forEach((z, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, restY, z * s);
    if (i === 0) pivot.rotation.x = -RAKE;
    inner.add(pivot);
    const w = TYRE_W[i] * s;
    const wheel = new THREE.Group();
    const tyre = new THREE.Mesh(bikeTyre(w, R).clone(), m.tyre);
    tyre.castShadow = !ghost;
    wheel.add(tyre, new THREE.Mesh(wheelGeometry('rim', w, undefined, R, 6).clone(), m.dark));
    pivot.add(wheel);
    wheels.push(wheel);
    pivots.push(pivot);
  });
  const fork = new THREE.Group();
  fork.scale.setScalar(s);
  pivots[0].add(fork);
  addParts(fork, t.fork, m, ghost);

  const [front, rear] = pivots;
  const update = (): void => {
    // The front wheel slides up the raked fork; the tubes and bars turn with it.
    front.position.z = BIKE_FRONT_Z * s - (front.position.y - restY) * TAN_RAKE;
    steer.rotation.y = front.rotation.y;
    // The swingarm swings about its pivot to the rear axle.
    const lim = SWING_L * 0.95;
    const dh = Math.min(lim, Math.max(-lim, (rear.position.y - restY) / s + R0 - SWING_H));
    const dz = Math.sqrt(SWING_L * SWING_L - dh * dh);
    rear.position.z = (SWING_Z - dz) * s;
    swing.rotation.x = Math.atan2(dh, dz);
  };
  update();

  const physBase = spec.wheels[0].z - spec.wheels[2].z;

  return {
    vehicle: 'bike',
    body: null,
    root,
    lamps: frame,
    wheels,
    pivots,
    wheelSrc: BIKE_WHEEL_SRC,
    steered: BIKE_STEERED,
    // The same path needs less lock on the drawn wheelbase than on the physics one.
    steerScale: physBase > 0 ? Math.min(1, ((BIKE_FRONT_Z - BIKE_REAR_Z) * s) / physBase) : 1,
    maxRise: MAX_RISE * s,
    lean,
    roll: null,
    top: partsTop(t.shell) * s - rh,
    flames,
    lights: ghost ? [] : t.lights,
    update,
    setColor(hex: string) {
      m.paint.color.set(hex);
    },
    dispose() {
      disposeTree(root);
    },
  };
}
