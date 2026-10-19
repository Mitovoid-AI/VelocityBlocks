// Back-swipe exclusion rects over the touch controls, and the gesture-strip CSS variables.

import { describe, expect, it } from 'vitest';
import { edgeExclusionRects, gestureInsetVars, type Box } from '../src/input/edgeGuard';

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe('edgeExclusionRects', () => {
  const vw = 873;
  const vh = 393;

  it('stretches a left cluster to the left edge, with slack around it', () => {
    expect(edgeExclusionRects([box(18, 271, 240, 375)], vw, vh)).toEqual([{ l: 0, t: 247, r: 264, b: 393 }]);
  });

  it('stretches a right cluster to the right edge', () => {
    expect(edgeExclusionRects([box(vw - 240, 271, vw - 18, 375)], vw, vh)).toEqual([{ l: vw - 264, t: 247, r: vw, b: 393 }]);
  });

  it('gives nothing for hidden controls', () => {
    expect(edgeExclusionRects([box(0, 0, 0, 0), box(0, 0, 0, 0)], vw, vh)).toEqual([]);
    expect(edgeExclusionRects([], vw, vh)).toEqual([]);
  });

  it('keeps a tall side bar within the 200 dp cap, from the bottom up', () => {
    const [r] = edgeExclusionRects([box(30, 40, 100, 375)], vw, vh);
    expect(r.b).toBe(vh);
    expect(r.b - r.t).toBe(200);
  });

  it('shares the cap between boxes on one edge, the lower box first', () => {
    const low = box(30, 300, 110, 360);
    const high = box(30, 100, 110, 260);
    const rects = edgeExclusionRects([high, low], vw, vh);
    expect(rects[0]).toEqual({ l: 0, t: 276, r: 134, b: 384 }); // the lower box, whole
    expect(rects[1].b).toBe(284);
    expect(rects[1].b - rects[1].t).toBe(200 - 108);
    expect(rects.reduce((s, r) => s + r.b - r.t, 0)).toBe(200);
  });

  it('gives each side edge its own cap', () => {
    const rects = edgeExclusionRects([box(30, 40, 100, 375), box(vw - 100, 40, vw - 30, 375)], vw, vh);
    expect(rects.map((r) => r.b - r.t)).toEqual([200, 200]);
    expect(rects.map((r) => (r.l === 0 ? 'left' : r.r === vw ? 'right' : '?')).sort()).toEqual(['left', 'right']);
  });
});

describe('gestureInsetVars', () => {
  it('sets the four --gest-* variables in whole px', () => {
    expect(gestureInsetVars({ l: 24.4, r: 30, t: 24, b: 15.6 })).toEqual({
      '--gest-l': '24px',
      '--gest-r': '30px',
      '--gest-t': '24px',
      '--gest-b': '16px',
    });
  });

  it('clamps bogus values', () => {
    const v = gestureInsetVars({ l: -5, r: 500, t: Number.NaN, b: undefined as unknown as number });
    expect(v).toEqual({ '--gest-l': '0px', '--gest-r': '64px', '--gest-t': '0px', '--gest-b': '0px' });
  });
});
