// Paused and on the results the loop draws only every 4th / 2nd frame (RaceMode.renderEvery). A canvas
// resize (rotation, the governor's pixel ratio, an Auto tier change) clears the canvas, so the frame after
// one is always drawn (World.dirty), or the screen flashes black until the next drawn frame.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameSkip } from '../src/app/app';
import { World } from '../src/render/world';

afterEach(() => vi.unstubAllGlobals());

describe('FrameSkip', () => {
  it('draws every frame unless thinned, every n-th when thinned', () => {
    const f = new FrameSkip();
    expect([1, 1, 1].map(() => f.due(1, false))).toEqual([true, true, true]);
    expect([0, 0, 0, 0, 0, 0, 0, 0].map(() => f.due(4, false))).toEqual([false, false, false, true, false, false, false, true]);
  });

  it('draws the frame after a resize even when it would be skipped, and counts on from there', () => {
    const f = new FrameSkip();
    expect(f.due(4, false)).toBe(false);
    expect(f.due(4, true)).toBe(true);
    expect([0, 0, 0, 0].map(() => f.due(4, false))).toEqual([false, false, false, true]);
  });
});

describe('World.dirty', () => {
  it('is set by a resize (setSize clears the canvas) and cleared by the next render', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 640, innerHeight: 360 });
    const setSize = vi.fn();
    const render = vi.fn();
    const w: World = Object.assign(Object.create(World.prototype) as object, {
      canvas: { clientWidth: 640, clientHeight: 360 },
      renderer: { setPixelRatio: vi.fn(), setSize, getPixelRatio: () => 1.5, render, info: {} },
      camera: { aspect: 1, updateProjectionMatrix: vi.fn() },
      renderScale: 1.5,
      post: null,
      fps: null,
      needWarm: false,
      envDue: 0,
      settle: null,
      frames: 5,
      dirty: false,
    }) as unknown as World;
    w.resize();
    expect(setSize).toHaveBeenCalledWith(640, 360, false);
    expect(w.dirty).toBe(true);
    w.render();
    expect(render).toHaveBeenCalled();
    expect(w.dirty).toBe(false);
  });
});
