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
/** Degrees either side of straight ahead that steer nothing: the default (the feel of earlier builds). */
export const TILT_DEAD_DEG = 1.5;
/** The most dead zone the Tilt steering screen offers (settings.tiltDeadzone). */
export const TILT_DEAD_MAX = 6;
/**
 * Centre feel at its strongest (settings.tiltCurve 1): the cubic's share in (1-e)x + e x^3, so
 * the steering near straight ahead is 70% gentler while full lock stays at the same tilt.
 */
export const TILT_CURVE_EXPO = 0.7;
/** Smoothing default (settings.tiltSmoothing): the light average of earlier builds. */
export const TILT_SMOOTH_DEFAULT = 0.5;
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
 * The raw roll to filter for a reading: the reading itself, or while the device lies nearly flat
 * (no meaningful roll) a tenth of the way from the last raw roll back to `center`, so the steering
 * fades back to straight ahead. The first reading always gives a value, so a working sensor is
 * found even then.
 */
export function rawRoll(prev: number | null, r: TiltReading, center: number): number {
  if (r.conf >= TILT_MIN_CONF) return r.roll;
  return prev === null ? center : angleDiff(prev + angleDiff(center, prev) * 0.1, 0);
}

/** The filter takes a reading as it is after a gap this long (a stalled sensor, the app was away). */
const ROLL_GAP_S = 0.25;
/** ...or after a jump this big (a 90/270 landscape flip). */
const ROLL_JUMP_DEG = 45;
/** How much faster the filter lets a turning device through (Hz per degree a second), and the speed estimate's cutoff. */
const ROLL_BETA = 0.05;
const ROLL_DCUTOFF = 1;
/** devicemotion's raw gravity is noisier than the fused orientation sensor: its cutoff is halved. */
export const MOTION_SMOOTH_SCALE = 0.5;

/**
 * Smoothing 0..1 (settings.tiltSmoothing) to the roll filter's resting cutoff in Hz: 0 is no
 * filter at all, 0.5 is 9.5 Hz (the half-and-half average of earlier builds at 60 readings a
 * second), 1 is 1 Hz (steady, with some lag).
 */
export function smoothingCutoff(s: number): number {
  const v = Number.isFinite(s) ? clamp(s, 0, 1) : TILT_SMOOTH_DEFAULT;
  return v <= 0 ? Infinity : 90 * Math.pow(90, -v);
}

/**
 * The smoothed roll: a One Euro filter (steady while the device is held still, quick while it
 * turns) that runs on time, not per reading. Chromium sends deviceorientation only when an angle
 * moves 0.1 degrees, so a device that stops dead sends nothing more: advance() lets the value
 * settle on the last reading between events.
 */
export class RollFilter {
  /** Resting cutoff in Hz (smoothingCutoff); Infinity passes every reading straight through. */
  cutoff = smoothingCutoff(TILT_SMOOTH_DEFAULT);
  private x: number | null = null;
  private dx = 0;
  /** When the value was last brought up to date (performance.now() ms). */
  private t = 0;

  /** The smoothed roll; null until the first reading (and after reset). */
  get value(): number | null {
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  /** A sensor reading at `ms`. `scale` lowers the cutoff for a noisier source (MOTION_SMOOTH_SCALE). */
  push(roll: number, ms: number, scale = 1): number {
    return this.step(roll, ms, scale, true);
  }

  /** No new reading: the value glides on towards `roll` (the last one) up to `ms`. */
  advance(roll: number, ms: number, scale = 1): number | null {
    return this.x === null ? null : this.step(roll, ms, scale, false);
  }

  private step(roll: number, ms: number, scale: number, reading: boolean): number {
    const x = this.x;
    let dt = (ms - this.t) / 1000;
    const d = x === null ? 0 : angleDiff(roll, x);
    // The first reading, no smoothing, a stalled sensor or a landscape flip: take the reading as it is.
    if (x === null || this.cutoff === Infinity || dt > ROLL_GAP_S || Math.abs(d) > ROLL_JUMP_DEG) {
      this.x = angleDiff(roll, 0);
      this.dx = 0;
      this.t = ms;
      return this.x;
    }
    if (dt < 0.004) {
      // Several calls in one frame: time has not moved on. Readings delivered together (and test
      // stubs, which fire synchronously) still count as one sensor period each.
      if (!reading) return x;
      dt = 1 / 60;
    }
    this.t = ms;
    const alpha = (fc: number) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
    this.dx += alpha(ROLL_DCUTOFF) * (d / dt - this.dx);
    this.x = angleDiff(x + alpha(this.cutoff * scale + ROLL_BETA * Math.abs(this.dx)) * d, 0);
    return this.x;
  }
}

/** Degrees of roll for full lock: 35 (sensitivity 0, gentle) .. 12 (sensitivity 1, sharp). */
export const tiltLockDeg = (sens: number): number => 35 - 23 * clamp(sens, 0, 1);

/** Tilt sensitivity 0..1 as the 1.0 .. 9.0 shown beside the slider (the 1..9 steps of earlier builds). */
export const sensLabel = (sens: number): string => (1 + 8 * clamp(Number.isFinite(sens) ? sens : 0.5, 0, 1)).toFixed(1);

/**
 * Steering -1..1 from the roll, the straight-ahead roll and the sensitivity (0..1), with a dead
 * zone in degrees (0..TILT_DEAD_MAX) and a centre feel (0 linear .. 1 gentle near straight ahead).
 * Full lock is at the same roll whatever the dead zone and centre feel; 0 centre feel is exactly
 * the linear mapping of earlier builds.
 */
export function steerFromRoll(roll: number, center: number, sens: number, dead = TILT_DEAD_DEG, curve = 0): number {
  const d = angleDiff(roll, center);
  const a = Math.abs(d);
  const dz = clamp(Number.isFinite(dead) ? dead : TILT_DEAD_DEG, 0, TILT_DEAD_MAX);
  if (a <= dz) return 0;
  const x = Math.min(1, (a - dz) / Math.max(1, tiltLockDeg(sens) - dz));
  const e = clamp(Number.isFinite(curve) ? curve : 0, 0, 1) * TILT_CURVE_EXPO;
  return Math.sign(d) * (e === 0 ? x : (1 - e) * x + e * x * x * x);
}

/** The straight-ahead roll a recentre stores for the current roll. */
export const clampCenter = (roll: number): number => clamp(roll, -TILT_CENTER_MAX, TILT_CENTER_MAX);
