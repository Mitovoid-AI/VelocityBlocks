import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_TICKS,
  FLIP_RESPAWN_TICKS,
  FLIP_WARN_TICKS,
  nextFlipTicks,
  RaceSession,
  type RaceEvent,
} from '../src/game/race';
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';
import { Autopilot } from '../src/game/bot';
import { createCar, forwardOf, speedOf, upOf, NO_CONTROLS, type Controls } from '../src/physics/vehicle';
import { qfromAxisAngle, qfromYawDir, qmul, vcross } from '../src/core/vec';
import { CELL, WALL_OFF } from '../src/core/constants';

const track = new Track(buildTrack('flip', 'St S C Sx6 F'));
const GAS: Controls = { steer: 0, gas: 1, brake: 0 };

/** Runs the countdown so the next step is the first racing tick. */
function toGo(r: RaceSession): void {
  for (let n = 0; n < COUNTDOWN_TICKS; n++) r.step(NO_CONTROLS);
}

/** Rotates the car about the world forward (roll) or right (pitch) axis and drops it from `lift`. */
function turn(r: RaceSession, axis: 'roll' | 'pitch', deg: number, lift = 1): void {
  const c = r.car;
  const f = forwardOf(c);
  const ax = axis === 'roll' ? f : vcross(f, upOf(c));
  c.rot = qmul(qfromAxisAngle(ax, (deg * Math.PI) / 180), c.rot);
  c.pos.y += lift;
  c.vel = { x: 0, y: 0, z: 0 };
  c.angVel = { x: 0, y: 0, z: 0 };
}

/** 1-based step index of the first respawn event, or -1. */
function stepUntilRespawn(r: RaceSession, max: number, ctl: Controls = NO_CONTROLS): number {
  for (let n = 1; n <= max; n++) {
    if (r.step(ctl).some((e) => e.type === 'respawn')) return n;
  }
  return -1;
}

function idle(r: RaceSession, n: number): void {
  for (let i = 0; i < n; i++) r.step(NO_CONTROLS);
}

/** Drives to the first checkpoint and flips the car onto its roof there. */
function flippedAfterCheckpoint(): { r: RaceSession; ticks0: number } {
  const r = new RaceSession(track);
  toGo(r);
  for (let n = 0; n < 1000 && r.taken.size === 0; n++) r.step(GAS);
  expect(r.taken.size).toBe(1);
  const ticks0 = r.ticks;
  turn(r, 'roll', 180);
  return { r, ticks0 };
}

describe('flip timer rule', () => {
  it('nextFlipTicks', () => {
    expect(nextFlipTicks(0, -1, 0)).toBe(1);
    expect(nextFlipTicks(0, -1, 50)).toBe(1);
    expect(nextFlipTicks(10, 0, 30)).toBe(11);
    expect(nextFlipTicks(10, 0.29, 30)).toBe(11);
    expect(nextFlipTicks(10, 0.45, 0.5)).toBe(11);
    expect(nextFlipTicks(10, 0.45, 10)).toBe(10);
    expect(nextFlipTicks(10, 0.6, 0)).toBe(0);
    expect(nextFlipTicks(299, 1, 0)).toBe(0);
  });

  it('a manual respawn is not automatic', () => {
    expect(new RaceSession(track).respawn()).toEqual([{ type: 'respawn', auto: false }]);
  });
});

describe('standing respawn', () => {
  it('puts the car at the checkpoint at a standstill, with no boost, and it pulls away from 0', () => {
    const r = new RaceSession(track);
    toGo(r);
    for (let n = 0; n < 1000 && r.taken.size === 0; n++) r.step(GAS);
    expect(r.taken.size).toBe(1);
    for (let n = 0; n < 50; n++) r.step(GAS);
    expect(speedOf(r.car)).toBeGreaterThan(20);
    r.car.boostTime = 1;
    r.car.boostPower = 20;
    r.respawn();
    expect(speedOf(r.car)).toBe(0);
    expect(r.car.angVel).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.car.boostTime).toBe(0);
    expect(r.car.boostPower).toBe(0);
    expect(r.car.steer).toBe(0);
    // Gas held through the respawn: the car accelerates from 0 again, not from the crossing speed.
    r.step(GAS);
    expect(speedOf(r.car)).toBeLessThan(2);
    for (let n = 0; n < 50; n++) r.step(GAS);
    expect(speedOf(r.car)).toBeGreaterThan(2);
  });
});

