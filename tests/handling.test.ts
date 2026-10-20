import { describe, expect, it } from 'vitest';
import { Autopilot } from '../src/game/bot';
import { loggedControls, RaceSession } from '../src/game/race';
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';
import {
  assistsFor,
  CAR,
  createCar,
  DEFAULT_ASSISTS,
  forwardOf,
  gripAccel,
  maxBrakeDecel,
  maxLatAccel,
  maxSteerAngle,
  speedOf,
  stepCar,
  type Assists,
  type CarState,
  type Controls,
} from '../src/physics/vehicle';

/** An endless flat asphalt plane (no walls, no columns): a skidpad and drag strip. */
const flat = {
  surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null }),
  wallAt: () => null,
  sideAt: () => null,
  columnsNear: () => null,
  spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
} as unknown as Track;
const NORMAL: Assists = { tc: 'normal' };
const LOW: Assists = { tc: 'low' };
const NONE: Controls = { steer: 0, gas: 0, brake: 0 };
const kmh = (c: CarState) => speedOf(c) * 3.6;

/** Car rolling straight along +z at v m/s, settled on its springs (downforce squats it at speed). */
function rolling(v: number, assists: Assists = NORMAL): CarState {
  const c = createCar(flat);
  for (let n = 0; n < 200; n++) {
    stepCar(c, NONE, flat, assists);
    c.vel = { x: 0, y: 0, z: v };
  }
  return c;
}

/** Body slip angle in degrees (heading vs direction of travel). */
function beta(c: CarState): number {
  const f = forwardOf(c);
  return Math.abs((Math.atan2(f.x * c.vel.z - f.z * c.vel.x, f.x * c.vel.x + f.z * c.vel.z) * 180) / Math.PI);
}

/** Steady state with speed held at v ("treadmill"), averaged over the last second. */
function skidpad(v: number, steer: number, gas = 0, assists: Assists = NORMAL) {
  const c = rolling(v, assists);
  let prev = Math.atan2(c.vel.x, c.vel.z);
  let a = 0, slip = 0, tc = 0, spin = 0;
  for (let n = 0; n < 400; n++) {
    stepCar(c, { steer, gas, brake: 0 }, flat, assists);
    const s = Math.hypot(c.vel.x, c.vel.z);
    c.vel.x *= v / s;
    c.vel.z *= v / s;
    const h = Math.atan2(c.vel.x, c.vel.z);
    let dh = h - prev;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    prev = h;
    if (n >= 300) {
      a += (Math.abs(dh) / 0.01) * v;
      slip += c.slip;
      tc += c.tc;
      spin += c.spin;
    }
  }
  return { a: a / 100, slip: slip / 100, tc: tc / 100, spin: spin / 100 };
}

/** Best steady lateral acceleration at v over a sweep of steering inputs. */
function latLimit(v: number): number {
  let best = 0;
  for (let s = 0.2; s <= 1.001; s += 0.1) best = Math.max(best, skidpad(v, s).a);
  return best;
}

/**
 * Brake-tap drift: steer in at v km/h, tap the brake for 200 ms, then slide on the gas with the steering
 * held for half a second. Returns the speed lost in the tap, the speed after the slide (km/h) and how far
 * the direction of travel turned (degrees).
 */
function brakeTapDrift(v: number, steer: number) {
  const c = rolling(v / 3.6);
  for (let n = 0; n < 20; n++) stepCar(c, { steer, gas: 1, brake: 0 }, flat);
  const vIn = kmh(c);
  let turned = 0, h = Math.atan2(c.vel.x, c.vel.z), lamp = 0, drift = 0;
  const run = (ctl: Controls, ticks: number) => {
    for (let n = 0; n < ticks; n++) {
      stepCar(c, ctl, flat);
      const h2 = Math.atan2(c.vel.x, c.vel.z);
      let d = h2 - h;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      turned += d;
      h = h2;
      lamp = Math.max(lamp, c.tc);
      drift = Math.max(drift, c.drift);
    }
  };
  run({ steer, gas: 0, brake: 1 }, 20);
  const tap = vIn - kmh(c);
  run({ steer, gas: 1, brake: 0 }, 50);
  return { tap, after: kmh(c), turned: (Math.abs(turned) * 180) / Math.PI, drift, lamp };
}

