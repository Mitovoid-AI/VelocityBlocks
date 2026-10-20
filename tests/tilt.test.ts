// Tilt steering math: the device's roll in the screen plane from deviceorientation or gravity.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  angleDiff,
  motionRoll,
  rawRoll,
  RollFilter,
  rollFromUp,
  screenAngle,
  sensLabel,
  smoothingCutoff,
  steerFromRoll,
  TILT_CURVE_EXPO,
  TILT_DEAD_DEG,
  TILT_DEAD_MAX,
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

  it('defaults to the linear mapping and dead zone of earlier builds, exactly', () => {
    for (const sens of [0, 0.3, 0.5, 1]) {
      for (let roll = -40; roll <= 40; roll += 0.7) {
        const a = Math.abs(roll);
        const old = a <= 1.5 ? 0 : Math.sign(roll) * Math.min(1, (a - 1.5) / (tiltLockDeg(sens) - 1.5));
        expect(steerFromRoll(roll, 0, sens)).toBe(old);
        expect(steerFromRoll(roll, 0, sens, TILT_DEAD_DEG, 0)).toBe(old);
      }
    }
  });

  it('honours a custom dead zone, clamped to 0..TILT_DEAD_MAX, with full lock where it was', () => {
    expect(steerFromRoll(2.9, 0, 0.5, 3)).toBe(0);
    expect(steerFromRoll(3.5, 0, 0.5, 3)).toBeGreaterThan(0);
    expect(steerFromRoll(0.2, 0, 0.5, 0)).toBeGreaterThan(0);
    expect(steerFromRoll(-0.2, 0, 0.5, -3)).toBeLessThan(0); // clamped to 0
    expect(steerFromRoll(TILT_DEAD_MAX + 0.5, 0, 0.5, 99)).toBeGreaterThan(0); // clamped to 6
    expect(steerFromRoll(TILT_DEAD_MAX, 0, 0.5, 99)).toBe(0);
    for (const dead of [0, 3, 6]) expect(steerFromRoll(tiltLockDeg(0.5), 0, 0.5, dead)).toBeCloseTo(1, 12);
  });

  it('centre feel: gentler near straight ahead, the same full lock, monotonic, symmetric', () => {
    const lock = tiltLockDeg(0.5);
    for (const curve of [0.25, 0.5, 1]) {
      expect(steerFromRoll(lock, 0, 0.5, 1.5, curve)).toBeCloseTo(1, 12);
      expect(steerFromRoll(-lock, 0, 0.5, 1.5, curve)).toBeCloseTo(-1, 12);
      expect(steerFromRoll(1.5, 0, 0.5, 1.5, curve)).toBe(0);
      let prev = 0;
      for (let r = 1.5; r <= lock + 5; r += 0.25) {
        const v = steerFromRoll(r, 0, 0.5, 1.5, curve);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(steerFromRoll(-r, 0, 0.5, 1.5, curve) + 0).toBe(-v + 0);
        prev = v;
      }
      // Near straight ahead the slope is (1 - e) of the linear one.
      const x = 0.01;
      const r = 1.5 + x * (lock - 1.5);
      expect(steerFromRoll(r, 0, 0.5, 1.5, curve) / steerFromRoll(r, 0, 0.5)).toBeCloseTo(1 - curve * TILT_CURVE_EXPO, 3);
    }
    // Out of range values are clamped; garbage is linear.
    expect(steerFromRoll(10, 0, 0.5, 1.5, 7)).toBe(steerFromRoll(10, 0, 0.5, 1.5, 1));
    expect(steerFromRoll(10, 0, 0.5, 1.5, Number.NaN)).toBe(steerFromRoll(10, 0, 0.5));
  });

  it('sensLabel shows the 1.0 .. 9.0 scale of the old steps', () => {
    expect(sensLabel(0)).toBe('1.0');
    expect(sensLabel(0.5)).toBe('5.0');
    expect(sensLabel(1)).toBe('9.0');
    expect(sensLabel(0.5125)).toBe('5.1');
    expect(sensLabel(7)).toBe('9.0');
    expect(sensLabel(Number.NaN)).toBe('5.0');
  });
});

describe('rawRoll', () => {
  const read = (roll: number, conf = 1) => ({ roll, conf });

  it('passes an upright reading through', () => {
    expect(rawRoll(null, read(10), 0)).toBe(10);
    expect(rawRoll(3, read(-170), 0)).toBe(-170);
  });

  it('fades back to straight ahead while the device lies flat', () => {
    expect(rawRoll(null, read(50, 0.1), 5)).toBe(5);
    let r = 20;
    for (let i = 0; i < 60; i++) r = rawRoll(r, read(90, 0.1), 5);
    expect(r).toBeCloseTo(5, 1);
    expect(TILT_MIN_CONF).toBeGreaterThan(0.1);
  });
});

