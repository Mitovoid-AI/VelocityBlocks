// Ghosts: sampled car poses for a finished run, interpolated on playback.
// Poses (rather than inputs) are stored so a ghost replays identically on any device.

import { PHYSICS_VERSION } from '../core/constants';
import { qslerp, type Quat, type V3 } from '../core/vec';
import type { CarState } from '../physics/vehicle';

export const GHOST_INTERVAL = 2; // ticks between samples (50 Hz)
const STRIDE = 8; // x y z qx qy qz qw steer

export interface Ghost {
  physics: number;
  time: number;
  interval: number;
  cpTimes: number[];
  samples: Float32Array;
}

export class GhostRecorder {
  private buf: number[] = [];

  reset(): void {
    this.buf.length = 0;
  }

  record(tick: number, car: CarState): void {
    if (tick % GHOST_INTERVAL !== 0) return;
    const { pos, rot } = car;
    this.buf.push(pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w, car.steer);
  }

  finish(time: number, cpTimes: number[]): Ghost {
    return {
      physics: PHYSICS_VERSION,
      time,
      interval: GHOST_INTERVAL,
      cpTimes: cpTimes.slice(),
      samples: new Float32Array(this.buf),
    };
  }
}

export interface GhostPose {
  pos: V3;
  rot: Quat;
  steer: number;
}

export function samplesIn(g: Ghost): number {
  return Math.floor(g.samples.length / STRIDE);
}

/** Pose at a given race tick (fractional ticks allowed). */
export function ghostPose(g: Ghost, tick: number): GhostPose | null {
  const n = samplesIn(g);
  if (n === 0) return null;
  const f = Math.max(0, tick / g.interval);
  const i0 = Math.min(n - 1, Math.floor(f));
  const i1 = Math.min(n - 1, i0 + 1);
  const t = Math.min(1, f - i0);
  const a = i0 * STRIDE;
  const b = i1 * STRIDE;
  const s = g.samples;
  return {
    pos: {
      x: s[a] + (s[b] - s[a]) * t,
      y: s[a + 1] + (s[b + 1] - s[a + 1]) * t,
      z: s[a + 2] + (s[b + 2] - s[a + 2]) * t,
    },
    rot: qslerp(
      { x: s[a + 3], y: s[a + 4], z: s[a + 5], w: s[a + 6] },
      { x: s[b + 3], y: s[b + 4], z: s[b + 5], w: s[b + 6] },
      t,
    ),
    steer: s[a + 7] + (s[b + 7] - s[a + 7]) * t,
  };
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
  return JSON.stringify({ p: g.physics, t: g.time, i: g.interval, c: g.cpTimes, s: btoa(bin) });
}

export function decodeGhost(text: string): Ghost | null {
  try {
    const o = JSON.parse(text);
    const bin = atob(o.s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return {
      physics: o.p,
      time: o.t,
      interval: o.i,
      cpTimes: o.c,
      samples: new Float32Array(bytes.buffer),
    };
  } catch {
    return null;
  }
}
