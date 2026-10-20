// The nitro: its push and timers in stepCar, its race rules in RaceSession (countdown press, respawn,
// restart, the input log), ghost flames, and the autopilots' rule for firing it.
import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '../src/core/constants';
import { qfromYawDir } from '../src/core/vec';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { Autopilot, nitroFits, NITRO_RULE } from '../src/game/bot';
import { decodeGhost, encodeGhost, GhostRecorder, ghostNitro } from '../src/game/ghost';
import { COUNTDOWN_TICKS, INPUT_STRIDE, loggedControls, quantise, RaceSession, type RaceEvent } from '../src/game/race';
import {
  cloneCar,
  createCar,
  forwardOf,
  nitroAccel,
  nitroDeltaV,
  nitroGauge,
  nitroReady,
  NITRO_POWER,
  NITRO_RECHARGE,
  NITRO_TIME,
  NO_CONTROLS,
  speedOf,
  stepCar,
  type CarState,
  type Controls,
} from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import type { Route, RoutePoint } from '../src/track/route';
import { Track } from '../src/track/track';

const PUSH_TICKS = NITRO_TIME * TICK_HZ; // 150
const RECHARGE_TICKS = NITRO_RECHARGE * TICK_HZ; // 600
const GAS: Controls = { steer: 0, gas: 1, brake: 0 };
const NITRO: Controls = { steer: 0, gas: 1, brake: 0, nitro: true };

/** An endless flat surface (road, or grass) at y = 0. */
function plane(road = true): Track {
  return {
    surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: road ? 1 : 0.55, road, block: null }),
    wallAt: () => null,
    sideAt: () => null,
    columnsNear: () => null,
    spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
  } as unknown as Track;
}
const flat = plane();

/** A car on the flat plane after `ticks` of full throttle. */
function rolling(ticks: number, track = flat): CarState {
  const c = createCar(track);
  for (let n = 0; n < ticks; n++) stepCar(c, GAS, track);
  return c;
}

const state = (c: CarState) => [c.pos, c.vel, c.rot, c.angVel, c.steer, c.drift, c.comp, c.wheelSpin, c.odometer, c.nitroTime, c.nitroCooldown];

