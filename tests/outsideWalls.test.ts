// Walls on all roads: a car left on the grass (outside the walls) gets a HUD hint on how to get
// back, once until the next respawn. RaceMode needs WebGL, so its method runs on a stand-in.

import { describe, expect, it, vi } from 'vitest';
import { OUTSIDE_HINT_S, outsideWallsHint, RaceMode } from '../src/app/raceMode';

type Proto = { watchOutside(dt: number): void; handle(events: unknown[]): void };
const proto = RaceMode.prototype as unknown as Proto;

function race(walls = true) {
  const at = { x: 0, y: 0, z: 0 };
  return {
    entry: { walls },
    touch: true,
    grassFor: 0,
    outsideHinted: false,
    nitroArmed: false,
    race: { phase: 'racing', hasRespawnPoint: true, taken: new Set(), car: { onGrass: true, pos: at, rot: { ...at, w: 1 } } },
    track: { checkpointCount: 2 },
    smoke: { clear: vi.fn() },
    prev: null,
    lineView: null,
    flipRespawns: 0,
    app: {
      hud: { message: vi.fn(), setCheckpoints: vi.fn(), flipWarning: vi.fn(), clearMessages: vi.fn() },
      rig: { reset: vi.fn() },
      input: { clearNitroPress: vi.fn() },
    },
  };
}

/** `s` seconds of 60 fps frames. */
const drive = (r: ReturnType<typeof race>, s: number) => {
  for (let t = 0; t < s * 60; t++) proto.watchOutside.call(r, 1 / 60);
};

describe('outside the walls hint', () => {
  it('says how to get back after a moment on the grass, once until a respawn', () => {
    const r = race();
    drive(r, OUTSIDE_HINT_S - 0.1);
    expect(r.app.hud.message).not.toHaveBeenCalled();
    drive(r, 0.2);
    expect(r.app.hud.message).toHaveBeenCalledTimes(1);
    expect(r.app.hud.message).toHaveBeenCalledWith(outsideWallsHint(true, false), expect.any(Number));
    drive(r, 5);
    expect(r.app.hud.message).toHaveBeenCalledTimes(1);
    // A respawn that lands outside again says it again.
    proto.handle.call(r, [{ type: 'respawn', auto: false }]);
    drive(r, OUTSIDE_HINT_S + 0.1);
    expect(r.app.hud.message).toHaveBeenCalledTimes(2);
  });

  it('counts only an unbroken stretch on the grass, while racing with walls on', () => {
    const r = race();
    drive(r, 1);
    r.race.car.onGrass = false;
    drive(r, 0.1);
    r.race.car.onGrass = true;
    drive(r, 1);
    expect(r.app.hud.message).not.toHaveBeenCalled();
    const open = race(false);
    drive(open, 5);
    expect(open.app.hud.message).not.toHaveBeenCalled();
    const counting = race();
    counting.race.phase = 'countdown';
    drive(counting, 5);
    expect(counting.app.hud.message).not.toHaveBeenCalled();
  });

  it('names the respawn control, and a restart before the first checkpoint', () => {
    expect(outsideWallsHint(true, false)).toBe('Outside the walls: tap CP to respawn');
    expect(outsideWallsHint(false, true)).toBe('Outside the walls: press R to restart');
  });
});
