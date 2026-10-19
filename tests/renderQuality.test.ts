import { describe, expect, it } from 'vitest';
import { pixelRatioFor, QUALITY, type Quality } from '../src/render/quality';

const TIERS: Quality[] = ['low', 'medium', 'high'];

describe('quality tiers', () => {
  it('keeps the shipped pixel-ratio caps (1, 1.5, 2)', () => {
    // A 20:9 phone at DPR 2.75 and a plain 1x desktop.
    expect(TIERS.map((q) => pixelRatioFor(q, 2.75))).toEqual([1, 1.5, 2]);
    expect(TIERS.map((q) => pixelRatioFor(q, 1))).toEqual([1, 1, 1]);
    expect(pixelRatioFor('high', 1.25)).toBe(1.25);
  });

  it('never exceeds the device ratio and survives junk input', () => {
    for (const q of TIERS) {
      for (const d of [0.5, 0.75, 1, 1.5, 2, 3, 4]) {
        const r = pixelRatioFor(q, d);
        expect(r).toBeLessThanOrEqual(d);
        expect(r).toBeGreaterThan(0);
      }
    }
    for (const bad of [0, -1, NaN, Infinity]) expect(pixelRatioFor('medium', bad)).toBe(1);
  });

  it('only scales up from low to high', () => {
    const keys = ['maxDpr', 'envSize', 'shadowMap', 'anisotropy', 'trees', 'standRows'] as const;
    for (const k of keys) {
      expect(QUALITY.low[k], k).toBeLessThanOrEqual(QUALITY.medium[k]);
      expect(QUALITY.medium[k], k).toBeLessThanOrEqual(QUALITY.high[k]);
    }
  });

  it('grounds cars without shadows on low, halos everywhere, bloom only on high', () => {
    expect(QUALITY.low.shadows).toBe(false);
    expect(QUALITY.low.contactOpacity).toBeGreaterThan(0);
    for (const q of TIERS) expect(QUALITY[q].halos).toBe(true);
    expect(TIERS.filter((q) => QUALITY[q].bloom)).toEqual(['high']);
    expect(TIERS.filter((q) => QUALITY[q].cheapGround)).toEqual(['low']);
  });

  it('bakes no environment on low (hemisphere light only), and one on medium and high', () => {
    expect(QUALITY.low.envSize).toBe(0);
    expect(QUALITY.medium.envSize).toBeGreaterThan(0);
    expect(QUALITY.high.envSize).toBeGreaterThan(0);
  });

  it('has a shadow box exactly where shadows are on, with a soft but not grainy radius', () => {
    for (const q of TIERS) {
      const p = QUALITY[q];
      expect(p.shadowExtent > 0).toBe(p.shadows);
      expect(p.shadowRadius).toBeLessThanOrEqual(1.5);
    }
  });
});