describe('nitro physics', () => {
  it('is charged on a new car, and a press pushes for exactly NITRO_TIME, then recharges for NITRO_RECHARGE', () => {
    const c = rolling(300);
    expect(nitroReady(c)).toBe(true);
    stepCar(c, NITRO, flat);
    expect(c.nitroTime).toBe(NITRO_TIME - 1 / TICK_HZ);
    let pushed = 1;
    while (c.nitroTime > 0) {
      stepCar(c, GAS, flat);
      pushed++;
    }
    expect(pushed).toBe(PUSH_TICKS);
    // The recharge counts from the end of the push, in whole ticks, and reaches exactly 0.
    expect(c.nitroCooldown).toBe(NITRO_RECHARGE);
    let waited = 0;
    while (c.nitroCooldown > 0) {
      stepCar(c, NITRO, flat); // presses while recharging do nothing
      expect(c.nitroTime).toBe(0);
      waited++;
    }
    expect(waited).toBe(RECHARGE_TICKS);
    expect(nitroReady(c)).toBe(true);
    stepCar(c, NITRO, flat);
    expect(c.nitroTime).toBeGreaterThan(0);
  });

  it('reads as ready, boosting and recharging for the button and HUD, with a 6..1 countdown', () => {
    const c = rolling(10);
    expect(nitroGauge(c)).toEqual({ state: 'ready', p: 1, seconds: 0 });
    stepCar(c, NITRO, flat);
    expect(nitroGauge(c).state).toBe('boosting');
    expect(nitroGauge(c).p).toBeCloseTo(149 / 150, 10);
    while (c.nitroTime > 0) stepCar(c, GAS, flat);
    expect(nitroGauge(c)).toEqual({ state: 'recharging', p: 0, seconds: 6 });
    const seen = new Set<number>();
    while (c.nitroCooldown > 0) {
      seen.add(nitroGauge(c).seconds);
      stepCar(c, GAS, flat);
    }
    expect([...seen]).toEqual([6, 5, 4, 3, 2, 1]);
    expect(nitroGauge(c).state).toBe('ready');
  });

  it('a held button fires every 7.5 s: the push plus the recharge', () => {
    const c = rolling(10);
    const fired: number[] = [];
    for (let n = 0; n < 2000; n++) {
      const before = c.nitroTime;
      stepCar(c, { steer: 0, gas: 0.2, brake: 0, nitro: true }, flat);
      if (before === 0 && c.nitroTime > 0) fired.push(n);
    }
    expect(fired).toEqual([0, PUSH_TICKS + RECHARGE_TICKS, 2 * (PUSH_TICKS + RECHARGE_TICKS)]);
  });

  it('adds about 66 km/h on the flat, fading from NITRO_POWER to 35% of it', () => {
    expect(nitroAccel(NITRO_TIME)).toBe(NITRO_POWER);
    expect(nitroAccel(0)).toBeCloseTo(0.35 * NITRO_POWER, 10);
    expect(nitroDeltaV() * 3.6).toBeGreaterThan(64);
    expect(nitroDeltaV() * 3.6).toBeLessThan(68);
    // Two cars at about 150 km/h on full throttle, one fires: the gain, after drag and the engine's fade.
    const a = rolling(400);
    expect(speedOf(a) * 3.6).toBeGreaterThan(140);
    const b = cloneCar(a);
    stepCar(b, NITRO, flat);
    stepCar(a, GAS, flat);
    for (let n = 1; n < PUSH_TICKS; n++) {
      stepCar(a, GAS, flat);
      stepCar(b, GAS, flat);
    }
    const gain = (speedOf(b) - speedOf(a)) * 3.6;
    expect(gain).toBeGreaterThan(45);
    expect(gain).toBeLessThan(66);
  });

  it('does not push in the air or on the grass, though its time runs', () => {
    for (const where of ['air', 'grass'] as const) {
      const track = where === 'grass' ? plane(false) : flat;
      const a = rolling(200, track);
      if (where === 'air') {
        a.pos.y += 5;
        a.vel.y = 0;
      }
      const b = cloneCar(a);
      stepCar(b, NITRO, track);
      stepCar(a, GAS, track);
      for (let n = 1; n < 10; n++) {
        stepCar(a, GAS, track);
        stepCar(b, GAS, track);
      }
      expect(Math.hypot(b.vel.x - a.vel.x, b.vel.z - a.vel.z), where).toBeLessThan(1e-9);
      expect(b.nitroTime, where).toBe(NITRO_TIME - 10 / TICK_HZ);
    }
  });

  it('braking ends a running push and starts the recharge; a press with the brake down does not fire', () => {
    const c = rolling(300);
    stepCar(c, { steer: 0, gas: 0, brake: 1, nitro: true }, flat);
    expect(nitroReady(c)).toBe(true);
    stepCar(c, NITRO, flat);
    for (let n = 0; n < 40; n++) stepCar(c, GAS, flat);
    expect(c.nitroTime).toBeGreaterThan(0);
    // A braked car with the push cut slows exactly like one that never fired.
    const ref = cloneCar(c);
    ref.nitroTime = 0;
    ref.nitroCooldown = NITRO_RECHARGE;
    stepCar(c, { steer: 0, gas: 0, brake: 0.5 }, flat);
    stepCar(ref, { steer: 0, gas: 0, brake: 0.5 }, flat);
    expect(c.nitroTime).toBe(0);
    expect(c.nitroCooldown).toBe(NITRO_RECHARGE);
    ref.nitroCooldown = NITRO_RECHARGE;
    expect(state(c)).toEqual(state(ref));
  });

  it('adds to a boost pad: the two push at once and neither cuts the other short', () => {
    const a = rolling(200);
    a.boostTime = 1;
    a.boostPower = 16;
    const b = cloneCar(a);
    stepCar(b, NITRO, flat);
    stepCar(a, GAS, flat);
    expect(b.boostTime).toBe(a.boostTime);
    expect(speedOf(b) - speedOf(a)).toBeCloseTo(nitroAccel(NITRO_TIME) / TICK_HZ, 1);
  });

  it('leaves the car bit for bit as it was when never pressed', () => {
    // tests/carGolden.test.ts pins whole drives to physics v6; here the field itself, held false or absent.
    for (const vehicle of VEHICLE_CLASSES) {
      const a = createCar(flat, vehicle);
      const b = createCar(flat, vehicle);
      for (let n = 0; n < 1200; n++) {
        const t = n / 100;
        const ctl: Controls = t < 5 ? GAS : t < 6 ? { steer: 0.6, gas: 1, brake: 0 } : t < 7 ? { steer: -1, gas: 0, brake: 1 } : { steer: 0.2, gas: 0.7, brake: 0 };
        stepCar(a, ctl, flat);
        stepCar(b, { ...ctl, nitro: false }, flat);
      }
      expect(state(b), vehicle).toEqual(state(a));
      expect(a.nitroTime + a.nitroCooldown).toBe(0);
    }
  });
});

