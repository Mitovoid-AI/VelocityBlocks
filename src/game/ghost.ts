// Ghosts: sampled car poses for a finished run, interpolated on playback, and when its nitro pushed (for
// replays, which show its flames; the PB ghost car in a race deliberately shows none).
// Poses (rather than inputs) are stored so a ghost replays identically on any device.

import { PHYSICS_VERSION, TICK_HZ, VEHICLE_REV } from '../core/constants';
import { qslerp, type Quat, type V3 } from '../core/vec';
import { isVehicleClass, type VehicleClass } from '../core/vehicles';
import { NITRO_TIME, type CarState } from '../physics/vehicle';

export const GHOST_INTERVAL = 2; // ticks between samples (50 Hz)
const STRIDE = 8; // x y z qx qy qz qw steer

export interface Ghost {
  physics: number;
  /** Vehicle class that drove it, and that class's VEHICLE_REV then (ghosts from before classes: car, 0). */
  vehicle: VehicleClass;
  rev: number;
  time: number;
  interval: number;
  cpTimes: number[];
  samples: Float32Array;
  /**
   * Race ticks the nitro pushed on, as [start, end) pairs (flames in replays). Missing or empty: none
   * (ghosts from before the nitro).
   */
  nitro?: number[];
}

export class GhostRecorder {
  private buf: number[] = [];
  private nitro: number[] = [];

  reset(): void {
    this.buf.length = 0;
    this.nitro = [];
  }

  /** Called on every racing tick (it samples every GHOST_INTERVAL ticks). */
  record(tick: number, car: CarState): void {
    // An odd count means a push is open.
    if ((car.nitroTime > 0) !== (this.nitro.length % 2 === 1)) this.nitro.push(tick);
    if (tick % GHOST_INTERVAL !== 0) return;
    const { pos, rot } = car;
    this.buf.push(pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w, car.steer);
  }

  finish(time: number, cpTimes: number[], vehicle: VehicleClass = 'car'): Ghost {
    const nitro = this.nitro.slice();
    if (nitro.length % 2 === 1) nitro.push(Math.round((time * TICK_HZ) / 1000) + 1);
    return {
      physics: PHYSICS_VERSION,
      vehicle,
      rev: VEHICLE_REV[vehicle],
      time,
      interval: GHOST_INTERVAL,
      cpTimes: cpTimes.slice(),
      samples: new Float32Array(this.buf),
      nitro,
    };
  }
}

/**
 * Seconds of nitro push left at race tick `tick` (fractional ticks allowed) of a ghost, as CarState.nitroTime
 * would read (0 when it is not pushing; a push cut short by braking reads as if it would have run on):
 * the flames and the camera's nitro kick in replays. The PB ghost car in a race shows no flames (ghosts
 * have none, carMesh.ts), so it does not read this.
 */
export function ghostNitro(g: Ghost, tick: number): number {
  const n = g.nitro;
  if (!n) return 0;
  for (let i = 0; i + 1 < n.length; i += 2) {
    if (tick >= n[i] && tick < n[i + 1]) return Math.max(1 / TICK_HZ, NITRO_TIME - (tick - n[i]) / TICK_HZ);
    if (n[i] > tick) break;
  }
  return 0;
}

export interface GhostPose {
  pos: V3;
  rot: Quat;
  steer: number;
}

export function samplesIn(g: Ghost): number {
  return Math.floor(g.samples.length / STRIDE);
}

/** A pose to pass to ghostPose as `out` (reused every frame, so playback allocates nothing). */
export const newGhostPose = (): GhostPose => ({ pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, steer: 0 });

const qa: Quat = { x: 0, y: 0, z: 0, w: 1 };
const qb: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Pose at a given race tick (fractional ticks allowed), written into `out` when one is given. */
export function ghostPose(g: Ghost, tick: number, out: GhostPose = newGhostPose()): GhostPose | null {
  const n = samplesIn(g);
  if (n === 0) return null;
  const f = Math.max(0, tick / g.interval);
  const i0 = Math.min(n - 1, Math.floor(f));
  const i1 = Math.min(n - 1, i0 + 1);
  const t = Math.min(1, f - i0);
  const a = i0 * STRIDE;
  const b = i1 * STRIDE;
  const s = g.samples;
  out.pos.x = s[a] + (s[b] - s[a]) * t;
  out.pos.y = s[a + 1] + (s[b + 1] - s[a + 1]) * t;
  out.pos.z = s[a + 2] + (s[b + 2] - s[a + 2]) * t;
  qa.x = s[a + 3];
  qa.y = s[a + 4];
  qa.z = s[a + 5];
  qa.w = s[a + 6];
  qb.x = s[b + 3];
  qb.y = s[b + 4];
  qb.z = s[b + 5];
  qb.w = s[b + 6];
  const r = qslerp(qa, qb, t);
  out.rot.x = r.x;
  out.rot.y = r.y;
  out.rot.z = r.z;
  out.rot.w = r.w;
  out.steer = s[a + 7] + (s[b + 7] - s[a + 7]) * t;
  return out;
}

/** Last tick covered by the ghost. */
export function ghostEndTick(g: Ghost): number {
  return (samplesIn(g) - 1) * g.interval;
}

// ---- Serialisation (base64 of the float buffer) ----

export function encodeGhost(g: Ghost): string {
  const bytes = new Uint8Array(g.samples.buffer, g.samples.byteOffset, g.samples.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  // A car ghost keeps the pre-class format byte for byte; other classes add their class and revision.
  const o: Record<string, unknown> = { p: g.physics, t: g.time, i: g.interval, c: g.cpTimes, s: btoa(bin) };
  if (g.vehicle !== 'car') {
    o.v = g.vehicle;
    o.r = g.rev;
  }
  if (g.nitro?.length) o.n = g.nitro;
  return JSON.stringify(o);
}

export function decodeGhost(text: string): Ghost | null {
  try {
    const o = JSON.parse(text);
    const bin = atob(o.s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return {
      physics: o.p,
      vehicle: isVehicleClass(o.v) ? o.v : 'car',
      rev: typeof o.r === 'number' ? o.r : 0,
      time: o.t,
      interval: o.i,
      cpTimes: o.c,
      samples: new Float32Array(bytes.buffer),
      nitro: Array.isArray(o.n) && o.n.every((t: unknown) => typeof t === 'number') ? o.n : [],
    };
  } catch {
    return null;
  }
}
