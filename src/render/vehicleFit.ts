// Fitting a realistic model (src/core/vehicleModels.ts) onto a vehicle class: one uniform scale and an
// offset, from its wheels and its overall size. Pure math (no three.js) so tests can check it directly.
//
// The scale is the smaller of the wheelbase fit (the drawn axles where the class draws them) and the
// envelope fit (the body inside the class's visual envelope, so a long nose does not push into barriers
// the hull never touches). Wheels are never scaled on their own: each keeps its own visual radius (rVis),
// and CarView stands it on its suspension ray by that radius, so a small tyre does not float and a big
// one does not sink.

import type { VehicleClass } from '../core/vehicles';
import type { VehicleSpec } from '../physics/vehicle';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** A wheel as measured in the model file: centre and radius (the model's units, canonical frame). */
export interface WheelBox {
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

/** Where a class draws its axles and the box its body must stay in (body frame, metres). */
export interface FitTarget {
  /** z of the drawn front and rear axles. */
  frontZ: number;
  rearZ: number;
  /** Settled height of the body centre above the road: the ground is at y = -rideHeight. */
  rideHeight: number;
  /** Visual envelope: nose and tail z, and half the width. */
  front: number;
  rear: number;
  halfWidth: number;
}

export interface Fit {
  scale: number;
  offset: V3;
  /** Each wheel's centre at rest (body frame) and its visual radius. */
  wheels: (V3 & { r: number })[];
}

/** The procedural bike's drawn axles (bikeMesh.ts BIKE_FRONT_Z/BIKE_REAR_Z, design wheel radius 0.33 m). */
const BIKE_AXLES = { front: 0.74, rear: -0.7, r0: 0.33 } as const;

/**
 * The fit target of a class from its physics geometry. Cars and trucks draw their axles on the physics
 * anchors; the bike draws a real bike's 1.44 m wheelbase inside its car-length footprint (bikeMesh.ts).
 * Envelopes: the car's is the procedural bodies' (tests/carBodies.test.ts: z -2.4..2.6), the truck's its
 * procedural cab and box plus a little, the bike's its procedural nose and tail plus a little.
 */
export function fitTarget(cls: VehicleClass, spec: VehicleSpec): FitTarget {
  const W = spec.wheels;
  if (cls === 'bike') {
    const s = spec.wheelRadius / BIKE_AXLES.r0;
    return { frontZ: BIKE_AXLES.front * s, rearZ: BIKE_AXLES.rear * s, rideHeight: spec.rideHeight, front: 1.25 * s, rear: -1.2 * s, halfWidth: 0.5 * s };
  }
  if (cls === 'truck') {
    return { frontZ: W[0].z, rearZ: W[2].z, rideHeight: spec.rideHeight, front: W[0].z + 1.05, rear: W[2].z - 1.15, halfWidth: Math.abs(W[0].x) + 0.15 };
  }
  return { frontZ: W[0].z, rearZ: W[2].z, rideHeight: spec.rideHeight, front: 2.6, rear: -2.4, halfWidth: Math.abs(W[0].x) + 0.1 };
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Fit a model: `wheels` in physics order (front ones first, `frontCount` of them), `min`/`max` its whole
 * bounding box. Throws when the front wheels are not ahead of the rear ones (a model facing backwards).
 */
export function fitVehicle(wheels: readonly WheelBox[], frontCount: number, min: V3, max: V3, t: FitTarget): Fit {
  if (wheels.length <= frontCount || frontCount < 1) throw new Error('fitVehicle: need front and rear wheels');
  const fz = mean(wheels.slice(0, frontCount).map((w) => w.cz));
  const rz = mean(wheels.slice(frontCount).map((w) => w.cz));
  if (!(fz - rz > 1e-6)) throw new Error('fitVehicle: front wheels must be ahead (+z) of the rear ones (check the yaw)');
  const wheelbase = (t.frontZ - t.rearZ) / (fz - rz);
  const envelope = Math.min((t.front - t.rear) / Math.max(1e-6, max.z - min.z), (2 * t.halfWidth) / Math.max(1e-6, max.x - min.x));
  const scale = Math.min(wheelbase, envelope);
  // Every tyre on the ground: the mean ground line of the wheels goes to y = -rideHeight.
  const ground = mean(wheels.map((w) => w.cy - w.r));
  const offset: V3 = {
    x: -mean(wheels.map((w) => w.cx)) * scale,
    y: -t.rideHeight - ground * scale,
    z: (t.frontZ + t.rearZ) / 2 - ((fz + rz) / 2) * scale,
  };
  // A body scaled to the envelope may still sit off it (a long nose, a short tail): slide it inside.
  const lo = min.z * scale + offset.z;
  const hi = max.z * scale + offset.z;
  if (hi > t.front && lo < t.rear) offset.z += (t.front + t.rear) / 2 - (lo + hi) / 2;
  else if (hi > t.front) offset.z -= Math.min(hi - t.front, lo - t.rear);
  else if (lo < t.rear) offset.z += Math.min(t.rear - lo, t.front - hi);
  return {
    scale,
    offset,
    wheels: wheels.map((w) => ({ x: w.cx * scale + offset.x, y: w.cy * scale + offset.y, z: w.cz * scale + offset.z, r: w.r * scale })),
  };
}

/**
 * How far a wheel may rise above its rest height before its tyre meets the bodywork (CarVisual.maxRise):
 * the smallest gap between a tyre top and the body above it, less a margin, kept within [min, max].
 */
export function riseLimit(gaps: readonly number[], margin = 0.01, lo = 0.02, hi = 0.3): number {
  const g = gaps.length ? Math.min(...gaps) - margin : hi;
  return Math.min(hi, Math.max(lo, g));
}