const straight = new Track(buildTrack('nitro-straight', 'St Sx6 C Sx60 F'));

/** A race past its countdown. */
function racing(track = straight): RaceSession {
  const r = new RaceSession(track);
  for (let n = 0; n < COUNTDOWN_TICKS; n++) r.step(NO_CONTROLS);
  return r;
}

const types = (ev: RaceEvent[]) => ev.map((e) => e.type);

describe('nitro race rules', () => {
  it('is charged at GO; a press in the countdown fires on the first racing tick', () => {
    const r = new RaceSession(straight);
    expect(nitroReady(r.car)).toBe(true);
    for (let n = 0; n < COUNTDOWN_TICKS; n++) r.step(n === 20 ? { ...NO_CONTROLS, nitro: true } : NO_CONTROLS);
    expect(r.phase).toBe('racing');
    expect(r.car.nitroTime).toBe(0);
    expect(types(r.step(GAS))).toContain('nitro');
    expect(r.car.nitroTime).toBeGreaterThan(0);
    expect(r.nitroUses).toBe(1);
    expect(r.inputs.slice(0, INPUT_STRIDE)).toEqual([0, 255, 0, 1]);
    expect(loggedControls(r.inputs, 0)).toEqual(quantise(NITRO));
  });

  it('a countdown press waits for the brake to lift after GO (up to half a second)', () => {
    const BRAKE: Controls = { steer: 0, gas: 0, brake: 1 };
    const armed = (): RaceSession => {
      const r = new RaceSession(straight);
      for (let n = 0; n < COUNTDOWN_TICKS; n++) r.step(n === 20 ? { ...NO_CONTROLS, nitro: true } : NO_CONTROLS);
      return r;
    };
    const r = armed();
    for (let n = 0; n < 10; n++) expect(types(r.step(BRAKE))).not.toContain('nitro');
    expect(r.car.nitroTime).toBe(0);
    expect(types(r.step(GAS))).toContain('nitro');
    expect(r.nitroUses).toBe(1);
    // The log says what reached the car, so the run replays the same.
    expect(loggedControls(r.inputs, 10).nitro).toBe(true);
    // Held past the window: the press is dropped.
    const late = armed();
    for (let n = 0; n < 60; n++) late.step(BRAKE);
    for (let n = 0; n < 5; n++) expect(types(late.step(GAS))).not.toContain('nitro');
    expect(late.nitroUses).toBe(0);
  });

  it('fires once per press, and says when it is ready again', () => {
    const r = racing();
    for (let n = 0; n < 50; n++) r.step(GAS);
    expect(types(r.step(NITRO))).toEqual(['nitro']);
    let at = -1;
    for (let n = 1; n <= 1000 && at < 0; n++) {
      const ev = r.step(NITRO);
      expect(types(ev)).not.toContain('nitro');
      if (types(ev).includes('nitroReady')) at = n;
    }
    // Ready after the push and the recharge (the firing tick is the first tick of the push).
    expect(at).toBe(PUSH_TICKS + RECHARGE_TICKS - 1);
    expect(r.nitroUses).toBe(1);
    expect(types(r.step(NITRO))).toEqual(['nitro']);
    expect(r.nitroUses).toBe(2);
  });

  it('a checkpoint respawn cuts a push without a refill, and keeps a recharge; a restart refills', () => {
    const r = racing();
    for (let n = 0; n < 2000 && r.taken.size === 0; n++) r.step(GAS);
    expect(r.hasRespawnPoint).toBe(true);
    // Charged at the checkpoint, so a respawn that restored it would refill.
    expect(nitroReady(r.car)).toBe(true);
    r.step(NITRO);
    r.respawn();
    expect(r.car.nitroTime).toBe(0);
    expect(r.car.nitroCooldown).toBe(NITRO_RECHARGE);
    for (let n = 0; n < 100; n++) r.step(GAS);
    const left = r.car.nitroCooldown;
    expect(left).toBe(NITRO_RECHARGE - 1);
    r.respawn();
    expect(r.car.nitroCooldown).toBe(left);
    r.restart();
    expect(nitroReady(r.car)).toBe(true);
    expect(r.nitroUses).toBe(0);
    // Ready stays ready.
    const s = racing();
    for (let n = 0; n < 2000 && s.taken.size === 0; n++) s.step(GAS);
    s.respawn();
    expect(nitroReady(s.car)).toBe(true);
  });

  it('a respawn before any checkpoint is a restart: charged, with no uses', () => {
    const r = racing();
    r.step(NITRO);
    r.respawn();
    expect(r.phase).toBe('countdown');
    expect(nitroReady(r.car)).toBe(true);
    expect(r.nitroUses).toBe(0);
  });

  it('never fires after the finish', () => {
    const r = new RaceSession(new Track(buildTrack('nitro-short', 'St S C S F')));
    for (let n = 0; n < 5000 && r.phase !== 'finished'; n++) r.step(r.phase === 'racing' ? GAS : NO_CONTROLS);
    expect(r.phase).toBe('finished');
    for (let n = 0; n < 50; n++) expect(types(r.step(NITRO))).not.toContain('nitro');
    expect(r.car.nitroTime).toBe(0);
  });

  it('replays an autopilot run that fires the nitro from its input log, and the nitro is in the log', () => {
    const track = new Track(buildTrack('nitro-det', 'St B Sx2 R S C S L2 S U S J G G Sx3 D S F'));
    const a = new RaceSession(track);
    const bot = new Autopilot(track);
    while (a.phase !== 'finished' && a.ticks < 20000) a.step(a.phase === 'racing' ? bot.controls(a) : NO_CONTROLS);
    expect(a.phase).toBe('finished');
    expect(a.nitroUses).toBeGreaterThan(1);
    expect(a.inputs.length).toBe(a.ticks * INPUT_STRIDE);
    const replay = (log: number[]) => {
      const b = new RaceSession(track);
      while (b.phase !== 'finished' && b.ticks < a.ticks) b.step(b.phase === 'racing' ? loggedControls(log, b.ticks) : NO_CONTROLS);
      return b;
    };
    const b = replay(a.inputs);
    expect(b.finishTime).toBe(a.finishTime);
    expect(b.car.pos).toEqual(a.car.pos);
    expect(b.nitroUses).toBe(a.nitroUses);
    const without = a.inputs.map((v, i) => (i % INPUT_STRIDE === 3 ? 0 : v));
    expect(replay(without).car.pos).not.toEqual(a.car.pos);
  }, 20000);
});