/**
 * The same manoeuvres measured on physics v5 (before downforce, ABS and traction control), steer 0.6
 * and full lock: tap loss (km/h), speed after the slide (km/h), degrees turned.
 */
const V5_DRIFT = [
  { v: 150, steer: 0.6, tap: 7.1, after: 130, turned: 24.5 },
  { v: 150, steer: 1, tap: 7.2, after: 126, turned: 23.9 },
  { v: 200, steer: 0.6, tap: 7.2, after: 170, turned: 22.0 },
  { v: 200, steer: 1, tap: 7.4, after: 166, turned: 21.3 },
];

describe('aero and tyres', () => {
  it('downforce adds cornering grip with speed', () => {
    const slow = skidpad(25, 1).a; // 90 km/h
    const fast = skidpad(70, 0.6).a; // 252 km/h
    expect(slow).toBeGreaterThan(24);
    expect(fast).toBeGreaterThan(1.9 * slow);
    expect(gripAccel(80, CAR)).toBeGreaterThan(2 * gripAccel(0, CAR));
  });

  it('full lock at speed rides the grip limit instead of scrubbing past it', () => {
    for (const v of [50, 70, 90]) {
      const full = skidpad(v, 1);
      expect(full.a, `${v} m/s`).toBeGreaterThan(0.9 * latLimit(v));
      expect(full.slip, `${v} m/s`).toBeLessThan(0.3);
    }
  });

  it('steering lock shrinks with speed', () => {
    let last = Infinity;
    for (const v of [10, 20, 40, 60, 90]) {
      const d = maxSteerAngle(v);
      expect(d).toBeLessThanOrEqual(last);
      last = d;
    }
    expect(maxSteerAngle(0)).toBeCloseTo(0.52, 5);
    expect(maxSteerAngle(-5)).toBe(maxSteerAngle(5));
    expect(maxSteerAngle(90)).toBeLessThan(0.12);
  });

  it('is stable after a lane change at top speed', () => {
    const c = rolling(90);
    let late = 0;
    for (let n = 0; n < 200; n++) {
      stepCar(c, { steer: n < 25 ? 1 : 0, gas: 1, brake: 0 }, flat);
      if (n >= 100) late = Math.max(late, Math.abs(c.angVel.y));
    }
    expect(late).toBeLessThan(0.01);
    expect(beta(c)).toBeLessThan(1);
  });

  it('reports downforce, and none in the air', () => {
    const c = rolling(60);
    stepCar(c, NONE, flat);
    expect(c.aero).toBeGreaterThan(0.9);
    c.pos.y += 5;
    stepCar(c, NONE, flat);
    expect(c.aero).toBe(0);
  });
});

describe('limits for speed planners', () => {
  it('maxLatAccel matches the skidpad', () => {
    for (const v of [15, 25, 50, 80]) {
      const a = latLimit(v);
      expect(maxLatAccel(v, CAR) / a, `${v} m/s`).toBeGreaterThan(0.94);
      expect(maxLatAccel(v, CAR) / a, `${v} m/s`).toBeLessThan(1.04);
    }
  });

  it('maxBrakeDecel matches a full stop on the brakes', () => {
    for (const v of [10, 30, 50, 70, 90]) {
      const c = rolling(v);
      const v0 = speedOf(c);
      for (let n = 0; n < 10; n++) stepCar(c, { steer: 0, gas: 0, brake: 1 }, flat);
      const decel = (v0 - speedOf(c)) / 0.1;
      expect(maxBrakeDecel(v, CAR) / decel, `${v} m/s`).toBeGreaterThan(0.95);
      expect(maxBrakeDecel(v, CAR) / decel, `${v} m/s`).toBeLessThan(1.04);
    }
    // Downforce only adds: standing still is the weakest it brakes.
    for (const v of [10, 50, 90]) expect(maxBrakeDecel(v, CAR)).toBeGreaterThan(maxBrakeDecel(0, CAR));
  });
});

