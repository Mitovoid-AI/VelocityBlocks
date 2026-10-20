// A ghost's yaw rate (for a ghost or replayed bike's lean): smooth between samples, signed like
// the physics (+ turning left), and unbroken where the heading wraps past 180 degrees.

import { describe, expect, it } from 'vitest';
import { ghostYawRate } from '../src/app/replayMode';
import { DT, PHYSICS_VERSION } from '../src/core/constants';
import type { Ghost } from '../src/game/ghost';

/** A ghost turning at `w` rad/s from heading `h0`, one sample every 2 ticks. */
function turning(w: number, h0 = 0, n = 60): Ghost {
  const s = new Float32Array(n * 8);
  for (let k = 0; k < n; k++) {
    const h = h0 + w * k * 2 * DT;
    s.set([k, 0, 0, 0, Math.sin(h / 2), 0, Math.cos(h / 2), 0], k * 8);
  }
  return { physics: PHYSICS_VERSION, vehicle: 'bike', rev: 1, time: 1000, interval: 2, cpTimes: [], samples: s };
}

describe('ghostYawRate', () => {
  it('measures the turn between and on samples', () => {
    for (const w of [0.8, -1.5]) {
      const g = turning(w);
      for (const t of [10, 11, 11.5, 40]) expect(ghostYawRate(g, t)).toBeCloseTo(w, 3);
    }
  });

  it('is unbroken where the heading wraps, and 0 for a straight run', () => {
    expect(ghostYawRate(turning(2, Math.PI - 0.05), 4)).toBeCloseTo(2, 3);
    expect(ghostYawRate(turning(0), 20)).toBe(0);
  });

  it('copes with the ends of the recording', () => {
    const g = turning(1);
    expect(ghostYawRate(g, 0)).toBeCloseTo(1, 3);
    expect(ghostYawRate(g, 10_000)).toBe(0);
  });
});