describe('ghost flames', () => {
  it('records when the nitro pushed, and keeps it through encoding', () => {
    const rec = new GhostRecorder();
    const c = createCar(flat);
    for (let t = 0; t <= 400; t++) {
      c.nitroTime = t >= 100 && t < 250 ? NITRO_TIME - (t - 100) / TICK_HZ : 0;
      rec.record(t, c);
    }
    const g = rec.finish(4000, []);
    expect(g.nitro).toEqual([100, 250]);
    expect(ghostNitro(g, 99)).toBe(0);
    expect(ghostNitro(g, 100)).toBe(NITRO_TIME);
    expect(ghostNitro(g, 175)).toBeCloseTo(0.75, 10);
    expect(ghostNitro(g, 249)).toBeGreaterThan(0);
    expect(ghostNitro(g, 250)).toBe(0);
    const back = decodeGhost(encodeGhost(g))!;
    expect(back.nitro).toEqual([100, 250]);
    expect(ghostNitro(back, 175)).toBeCloseTo(0.75, 10);
    // A push still running at the finish closes there; a ghost without one keeps the old format.
    rec.reset();
    for (let t = 0; t <= 10; t++) rec.record(t, { ...c, nitroTime: t >= 8 ? 1 : 0 });
    expect(rec.finish(100, []).nitro).toEqual([8, 11]);
    rec.reset();
    rec.record(0, { ...c, nitroTime: 0 });
    expect(Object.keys(JSON.parse(encodeGhost(rec.finish(100, []))))).toEqual(['p', 't', 'i', 'c', 's']);
    expect(decodeGhost(JSON.stringify({ p: 6, t: 1, i: 2, c: [], s: '' }))!.nitro).toEqual([]);
  });
});