describe('automatic flip respawn', () => {
  it('respawns at the last checkpoint after exactly 3 s on the roof', () => {
    const { r, ticks0 } = flippedAfterCheckpoint();
    let ev: RaceEvent | undefined;
    let at = -1;
    for (let n = 1; n <= 400 && at < 0; n++) {
      ev = r.step(NO_CONTROLS).find((e) => e.type === 'respawn');
      if (ev) at = n;
    }
    expect(at).toBe(FLIP_RESPAWN_TICKS);
    expect(ev).toEqual({ type: 'respawn', auto: true });
    expect(r.phase).toBe('racing');
    expect(r.ticks).toBe(ticks0 + FLIP_RESPAWN_TICKS);
    expect(r.respawns).toBe(1);
    expect(r.taken.size).toBe(1);
    expect(r.flipTicks).toBe(0);
    expect(r.hasRespawnPoint).toBe(true);
    expect(upOf(r.car).y).toBeGreaterThan(0.99);

    // Upright inside the checkpoint block's road, in its local frame.
    const cp = track.gates.find((g) => g.kind === 'checkpoint')!.block;
    const l = cp.toLocal(r.car.pos.x, r.car.pos.z);
    expect(Math.abs(l.a)).toBeLessThanOrEqual(WALL_OFF);
    expect(l.b).toBeGreaterThanOrEqual(0);
    expect(l.b).toBeLessThanOrEqual(CELL);

    // Deterministic: an identical session respawns on the same step at the same place.
    const twin = flippedAfterCheckpoint().r;
    expect(stepUntilRespawn(twin, 400)).toBe(FLIP_RESPAWN_TICKS);
    expect(twin.car.pos).toEqual(r.car.pos);
  });

  it('restarts when no checkpoint was taken', () => {
    const r = new RaceSession(track);
    toGo(r);
    for (let n = 0; n < 50; n++) r.step(GAS);
    turn(r, 'roll', 180);
    expect(stepUntilRespawn(r, 400)).toBe(FLIP_RESPAWN_TICKS);
    expect(r.phase).toBe('countdown');
    expect(r.ticks).toBe(0);
    expect(r.timeMs).toBe(0);
    expect(r.respawns).toBe(0);
    expect(r.hasRespawnPoint).toBe(false);
    expect(r.inputs.length).toBe(0);
    expect(r.car.pos).toEqual(createCar(track).pos);
  });

  it('respawns a car stuck standing on its nose', () => {
    const r = new RaceSession(track);
    toGo(r);
    idle(r, 30);
    turn(r, 'pitch', 90, 1.5);
    expect(stepUntilRespawn(r, 400)).toBe(FLIP_RESPAWN_TICKS);
  });

  it('does not respawn cars that right themselves', () => {
    const peak = (deg: number): { max: number; respawned: boolean; upY: number } => {
      const r = new RaceSession(track);
      toGo(r);
      idle(r, 30);
      turn(r, 'roll', deg, 1);
      let max = 0;
      let respawned = false;
      for (let n = 0; n < 1200; n++) {
        if (r.step(NO_CONTROLS).some((e) => e.type === 'respawn')) respawned = true;
        max = Math.max(max, r.flipTicks);
      }
      return { max, respawned, upY: upOf(r.car).y };
    };
    const r110 = peak(110);
    expect(r110.max).toBeLessThan(FLIP_WARN_TICKS);
    expect(r110.respawned).toBe(false);
    expect(r110.upY).toBeGreaterThan(0.99);
    const r130 = peak(130);
    expect(r130.respawned).toBe(false);
    expect(r130.max).toBeLessThan(FLIP_RESPAWN_TICKS);
    expect(r130.upY).toBeGreaterThan(0.99);
  });

  it('righting the car resets the timer', () => {
    const r = new RaceSession(track);
    toGo(r);
    turn(r, 'roll', 180);
    expect(stepUntilRespawn(r, 200)).toBe(-1);
    expect(r.flipTicks).toBe(200);

    const sp = track.spawn();
    r.car.rot = qfromYawDir(sp.hx, sp.hz);
    r.car.angVel = { x: 0, y: 0, z: 0 };
    r.step(NO_CONTROLS);
    expect(r.flipTicks).toBe(0);

    turn(r, 'roll', 180);
    expect(stepUntilRespawn(r, FLIP_RESPAWN_TICKS - 1)).toBe(-1);
    expect(r.flipTicks).toBe(FLIP_RESPAWN_TICKS - 1);
    expect(r.step(NO_CONTROLS)).toContainEqual({ type: 'respawn', auto: true });
  });

  it('does not count during the countdown', () => {
    const r = new RaceSession(track);
    turn(r, 'roll', 180);
    for (let n = 0; n < COUNTDOWN_TICKS; n++) {
      expect(r.step(NO_CONTROLS).some((e) => e.type === 'respawn')).toBe(false);
      expect(r.flipTicks).toBe(0);
    }
    expect(stepUntilRespawn(r, 400)).toBe(FLIP_RESPAWN_TICKS);
    expect(r.phase).toBe('countdown');
  });

  it('does not respawn after the finish', () => {
    const short = new Track(buildTrack('flip-finish', 'St S C S F'));
    const r = new RaceSession(short);
    const bot = new Autopilot(short);
    while (r.phase !== 'finished' && r.ticks < 5000) r.step(r.phase === 'racing' ? bot.controls(r) : NO_CONTROLS);
    expect(r.phase).toBe('finished');
    const respawns = r.respawns;
    turn(r, 'roll', 180);
    expect(stepUntilRespawn(r, 400)).toBe(-1);
    expect(r.phase).toBe('finished');
    expect(r.respawns).toBe(respawns);
    expect(r.flipTicks).toBe(0);
  });
});