describe('power and brakes', () => {
  it('brakes harder at speed, where downforce loads the tyres', () => {
    const decel = (v: number) => {
      const c = rolling(v);
      const v0 = speedOf(c);
      for (let n = 0; n < 10; n++) stepCar(c, { steer: 0, gas: 0, brake: 1 }, flat);
      return (v0 - speedOf(c)) / 0.1;
    };
    expect(decel(25)).toBeGreaterThan(24);
    expect(decel(83)).toBeGreaterThan(1.5 * decel(25));
  });

  it('ABS has its own signal and does not smoke', () => {
    const c = rolling(28);
    let abs = 0, slip = 0;
    for (let n = 0; n < 50; n++) {
      stepCar(c, { steer: 0, gas: 0, brake: 1 }, flat);
      abs = Math.max(abs, c.abs);
      slip = Math.max(slip, c.slip);
    }
    expect(abs).toBeGreaterThan(0.2);
    expect(slip).toBeLessThan(0.05);
  });

  it('the traction-control lamp means too much power for the corner, not a launch', () => {
    const c = rolling(0);
    let launch = 0;
    for (let n = 0; n < 300; n++) {
      stepCar(c, { steer: 0, gas: 1, brake: 0 }, flat);
      launch = Math.max(launch, c.tc);
    }
    expect(launch).toBeLessThan(0.05);
    // Full lock and full throttle at 54 km/h.
    expect(skidpad(15, 1, 1).tc).toBeGreaterThan(0.1);
    // Feathering the throttle keeps it off.
    expect(skidpad(15, 1, 0.3).tc).toBe(0);
  });

  it('low traction control lets the rear wheels spin; normal never does', () => {
    const normal = skidpad(15, 1, 1, NORMAL);
    const low = skidpad(15, 1, 1, LOW);
    expect(normal.spin).toBe(0);
    expect(low.spin).toBeGreaterThan(0.2);
    // Wheelspin shows as tyre smoke.
    expect(low.slip).toBeGreaterThan(normal.slip);
  });

  it('throttle is analog', () => {
    const accel = (gas: number) => {
      const c = rolling(40);
      const v0 = speedOf(c);
      for (let n = 0; n < 50; n++) stepCar(c, { steer: 0, gas, brake: 0 }, flat);
      return speedOf(c) - v0;
    };
    const full = accel(1);
    const half = accel(0.5);
    expect(half).toBeGreaterThan(0.3 * full);
    expect(half).toBeLessThan(0.7 * full);
  });

  it('a hair of pedal travel counts as released', () => {
    const coast = (gas: number, brake: number) => {
      const c = rolling(30);
      for (let n = 0; n < 50; n++) stepCar(c, { steer: 0, gas, brake }, flat);
      return speedOf(c);
    };
    // Trigger noise or one input-log step (1/255) still coasts with engine braking.
    expect(coast(1 / 255, 0)).toBe(coast(0, 0));
    expect(coast(0, 1 / 255)).toBe(coast(0, 0));
  });

  it('launches in under 2.2 s to 100 km/h with either traction-control setting', () => {
    const t100 = (assists: Assists) => {
      const c = rolling(0, assists);
      for (let n = 1; n < 1000; n++) {
        stepCar(c, { steer: 0, gas: 1, brake: 0 }, flat, assists);
        if (kmh(c) >= 100) return n / 100;
      }
      return Infinity;
    };
    expect(t100(NORMAL)).toBeGreaterThan(1.4);
    expect(t100(NORMAL)).toBeLessThan(2.2);
    expect(Math.abs(t100(LOW) - t100(NORMAL))).toBeLessThan(0.2);
  });
});