describe('when the autopilots fire', () => {
  /** A straight route along +z: `n` points 2 m apart, with every speed target `v`. */
  function route(n: number, air: (k: number) => boolean = () => false, y: (k: number) => number = () => 0): Route {
    const points: RoutePoint[] = [];
    for (let k = 0; k < n; k++) points.push({ x: 0, y: y(k), z: 2 * k, s: 2 * k, hx: 0, hz: 1, curv: 0, air: air(k) });
    return { blocks: [], points, length: 2 * (n - 1), complete: true };
  }
  /** A settled car at 30 m/s heading down the route. */
  function car(): CarState {
    const c = createCar(flat);
    for (let n = 0; n < 100; n++) stepCar(c, NO_CONTROLS, flat);
    c.rot = qfromYawDir(0, 1);
    const f = forwardOf(c);
    c.vel = { x: f.x * 30, y: f.y * 30, z: f.z * 30 };
    return c;
  }
  const high = (n: number) => new Float64Array(n).fill(200);

  it('fire on a long flat straight with a high plan', () => {
    expect(nitroFits(route(400), high(400), 0, 30, car())).toBe(true);
  });

  it('never into a jump, a slope, a slower plan, a slide, a turn or off the road', () => {
    const c = car();
    expect(nitroFits(route(400, (k) => k === 40), high(400), 0, 30, c), 'jump').toBe(false);
    expect(nitroFits(route(400, () => false, (k) => Math.max(0, k - 60) * 0.25), high(400), 0, 30, c), 'slope').toBe(false);
    const slow = high(400);
    slow[40] = 30 + nitroDeltaV() - 1;
    expect(nitroFits(route(400), slow, 0, 30, c), 'plan').toBe(false);
    expect(nitroFits(route(400), high(400), 0, 30, { ...c, drift: 0.3 }), 'drift').toBe(false);
    expect(nitroFits(route(400), high(400), 0, 30, { ...c, steer: NITRO_RULE.steer + 0.05 }), 'steer').toBe(false);
    expect(nitroFits(route(400), high(400), 0, 30, { ...c, grounded: 3 }), 'wheel up').toBe(false);
    expect(nitroFits(route(400), high(400), 0, 30, { ...c, onGrass: true }), 'grass').toBe(false);
    expect(nitroFits(route(400), high(400), 0, 30, { ...c, rot: qfromYawDir(0.5, 0.86) }), 'pointing off the road').toBe(false);
  });

  it('every class fires at GO on the campaign opener and finishes', () => {
    const t = new Track(buildTrack('nitro-go', 'St Sx3 R Sx3 F'));
    for (const vehicle of VEHICLE_CLASSES) {
      const r = new RaceSession(t, undefined, vehicle);
      const bot = new Autopilot(t, vehicle);
      let first = -1;
      while (r.phase !== 'finished' && r.ticks < 6000) {
        const ev = r.step(r.phase === 'racing' ? bot.controls(r) : NO_CONTROLS);
        if (first < 0 && types(ev).includes('nitro')) first = r.ticks;
      }
      expect(r.phase, vehicle).toBe('finished');
      expect(first, vehicle).toBe(1);
    }
  });
});
