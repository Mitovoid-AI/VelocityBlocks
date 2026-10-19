// Tilt steering math: the device's roll in the screen plane from deviceorientation or gravity.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  angleDiff,
  filterRoll,
  motionRoll,
  rollFromUp,
  screenAngle,
  steerFromRoll,
  TILT_DEAD_DEG,
  TILT_MIN_CONF,
  tiltLockDeg,
  tiltRoll,
} from '../src/input/tilt';

const D2R = Math.PI / 180;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The up direction in device axes for a device held in screen orientation `angle`, tipped back
 * by `tip` degrees (top edge away, 0 = upright facing the player) and turned `roll` degrees
 * clockwise like a steering wheel.
 */
function pose(tip: number, roll: number, angle: number): [number, number, number] {
  const t = angle * D2R;
  const p = tip * D2R;
  const r = roll * D2R;
  const right = [Math.cos(t), -Math.sin(t), 0];
  const up = [Math.sin(t), Math.cos(t), 0];
  return [0, 1, 2].map((i) => Math.cos(p) * (-Math.sin(r) * right[i] + Math.cos(r) * up[i]) + (i === 2 ? Math.sin(p) : 0)) as [
    number,
    number,
    number,
  ];
}

/** W3C beta (-180..180) and gamma (-90..90) for an up direction in device axes. */
function euler([ux, uy, uz]: [number, number, number]): [number, number] {
  let g = Math.atan2(-ux, uz);
  let b = Math.asin(Math.max(-1, Math.min(1, uy)));
  if (g > Math.PI / 2 || g < -Math.PI / 2) {
    g = g > 0 ? g - Math.PI : g + Math.PI;
    b = (b >= 0 ? Math.PI : -Math.PI) - b;
  }
  return [b / D2R, g / D2R];
}

describe('tiltRoll', () => {
  it('reads the same turn however far the device is tipped back, in every orientation', () => {
    for (const angle of [90, 270, 0, 180]) {
      for (const tip of [0, 45, 60]) {
        for (const roll of [-20, 0, 10, 23.5]) {
          const [beta, gamma] = euler(pose(tip, roll, angle));
          const r = tiltRoll(beta, gamma, angle)!;
          expect(r.roll).toBeCloseTo(roll, 6);
          expect(r.conf).toBeCloseTo(Math.cos(tip * D2R), 6);
        }
      }
    }
  });

  it('matches the old beta reading upright in landscape (sign included)', () => {
    expect(tiltRoll(10, -90, 90)!.roll).toBeCloseTo(10, 6);
    expect(tiltRoll(10, 90, 270)!.roll).toBeCloseTo(-10, 6);
  });

  it('held just past upright (the Euler flip), a small turn stays small', () => {
    // The old code read these as full lock.
    expect(tiltRoll(170, 84.9, 90)!.roll).toBeCloseTo(10, 0);
    expect(tiltRoll(-170, 84.9, 90)!.roll).toBeCloseTo(-10, 0);
    expect(tiltRoll(180, 87, 90)!.roll).toBeCloseTo(0, 6);
    // Leaning 5 degrees past vertical, turned 10 degrees right.
    const [beta, gamma] = euler(pose(-5, 10, 90));
    expect(Math.abs(beta)).toBeGreaterThan(90);
    expect(tiltRoll(beta, gamma, 90)!.roll).toBeCloseTo(10, 6);
  });

  it('has no confidence lying flat', () => {
    expect(tiltRoll(0, 0, 90)!.conf).toBeLessThan(TILT_MIN_CONF);
  });

  it('gives null without a reading', () => {
    expect(tiltRoll(null, 10, 90)).toBeNull();
    expect(tiltRoll(10, undefined, 90)).toBeNull();
    expect(tiltRoll(Number.NaN, 0, 90)).toBeNull();
    expect(rollFromUp(0, 0, 0, 90)).toBeNull();
  });
});