describe('brake-tap drift', () => {
  it('keeps the feel it had before downforce and ABS', () => {
    for (const ref of V5_DRIFT) {
      const d = brakeTapDrift(ref.v, ref.steer);
      const at = `${ref.v} km/h, steer ${ref.steer}`;
      expect(d.drift, at).toBeGreaterThan(0.9);
      // The tap costs a little more (the brakes grip harder now) ...
      expect(d.tap, at).toBeLessThan(1.8 * ref.tap);
      // ... and the slide on the gas gives it back.
      expect(d.after, at).toBeGreaterThan(ref.after - 3);
      expect(d.turned, at).toBeGreaterThan(0.9 * ref.turned);
      // Traction control does not light up for a drift.
      expect(d.lamp, at).toBe(0);
    }
  });

  it('a tap that starts a drift brakes far less than the full ABS brakes', () => {
    const straight = rolling(150 / 3.6);
    const v0 = kmh(straight);
    for (let n = 0; n < 20; n++) stepCar(straight, { steer: 0, gas: 0, brake: 1 }, flat);
    expect(brakeTapDrift(150, 0.6).tap).toBeLessThan(0.5 * (v0 - kmh(straight)));
  });

  it('a tap pressed together with the steering is capped from the first tick', () => {
    // Keys and touch buttons press steer and brake at once; the smoothed steering needs ~70 ms to
    // reach the drift threshold, and the full ABS brakes used to apply until then.
    for (const v of [150, 200]) {
      const c = rolling(v / 3.6);
      const v0 = speedOf(c);
      for (let n = 0; n < 6; n++) stepCar(c, { steer: 1, gas: 0, brake: 1 }, flat);
      expect((v0 - speedOf(c)) / 0.06, `${v} km/h`).toBeLessThan(28);
    }
  });

  it('a light analog brake trails without drifting', () => {
    const c = rolling(150 / 3.6);
    for (let n = 0; n < 20; n++) stepCar(c, { steer: 0.6, gas: 1, brake: 0 }, flat);
    for (let n = 0; n < 30; n++) stepCar(c, { steer: 0.6, gas: 0, brake: 0.45 }, flat);
    expect(c.drift).toBe(0);
  });
});

describe('assists', () => {
  it('auto-accelerate always drives with normal traction control', () => {
    expect(assistsFor('low', false).tc).toBe('low');
    expect(assistsFor('low', true)).toBe(DEFAULT_ASSISTS);
    expect(assistsFor('normal', false)).toBe(DEFAULT_ASSISTS);
    expect(assistsFor(undefined, false)).toBe(DEFAULT_ASSISTS);
    expect(assistsFor('off', false)).toBe(DEFAULT_ASSISTS);
    expect(Object.isFrozen(DEFAULT_ASSISTS)).toBe(true);
  });

  it('replays a low traction-control run from its input log, and only with the same setting', () => {
    const track = new Track(buildTrack('det-tc', 'St B Sx2 R S C S L2 S F'));
    const a = new RaceSession(track, LOW);
    const bot = new Autopilot(track);
    let spun = 0;
    while (a.phase !== 'finished' && a.ticks < 6000) {
      a.step(a.phase === 'racing' ? bot.controls(a) : NONE);
      spun = Math.max(spun, a.car.spin);
    }
    expect(a.phase).toBe('finished');
    expect(spun).toBeGreaterThan(0.2);
    const replay = (assists: Assists) => {
      const b = new RaceSession(track, assists);
      while (b.ticks < a.ticks && b.phase !== 'finished') {
        b.step(b.phase === 'racing' ? loggedControls(a.inputs, b.ticks) : NONE);
      }
      return b;
    };
    const same = replay(LOW);
    expect(same.finishTime).toBe(a.finishTime);
    expect(same.car.pos).toEqual(a.car.pos);
    // The same log under normal traction control drives a different car: assists must be replayed too.
    expect(replay(NORMAL).car.pos).not.toEqual(a.car.pos);
  }, 20000);
});
