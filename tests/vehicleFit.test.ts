// Fitting realistic models onto a class (src/render/vehicleFit.ts): pure math.

import { describe, expect, it } from 'vitest';
import { vehicleSpec } from '../src/physics/vehicle';
import { fitTarget, fitVehicle, riseLimit, type FitTarget, type WheelBox } from '../src/render/vehicleFit';

const T: FitTarget = { frontZ: 1.45, rearZ: -1.35, rideHeight: 0.5, front: 2.6, rear: -2.4, halfWidth: 1.05 };
/** A car with a 2.6 m wheelbase, 1.6 m track, tyres of radius 0.33 standing on y = 0. */
function car(r = [0.33, 0.33, 0.33, 0.33]): WheelBox[] {
  return [
    { cx: 0.8, cy: r[0], cz: 1.3, r: r[0] },
    { cx: -0.8, cy: r[1], cz: 1.3, r: r[1] },
    { cx: 0.8, cy: r[2], cz: -1.3, r: r[2] },
    { cx: -0.8, cy: r[3], cz: -1.3, r: r[3] },
  ];
}
const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('fitVehicle', () => {
  it('scales the wheelbase onto the drawn axles and stands every tyre on the road', () => {
    const f = fitVehicle(car(), 2, v(-0.9, 0, -2), v(0.9, 1.3, 2), T);
    expect(f.scale).toBeCloseTo(2.8 / 2.6, 9);
    expect(f.wheels[0].z).toBeCloseTo(1.45, 9);
    expect(f.wheels[2].z).toBeCloseTo(-1.35, 9);
    for (const w of f.wheels) {
      expect(w.r).toBeCloseTo(0.33 * f.scale, 9);
      expect(w.y - w.r).toBeCloseTo(-T.rideHeight, 9);
    }
    expect(f.wheels[0].x).toBeCloseTo(0.8 * f.scale, 9);
  });

  it('keeps each wheel its own radius (no wheel scaling): front and rear tyres of different sizes', () => {
    const f = fitVehicle(car([0.3, 0.3, 0.36, 0.36]), 2, v(-0.9, 0, -2), v(0.9, 1.3, 2), T);
    expect(f.wheels[0].r).toBeCloseTo(0.3 * f.scale, 9);
    expect(f.wheels[2].r).toBeCloseTo(0.36 * f.scale, 9);
    // Their centres sit at their own radius above the road.
    for (const w of f.wheels) expect(w.y - w.r).toBeCloseTo(-T.rideHeight, 9);
  });

  it('takes the envelope fit when a long body would not fit the wheelbase fit', () => {
    // 6 m long at the wheelbase scale (2.8/2.6) would be 6.46 m: the 5 m envelope wins.
    const f = fitVehicle(car(), 2, v(-0.9, 0, -3), v(0.9, 1.3, 3), T);
    expect(f.scale).toBeCloseTo(5 / 6, 9);
    expect(-3 * f.scale + f.offset.z).toBeGreaterThanOrEqual(T.rear - 1e-9);
    expect(3 * f.scale + f.offset.z).toBeLessThanOrEqual(T.front + 1e-9);
    // And a body too wide for the class.
    const w = fitVehicle(car(), 2, v(-1.5, 0, -2), v(1.5, 1.3, 2), T);
    expect(w.scale).toBeCloseTo(2.1 / 3, 9);
  });

  it('slides a long nose back inside the envelope', () => {
    const f = fitVehicle(car(), 2, v(-0.9, 0, -1.6), v(0.9, 1.3, 2.9), T);
    expect(2.9 * f.scale + f.offset.z).toBeLessThanOrEqual(T.front + 1e-9);
    expect(-1.6 * f.scale + f.offset.z).toBeGreaterThanOrEqual(T.rear - 1e-9);
  });

  it('refuses a model facing backwards (front wheels behind)', () => {
    const back = car().map((w) => ({ ...w, cz: -w.cz }));
    expect(() => fitVehicle(back, 2, v(-1, 0, -2), v(1, 1, 2), T)).toThrow(/check the yaw/);
  });

  it('fits a two-wheel bike to the procedural bike axles', () => {
    const t = fitTarget('bike', vehicleSpec('bike'));
    const f = fitVehicle(
      [
        { cx: 0, cy: 0.34, cz: 0.75, r: 0.34 },
        { cx: 0, cy: 0.34, cz: -0.75, r: 0.34 },
      ],
      1,
      v(-0.4, 0, -1.1),
      v(0.4, 1.2, 1.1),
      t,
    );
    expect(f.wheels[0].z - f.wheels[1].z).toBeCloseTo(t.frontZ - t.rearZ, 9);
    expect(f.wheels[0].y - f.wheels[0].r).toBeCloseTo(-vehicleSpec('bike').rideHeight, 9);
  });

  it('targets the physics axles for cars and trucks', () => {
    for (const cls of ['car', 'truck'] as const) {
      const s = vehicleSpec(cls);
      const t = fitTarget(cls, s);
      expect(t.frontZ).toBe(s.wheels[0].z);
      expect(t.rearZ).toBe(s.wheels[2].z);
      expect(t.front).toBeGreaterThan(t.frontZ);
      expect(t.rear).toBeLessThan(t.rearZ);
    }
  });
});

describe('riseLimit', () => {
  it('is the smallest gap less a margin, kept in range', () => {
    expect(riseLimit([0.1, 0.05, 0.2])).toBeCloseTo(0.04, 9);
    expect(riseLimit([0])).toBe(0.02);
    expect(riseLimit([])).toBe(0.3);
    expect(riseLimit([2])).toBe(0.3);
  });
});