describe('smoothingCutoff', () => {
  it('0 is no filter, 0.5 the light average of earlier builds (9.5 Hz), 1 is 1 Hz', () => {
    expect(smoothingCutoff(0)).toBe(Infinity);
    expect(smoothingCutoff(0.5)).toBeCloseTo(9.49, 2);
    expect(smoothingCutoff(1)).toBeCloseTo(1, 9);
    expect(smoothingCutoff(-1)).toBe(Infinity);
    expect(smoothingCutoff(3)).toBeCloseTo(1, 9);
    expect(smoothingCutoff(Number.NaN)).toBeCloseTo(9.49, 2);
    // Monotonic: more smoothing, lower cutoff.
    for (let s = 0.05; s < 1; s += 0.05) expect(smoothingCutoff(s + 0.05)).toBeLessThan(smoothingCutoff(s));
  });
});

describe('RollFilter', () => {
  const HZ = 60;
  /** Push readings of f(t) at 60 Hz for `ms` from t0; returns the filter's value after each. */
  function feed(f: RollFilter, roll: (t: number) => number, ms: number, t0 = 0): number[] {
    const out: number[] = [];
    for (let t = t0; t <= t0 + ms; t += 1000 / HZ) out.push(f.push(roll(t), t));
    return out;
  }

  it('takes the first reading exactly and forgets on reset', () => {
    const f = new RollFilter();
    expect(f.value).toBeNull();
    expect(f.push(12.5, 0)).toBe(12.5);
    f.reset();
    expect(f.value).toBeNull();
    expect(f.advance(3, 100)).toBeNull();
    expect(f.push(-7, 100)).toBe(-7);
  });

  it('at the default smoothing follows a step about as the half-and-half average of earlier builds did', () => {
    const f = new RollFilter();
    f.push(0, 0);
    const v = feed(f, () => 10, 300, 1000 / HZ);
    // The old average gave 5, 7.5, 8.75; the speed term lets a quick move through a little faster.
    expect(v[0]).toBeGreaterThan(4.5);
    expect(v[0]).toBeLessThan(7);
    // Within 0.2 degrees by 150 ms, and it never overshoots.
    expect(Math.abs(10 - v[Math.round(0.15 * HZ)])).toBeLessThan(0.2);
    for (const x of v) expect(x).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('heavier smoothing steadies a jittery reading; none passes it through', () => {
    const jitter = (t: number) => 10 + (Math.round(t / (1000 / HZ)) % 2 ? 1 : -1);
    const spread = (s: number) => {
      const f = new RollFilter();
      f.cutoff = smoothingCutoff(s);
      const v = feed(f, jitter, 2000).slice(60);
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread(0)).toBeCloseTo(2, 9);
    expect(spread(0.5)).toBeLessThan(1.2);
    expect(spread(1)).toBeLessThan(0.3);
    expect(spread(1)).toBeLessThan(spread(0.5));
  });

  it('keeps up with a steady turn (100 degrees a second) better than the average of earlier builds', () => {
    // That average lagged a ramp by rate x period (1.67 degrees here); the speed term cuts it.
    const f = new RollFilter();
    let lag = 0;
    for (let n = 0; n <= 24; n++) lag = (n * 100) / HZ - f.push((n * 100) / HZ, (n * 1000) / HZ);
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThan(1.67);
  });

  it('settles on the last reading as time goes by, with no new reading (Chromium sends none while still)', () => {
    const f = new RollFilter();
    f.cutoff = smoothingCutoff(1);
    f.push(0, 0);
    const after = f.push(10, 16);
    expect(after).toBeLessThan(5);
    expect(f.advance(10, 18)).toBe(after); // under 4 ms: no time has passed
    let v = after;
    for (let t = 32; t <= 1500; t += 16) v = f.advance(10, t)!;
    expect(v).toBeCloseTo(10, 1);
  });

  it('smooths across the -180/180 wrap', () => {
    const f = new RollFilter();
    f.push(178, 0);
    const v = f.push(-178, 16);
    expect(Math.abs(angleDiff(v, 180))).toBeLessThan(2);
  });

  it('takes the reading as it is after a jump over 45 degrees or a gap over 250 ms', () => {
    const f = new RollFilter();
    f.cutoff = smoothingCutoff(1);
    f.push(10, 0);
    expect(f.push(-170, 16)).toBe(-170); // a landscape flip
    expect(f.push(-150, 400)).toBe(-150); // the sensor stalled (app in the background)
  });

  it('counts readings delivered together (or synchronously) as one sensor period each', () => {
    const f = new RollFilter();
    f.push(0, 0);
    const a = f.push(10, 16.7);
    const g = new RollFilter();
    g.push(0, 5);
    expect(g.push(10, 5)).toBeCloseTo(a, 1);
  });

  it('a noisier source (scale < 1) is smoothed more', () => {
    const f = new RollFilter();
    f.push(0, 0);
    const g = new RollFilter();
    g.push(0, 0);
    expect(g.push(10, 16, 0.5)).toBeLessThan(f.push(10, 16));
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