describe('motionRoll (gravity, for devices without a gyroscope)', () => {
  it('reads Android gravity (the reaction, +z face up) like the orientation sensor', () => {
    const [x, y, z] = pose(30, 12, 90).map((v) => v * 9.81);
    expect(motionRoll(x, y, z, 90)!.roll).toBeCloseTo(12, 6);
  });

  it('flips the sign for iOS', () => {
    const [x, y, z] = pose(30, -8, 270).map((v) => -v * 9.81);
    expect(motionRoll(x, y, z, 270, true)!.roll).toBeCloseTo(-8, 6);
  });

  it('gives null without a reading', () => {
    expect(motionRoll(null, 1, 1, 90)).toBeNull();
    expect(motionRoll(1, Number.NaN, 1, 90)).toBeNull();
  });
});

describe('steerFromRoll', () => {
  it('steers nothing inside the dead zone', () => {
    expect(steerFromRoll(TILT_DEAD_DEG, 0, 0.5)).toBe(0);
    expect(steerFromRoll(-1, 0, 0.5)).toBe(0);
  });

  it('reaches full lock at 35 degrees (sensitivity 0) .. 12 (sensitivity 1)', () => {
    expect(tiltLockDeg(0)).toBe(35);
    expect(tiltLockDeg(1)).toBe(12);
    expect(steerFromRoll(35, 0, 0)).toBeCloseTo(1, 9);
    expect(steerFromRoll(30, 0, 0)).toBeLessThan(1);
    expect(steerFromRoll(-12, 0, 1)).toBeCloseTo(-1, 9);
    expect(steerFromRoll(80, 0, 0.5)).toBe(1);
    expect(steerFromRoll(-80, 0, 0.5)).toBe(-1);
  });

  it('measures from the straight-ahead roll', () => {
    expect(steerFromRoll(20, 20, 0.5)).toBe(0);
    expect(steerFromRoll(10, 20, 0.5)).toBeLessThan(0);
    expect(steerFromRoll(179.5, -179.5, 0.5)).toBe(0); // across the wrap: 1 degree apart
    expect(steerFromRoll(-170, 170, 0.5)).toBeGreaterThan(0); // 20 degrees clockwise of the centre
  });
});

describe('filterRoll', () => {
  const read = (roll: number, conf = 1) => ({ roll, conf });

  it('takes the first reading, then smooths small changes', () => {
    expect(filterRoll(null, read(10), 0)).toBe(10);
    expect(filterRoll(10, read(14), 0)).toBe(12);
  });

  it('jumps on a big change (a landscape flip)', () => {
    expect(filterRoll(10, read(-170), 0)).toBe(-170);
  });

  it('smooths across the -180/180 wrap', () => {
    expect(filterRoll(178, read(-178), 0)).toBeCloseTo(180, 9);
  });

  it('fades back to straight ahead while the device lies flat', () => {
    expect(filterRoll(null, read(50, 0.1), 5)).toBe(5);
    let r = 20;
    for (let i = 0; i < 60; i++) r = filterRoll(r, read(90, 0.1), 5);
    expect(r).toBeCloseTo(5, 1);
  });
});

describe('screenAngle', () => {
  it('reads screen.orientation, and turns -90 into 270', () => {
    vi.stubGlobal('screen', { orientation: { angle: -90 } });
    expect(screenAngle()).toBe(270);
    vi.stubGlobal('screen', { orientation: { angle: 0 } });
    expect(screenAngle()).toBe(0);
  });

  it('falls back to window.orientation, then to 90', () => {
    vi.stubGlobal('window', { orientation: 180 });
    expect(screenAngle()).toBe(180);
    vi.stubGlobal('window', {});
    expect(screenAngle()).toBe(90);
  });

  it('angleDiff wraps to -180..180', () => {
    expect(angleDiff(170, -170)).toBe(-20);
    expect(angleDiff(-170, 170)).toBe(20);
    expect(angleDiff(10, 370)).toBeCloseTo(0, 9);
  });
});
