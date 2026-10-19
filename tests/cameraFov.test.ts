import { describe, expect, it } from 'vitest';
import { fitFov, FOV_KEEP } from '../src/render/cameraRig';

/** Horizontal FOV in degrees for a vertical FOV and an aspect ratio. */
const hfov = (v: number, aspect: number) => (2 * Math.atan(Math.tan((v * Math.PI) / 360) * aspect) * 180) / Math.PI;
const WIDE = 20 / 9;

describe('fitFov', () => {
  it('leaves 16:9 and narrower screens alone', () => {
    for (const v of [50, 66, 90]) {
      expect(fitFov(v, 16 / 9)).toBe(v);
      expect(fitFov(v, 4 / 3)).toBe(v);
      expect(fitFov(v, 9 / 16)).toBe(v);
    }
  });

  it("gives a 20:9 phone a 16:9 screen's horizontal FOV when nothing is kept", () => {
    for (const v of [50, 55, 66, 78, 90, 98]) {
      expect(hfov(fitFov(v, WIDE, 0), WIDE)).toBeCloseTo(hfov(v, 16 / 9), 9);
    }
  });

  it('keeps 30% of the requested FOV by default', () => {
    const fitted = fitFov(70, WIDE, 0);
    expect(fitted).toBeLessThan(70);
    expect(fitFov(70, WIDE)).toBeCloseTo(fitted + (70 - fitted) * FOV_KEEP, 9);
    expect(fitFov(70, WIDE, 1)).toBeCloseTo(70, 9);
  });

  it('is monotonic in the requested FOV and stays inside (0, 180)', () => {
    for (const aspect of [16 / 9, 2, WIDE, 2.4, 3]) {
      let last = 0;
      for (let v = 10; v <= 120; v += 2) {
        const f = fitFov(v, aspect);
        expect(f).toBeGreaterThan(last);
        expect(f).toBeLessThan(180);
        last = f;
      }
    }
  });
});
