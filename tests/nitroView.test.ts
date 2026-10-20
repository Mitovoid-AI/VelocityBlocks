// What the Nitro button and the HUD ring show (src/ui/nitroView.ts), from the car's nitro timers.

import { describe, expect, it } from 'vitest';
import { DT } from '../src/core/constants';
import { NITRO_RECHARGE, NITRO_TIME } from '../src/physics/vehicle';
import { nitroView } from '../src/ui/nitroView';

describe('nitroView', () => {
  it('ready: a full ring', () => {
    expect(nitroView(0, 0)).toEqual({ state: 'ready', p: 1, secondsLeft: 0 });
  });

  it('boosting: the ring empties with the push', () => {
    expect(nitroView(NITRO_TIME, 0)).toEqual({ state: 'boosting', p: 1, secondsLeft: 0 });
    expect(nitroView(NITRO_TIME / 2, 0).p).toBeCloseTo(0.5, 12);
    expect(nitroView(DT, 0)).toMatchObject({ state: 'boosting' });
    // The push wins over a cooldown left from a respawn's bookkeeping.
    expect(nitroView(1, 3).state).toBe('boosting');
  });

  it('recharging: the ring fills over the 6 s and counts the seconds down from 6 to 1', () => {
    expect(NITRO_RECHARGE).toBe(6);
    expect(nitroView(0, NITRO_RECHARGE)).toEqual({ state: 'recharging', p: 0, secondsLeft: 6 });
    expect(nitroView(0, 5.99)).toMatchObject({ secondsLeft: 6 });
    expect(nitroView(0, 5)).toMatchObject({ secondsLeft: 5 });
    expect(nitroView(0, 4.5).p).toBeCloseTo(0.25, 12);
    expect(nitroView(0, 0.01)).toMatchObject({ state: 'recharging', secondsLeft: 1 });
    // Every tick of a whole recharge, as the physics counts it (whole ticks, rounded).
    let prev = -1;
    const shown = new Set<number>();
    for (let k = Math.round(NITRO_RECHARGE / DT); k > 0; k--) {
      const v = nitroView(0, k * DT);
      expect(v.p).toBeGreaterThan(prev - 1e-12);
      prev = v.p;
      shown.add(v.secondsLeft);
    }
    expect([...shown].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
