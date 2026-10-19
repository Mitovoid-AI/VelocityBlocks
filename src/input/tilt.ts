// Tilt steering math: how far the device is turned like a steering wheel, from its sensors.
// Pure (no DOM), so it is unit-tested (tests/tilt.test.ts). Input wires it to the sensor events.
//
// Everything goes through the gravity direction ("up") in device axes (x right, y up, z out of
// the screen, as the device is held naturally). The roll is the angle of "up" within the screen
// plane, measured against the screen's own axes, so it is the same:
// - however far the device is tipped back (the old beta reading shrank and then flipped as the
//   device was held upright or just past it, slamming the steering to full lock);
// - in both landscapes, and on tablets whose natural orientation is landscape.

const D2R = Math.PI / 180;

/** Below this (device nearly flat) the roll means nothing: the steering fades back to straight. */
export const TILT_MIN_CONF = 0.3;
/** Degrees either side of straight ahead that steer nothing. */
export const TILT_DEAD_DEG = 1.5;
/** A recentre accepts a straight-ahead roll of at most this many degrees. */
export const TILT_CENTER_MAX = 30;

/** One sensor reading: roll in degrees (+ = turned right / clockwise), and how upright the screen is (0..1). */
export interface TiltReading {
  roll: number;
  conf: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** a - b in degrees, wrapped to -180..180. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/** The screen's rotation from the device's natural orientation: 0, 90, 180 or 270 (-90 becomes 270). */
export function screenAngle(): number {
  const so = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined;
  const wo = typeof window !== 'undefined' ? (window as unknown as { orientation?: number }).orientation : undefined;
  // `??`, not `||`: 0 is a real angle.
  const a = so ?? wo ?? 90;
  if (typeof a !== 'number' || !Number.isFinite(a)) return 90;
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
}

/**
 * Roll from the up direction in device axes (any length). The screen's right and up axes in
 * device coordinates are (cos t, -sin t, 0) and (sin t, cos t, 0) for screen angle t.
 */
export function rollFromUp(ux: number, uy: number, uz: number, angle: number): TiltReading | null {
  const n = Math.hypot(ux, uy, uz);
  if (!(n > 1e-6)) return null;
  const t = angle * D2R;
  // Up against the screen's left and up axes: turning the device clockwise tips up towards the screen's left.
  const left = (uy * Math.sin(t) - ux * Math.cos(t)) / n;
  const up = (ux * Math.sin(t) + uy * Math.cos(t)) / n;
  return { roll: Math.atan2(left, up) / D2R, conf: Math.hypot(left, up) };
}

/** Roll from a deviceorientation event (W3C beta/gamma in degrees; alpha drops out). Null when there is no reading. */
export function tiltRoll(beta: number | null | undefined, gamma: number | null | undefined, angle: number): TiltReading | null {
  if (typeof beta !== 'number' || typeof gamma !== 'number' || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const b = beta * D2R;
  const g = gamma * D2R;
  return rollFromUp(-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g), angle);
}

/**
 * Roll from devicemotion's accelerationIncludingGravity, for devices whose deviceorientation
 * never answers (no gyroscope). Android reports the reaction to gravity (+z lying face up);
 * iOS reports the opposite sign, so pass `flip` there.
 */
export function motionRoll(
  x: number | null | undefined,
  y: number | null | undefined,
  z: number | null | undefined,
  angle: number,
  flip = false,
): TiltReading | null {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const s = flip ? -1 : 1;
  return rollFromUp(s * x, s * y, s * z, angle);
}

/**
 * The smoothed roll after a new reading: a light average against sensor jitter, a jump on a big
 * change (a 90/270 landscape flip), and a fade back to `center` while the device lies nearly
 * flat. The first reading always gives a value, so a working sensor is found even then.
 */
export function filterRoll(prev: number | null, r: TiltReading, center: number): number {
  if (r.conf < TILT_MIN_CONF) return prev === null ? center : prev + angleDiff(center, prev) * 0.1;
  if (prev === null || Math.abs(angleDiff(r.roll, prev)) > 45) return r.roll;
  return angleDiff(prev + angleDiff(r.roll, prev) * 0.5, 0);
}

/** Degrees of roll for full lock: 35 (sensitivity 0, gentle) .. 12 (sensitivity 1, sharp). */
export const tiltLockDeg = (sens: number): number => 35 - 23 * clamp(sens, 0, 1);

/** Steering -1..1 from the roll, the straight-ahead roll and the sensitivity (0..1). */
export function steerFromRoll(roll: number, center: number, sens: number): number {
  const d = angleDiff(roll, center);
  const a = Math.abs(d);
  if (a <= TILT_DEAD_DEG) return 0;
  return Math.sign(d) * Math.min(1, (a - TILT_DEAD_DEG) / (tiltLockDeg(sens) - TILT_DEAD_DEG));
}

/** The straight-ahead roll a recentre stores for the current roll. */
export const clampCenter = (roll: number): number => clamp(roll, -TILT_CENTER_MAX, TILT_CENTER_MAX);
