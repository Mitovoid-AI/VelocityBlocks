// Vehicle classes: every class's spec is well formed, settles, matches its planners' limits, stays upright
// through the usual abuse, replays deterministically, and keeps its own drift character. Feel bands lock
// the tuning in, so a retune is a deliberate change (with a VEHICLE_REV bump for that class).
import { describe, expect, it } from 'vitest';
import { GRAVITY, VEHICLE_REV } from '../src/core/constants';
import { qfromYawDir } from '../src/core/vec';
import { entryKey, VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { Autopilot } from '../src/game/bot';
import { decodeGhost, encodeGhost, GhostRecorder } from '../src/game/ghost';
import { loggedControls, RaceSession } from '../src/game/race';
import { parseEntryKey } from '../src/game/racingLine';
import {
  assistsFor,
  BIKE,
  CAR,
  cloneCar,
  createCar,
  DEFAULT_ASSISTS,
  forwardOf,
  lineHalfWidth,
  maxBrakeDecel,
  maxLatAccel,
  speedOf,
  stepCar,
  TRUCK,
  upOf,
  vehicleSpec,
  WHEEL_ANCHORS,
  WHEEL_RADIUS,
  type Assists,
  type CarState,
  type Controls,
} from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';

const flat = {
  surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null }),
  wallAt: () => null,
  sideAt: () => null,
  columnsNear: () => null,
  spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
} as unknown as Track;
const NONE: Controls = { steer: 0, gas: 0, brake: 0 };
const kmh = (c: CarState) => speedOf(c) * 3.6;

/** A vehicle rolling straight along +z at v m/s, settled on its springs. */
function rolling(cls: VehicleClass, v: number, a: Assists = DEFAULT_ASSISTS): CarState {
  const c = createCar(flat, cls);
  for (let n = 0; n < 200; n++) {
    stepCar(c, NONE, flat, a);
    c.vel = { x: 0, y: 0, z: v };
  }
  return c;
}

/** Body slip angle in degrees (heading vs direction of travel). */
function beta(c: CarState): number {
  const f = forwardOf(c);
  return Math.abs((Math.atan2(f.x * c.vel.z - f.z * c.vel.x, f.x * c.vel.x + f.z * c.vel.z) * 180) / Math.PI);
}

/** Steady lateral acceleration with speed held at v, averaged over the last second. */
function skidpad(cls: VehicleClass, v: number, steer: number): number {
  const c = rolling(cls, v);
  let prev = Math.atan2(c.vel.x, c.vel.z), a = 0;
  for (let n = 0; n < 400; n++) {
    stepCar(c, { steer, gas: 0, brake: 0 }, flat);
    const s = Math.hypot(c.vel.x, c.vel.z);
    c.vel.x *= v / s;
    c.vel.z *= v / s;
    const h = Math.atan2(c.vel.x, c.vel.z);
    let dh = h - prev;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    prev = h;
    if (n >= 300) a += (Math.abs(dh) / 0.01) * v;
  }
  return a / 100;
}

const latLimit = (cls: VehicleClass, v: number) => {
  let best = 0;
  for (let s = 0.1; s <= 1.001; s += 0.05) best = Math.max(best, skidpad(cls, v, s));
  return best;
};

describe('vehicle specs', () => {
  it('every class has a well-formed spec and a revision', () => {
    for (const cls of VEHICLE_CLASSES) {
      const S = vehicleSpec(cls);
      expect(S.vehicle).toBe(cls);
      expect(typeof VEHICLE_REV[cls]).toBe('number');
      // Anchors FL, FR, RL, RR mirror in x, axles level.
      const [fl, fr, rl, rr] = S.wheels;
      expect(fr).toEqual({ x: -fl.x, y: fl.y, z: fl.z });
      expect(rr).toEqual({ x: -rl.x, y: rl.y, z: rl.z });
      expect(rl.y).toBe(fl.y);
      expect(S.wheelbase).toBe(fl.z - rl.z);
      expect(S.ray).toBe(S.rest + S.wheelRadius);
      expect(S.hard).toBe(S.ray - S.rest - 0.08);
      expect(S.rideHeight).toBeCloseTo(S.ray - GRAVITY / 4 / S.kSpring - fl.y, 12);
      // The hull in the order impacts depend on: x of [+x, -x], y of [low, high], z of [front, rear].
      expect(S.hull.length).toBe(8);
      const xs = [...new Set(S.hull.map((h) => h.x))], ys = [...new Set(S.hull.map((h) => h.y))], zs = [...new Set(S.hull.map((h) => h.z))];
      expect(S.hull).toEqual(xs.flatMap((x) => ys.flatMap((y) => zs.map((z) => ({ x, y, z })))));
      expect(xs[0]).toBe(-xs[1]);
      expect(ys[0]).toBeLessThan(0);
      // The column footprint matches the hull.
      expect(S.foot).toEqual({ w: xs[0], f: zs[0], r: -zs[1] });
      // Every class's barrier probes sit about as high above the deck as the car's.
      expect(S.rideHeight + ys[0] + S.wallProbe).toBeGreaterThan(0.75);
      expect(S.rideHeight + ys[0] + S.wallProbe).toBeLessThan(0.95);
      expect(lineHalfWidth(S)).toBeGreaterThan(7.5);
    }
  });

  it('the car spec is the physics v6 car', () => {
    expect(CAR.wheels).toEqual([
      { x: 0.95, y: -0.15, z: 1.45 },
      { x: -0.95, y: -0.15, z: 1.45 },
      { x: 0.95, y: -0.15, z: -1.35 },
      { x: -0.95, y: -0.15, z: -1.35 },
    ]);
    expect(WHEEL_ANCHORS).toBe(CAR.wheels);
    expect(WHEEL_RADIUS).toBe(0.36);
    expect(CAR).toMatchObject({
      rest: 0.45, kSpring: 32, cDamp: 3.4, kBump: 260, kAntiroll: 26, tyreLever: 0.18, muRoad: 2.1, muFront: 1.1,
      peakSlipF: 0.085, peakSlipR: 0.075, slideGrip: 0.85, driftGrip: 0.62, brakeDrift: true, airStraighten: false,
      aeroCl: 0.0034, aeroFront: 0.44, drag: 0.00026, brakeMax: 52, brakeFront: 0.6, driftBrakeDecel: 24,
      reverseMax: 16, steerLock: 0.52, steerGeo: 0.7, steerSlip: 1, wheelbase: 2.8, latReach: 0.985, latLock: 42,
      steerApply: 5, steerRelease: 9, foot: { w: 1, f: 2.25, r: 2.15 }, driftYaw: 3.2, airRoll: 3, airPitch: 1.2,
      wallProbe: 0.3, respawnY: 0.9,
    });
    expect(CAR.latTable).toBeUndefined();
    expect(CAR.invI).toEqual({ x: 1 / 2.4, y: 1 / 2.6, z: 1 / 1.6 });
    expect(CAR.ray).toBe(0.81);
    expect(lineHalfWidth(CAR)).toBe(8);
  });

  it('vehicles carry their class through creation, cloning and checkpoint respawns', () => {
    const track = new Track(buildTrack('r', 'St S C Sx4 F'));
    for (const cls of VEHICLE_CLASSES) {
      const S = vehicleSpec(cls);
      const c = createCar(track, cls);
      expect(c.vehicle).toBe(cls);
      expect(c.pos.y).toBeCloseTo(track.spawn().y + S.rideHeight, 12);
      expect(cloneCar(c).vehicle).toBe(cls);
      const r = new RaceSession(track, DEFAULT_ASSISTS, cls);
      expect(r.vehicle).toBe(cls);
      while (r.phase === 'countdown') r.step(NONE);
      for (let n = 0; n < 600 && !r.hasRespawnPoint; n++) r.step({ steer: 0, gas: 1, brake: 0 });
      expect(r.hasRespawnPoint).toBe(true);
      r.respawn();
      expect(r.car.vehicle).toBe(cls);
      expect(r.car.pos.y).toBeCloseTo(S.respawnY, 12);
    }
    // An unknown class (a tampered save) drives as the car.
    expect(vehicleSpec('boat' as VehicleClass)).toBe(CAR);
  });

  it('every class settles level on its springs', () => {
    for (const cls of VEHICLE_CLASSES) {
      const S = vehicleSpec(cls);
      const c = createCar(flat, cls);
      for (let n = 0; n < 200; n++) stepCar(c, NONE, flat);
      expect(c.grounded, cls).toBe(4);
      expect(upOf(c).y, cls).toBeGreaterThan(0.999);
      // The springs carry the weight between them (the axles are not equally loaded).
      const mean = c.comp.reduce((a, b) => a + b, 0) / 4;
      expect(Math.abs(mean - GRAVITY / 4 / S.kSpring), cls).toBeLessThan(1e-3);
      expect(c.pos.y, cls).toBeCloseTo(S.rideHeight, 2);
    }
  });
});

describe('limits for speed planners, per class', () => {
  it('maxLatAccel matches the skidpad', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const v of [15, 25, 50, 80]) {
        const r = maxLatAccel(v, vehicleSpec(cls)) / latLimit(cls, v);
        expect(r, `${cls} ${v} m/s`).toBeGreaterThan(cls === 'car' ? 0.94 : 0.97);
        expect(r, `${cls} ${v} m/s`).toBeLessThan(cls === 'car' ? 1.04 : 1.03);
      }
    }
  }, 30000);

  it('maxBrakeDecel matches a full stop on the brakes', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const v of [10, 50, 80]) {
        const c = rolling(cls, v);
        const v0 = speedOf(c);
        for (let n = 0; n < 10; n++) stepCar(c, { steer: 0, gas: 0, brake: 1 }, flat);
        const r = maxBrakeDecel(v, vehicleSpec(cls)) / ((v0 - speedOf(c)) / 0.1);
        expect(r, `${cls} ${v} m/s`).toBeGreaterThan(0.95);
        expect(r, `${cls} ${v} m/s`).toBeLessThan(1.05);
      }
    }
  }, 20000);
});

describe('stability, per class', () => {
  it('a lane change at top speed settles', () => {
    for (const cls of VEHICLE_CLASSES) {
      const c = rolling(cls, cls === 'truck' ? 70 : 80);
      for (let n = 0; n < 300; n++) stepCar(c, { steer: n < 25 ? 1 : 0, gas: 1, brake: 0 }, flat);
      expect(beta(c), cls).toBeLessThan(1);
      expect(Math.abs(c.angVel.y), cls).toBeLessThan(0.01);
    }
  });

  it('a second of full lock never rolls it over', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const v of [60, 120, 200]) {
        const c = rolling(cls, v / 3.6);
        let minUp = 1;
        for (let n = 0; n < 100; n++) {
          stepCar(c, { steer: 1, gas: 1, brake: 0 }, flat);
          minUp = Math.min(minUp, upOf(c).y);
        }
        expect(minUp, `${cls} ${v} km/h`).toBeGreaterThan(0.9);
      }
    }
  });

  it('a 3 m drop at 200 km/h lands upright', () => {
    for (const cls of VEHICLE_CLASSES) {
      const c = rolling(cls, 200 / 3.6);
      c.pos.y += 3;
      let minUp = 1;
      for (let n = 0; n < 300; n++) {
        stepCar(c, { steer: 0, gas: 1, brake: 0 }, flat);
        minUp = Math.min(minUp, upOf(c).y);
      }
      expect(minUp, cls).toBeGreaterThan(0.9);
      expect(c.grounded, cls).toBe(4);
    }
  });

  it('a 20 degree barrier glance at 150 km/h stays upright', () => {
    const track = new Track(buildTrack('glance', '@1 St Sx12 F'));
    const blk = track.blocks[2];
    for (const cls of VEHICLE_CLASSES) {
      const c = createCar(track, cls);
      const p = blk.pointAt(4, 5);
      const k = (20 * Math.PI) / 180;
      c.pos = { x: p.x, y: blk.baseY + vehicleSpec(cls).rideHeight, z: p.z };
      c.rot = qfromYawDir(blk.fx * Math.cos(k) + blk.rx * Math.sin(k), blk.fz * Math.cos(k) + blk.rz * Math.sin(k));
      const f = forwardOf(c);
      c.vel = { x: (f.x * 150) / 3.6, y: 0, z: (f.z * 150) / 3.6 };
      let minUp = 1;
      for (let n = 0; n < 300; n++) {
        stepCar(c, { steer: 0, gas: 1, brake: 0 }, track);
        minUp = Math.min(minUp, upOf(c).y);
      }
      expect(minUp, cls).toBeGreaterThan(0.8);
      expect(Math.abs(blk.toLocal(c.pos.x, c.pos.z).a), cls).toBeLessThan(10.6);
    }
  });
});

describe('drift character', () => {
  /** Max body slip (deg) over a 0.3 s full brake with full lock at v km/h, then 1 s of gas and full lock. */
  function tap(cls: VehicleClass, v: number) {
    const c = rolling(cls, v / 3.6);
    let maxBeta = 0, maxDrift = 0;
    for (let n = 0; n < 130; n++) {
      stepCar(c, n < 30 ? { steer: 1, gas: 0, brake: 1 } : { steer: 1, gas: 1, brake: 0 }, flat);
      maxBeta = Math.max(maxBeta, beta(c));
      maxDrift = Math.max(maxDrift, c.drift);
    }
    return { maxBeta, maxDrift };
  }

  it('the car brake-tap drifts; the bike and the truck grip and never spin', () => {
    expect(tap('car', 150).maxDrift).toBeGreaterThan(0.9);
    for (const cls of ['bike', 'truck'] as const) {
      for (const v of [110, 150, 200]) {
        const t = tap(cls, v);
        expect(t.maxDrift, `${cls} ${v}`).toBe(0);
        expect(t.maxBeta, `${cls} ${v}`).toBeLessThan(20);
      }
    }
  });

  it('a brake tap with the steering held brakes the bike and the truck at full strength', () => {
    for (const cls of ['bike', 'truck'] as const) {
      const steered = rolling(cls, 150 / 3.6), straight = rolling(cls, 150 / 3.6);
      const v0 = speedOf(steered);
      for (let n = 0; n < 6; n++) {
        stepCar(steered, { steer: 1, gas: 0, brake: 1 }, flat);
        stepCar(straight, { steer: 0, gas: 0, brake: 1 }, flat);
      }
      // The car's tap caps the brakes at its drift decel; these keep (nearly) all of their ABS brakes.
      expect(v0 - speedOf(steered), cls).toBeGreaterThan(0.8 * (v0 - speedOf(straight)));
    }
  });
});

describe('landing assist', () => {
  it('the bike and truck straighten their front wheels in the air; the car does not', () => {
    for (const cls of VEHICLE_CLASSES) {
      const c = rolling(cls, 40);
      for (let n = 0; n < 20; n++) stepCar(c, { steer: 1, gas: 1, brake: 0 }, flat);
      expect(c.steer).toBeGreaterThan(0.5);
      c.pos.y += 6;
      for (let n = 0; n < 40; n++) stepCar(c, { steer: 1, gas: 1, brake: 0 }, flat);
      expect(c.grounded).toBe(0);
      if (vehicleSpec(cls).airStraighten) expect(c.steer, cls).toBe(0);
      else expect(c.steer, cls).toBe(1);
    }
  });
});

describe('analog steering assist', () => {
  it('follows tilt or the wheel faster, and keys and buttons as before', () => {
    for (const cls of VEHICLE_CLASSES) {
      const S = vehicleSpec(cls);
      const keys = rolling(cls, 20), analog = rolling(cls, 20, assistsFor('normal', false, true));
      // The first tick off centre counts as a return (the release rate); then the apply rate.
      for (let n = 0; n < 2; n++) {
        stepCar(keys, { steer: 1, gas: 0, brake: 0 }, flat, DEFAULT_ASSISTS);
        stepCar(analog, { steer: 1, gas: 0, brake: 0 }, flat, assistsFor('normal', false, true));
      }
      expect(keys.steer, cls).toBeCloseTo((S.steerRelease + S.steerApply) * 0.01, 12);
      expect(analog.steer, cls).toBeCloseTo((S.steerReleaseAnalog + S.steerApplyAnalog) * 0.01, 12);
      expect(S.steerApplyAnalog).toBeGreaterThan(S.steerApply);
      expect(S.steerReleaseAnalog).toBeGreaterThan(S.steerRelease);
    }
    expect(CAR.steerApplyAnalog).toBe(10);
    expect(CAR.steerReleaseAnalog).toBe(14);
  });
});

describe('determinism, per class', () => {
  it('replays a run from its input log', () => {
    const track = new Track(buildTrack('det', 'St B Sx2 R S C S L2 S U S J G G Sx3 D S F'));
    for (const cls of ['bike', 'truck'] as const) {
      const a = new RaceSession(track, DEFAULT_ASSISTS, cls);
      const bot = new Autopilot(track, cls);
      while (a.phase !== 'finished' && a.ticks < 20000) a.step(a.phase === 'racing' ? bot.controls(a) : NONE);
      expect(a.phase, cls).toBe('finished');
      expect(a.ghost!.vehicle).toBe(cls);
      const b = new RaceSession(track, DEFAULT_ASSISTS, cls);
      let n = 0;
      while (b.phase !== 'finished' && n < a.inputs.length + 1000) {
        b.step(b.phase === 'racing' ? loggedControls(a.inputs, b.ticks) : NONE);
        n++;
      }
      expect(b.finishTime, cls).toBe(a.finishTime);
      expect(b.car.pos, cls).toEqual(a.car.pos);
    }
  }, 30000);
});

describe('ghosts and keys per class', () => {
  it('ghosts keep their class and revision; car ghosts keep the old format byte for byte', () => {
    const rec = new GhostRecorder();
    const c = createCar(flat, 'bike');
    for (let t = 0; t < 10; t += 2) rec.record(t, c);
    const bike = rec.finish(1234, [500], 'bike');
    expect(bike.vehicle).toBe('bike');
    expect(bike.rev).toBe(VEHICLE_REV.bike);
    const back = decodeGhost(encodeGhost(bike))!;
    expect(back.vehicle).toBe('bike');
    expect(back.rev).toBe(VEHICLE_REV.bike);
    expect(Array.from(back.samples)).toEqual(Array.from(bike.samples));
    const car = rec.finish(1234, [500]);
    const text = encodeGhost(car);
    expect(Object.keys(JSON.parse(text))).toEqual(['p', 't', 'i', 'c', 's']);
    // A ghost saved before vehicle classes reads as the car's, revision 0.
    const legacy = decodeGhost(text)!;
    expect(legacy.vehicle).toBe('car');
    expect(legacy.rev).toBe(0);
  });

  it('entry keys parse back into track, class and wall mode', () => {
    for (const base of ['c:A01', 'u:3f9kq2']) {
      for (const vehicle of VEHICLE_CLASSES) {
        for (const walls of [false, true]) {
          expect(parseEntryKey(entryKey(base, vehicle, walls))).toEqual({ base, vehicle, walls });
        }
      }
    }
    expect(parseEntryKey('c:A01@truck2|w')).toEqual({ base: 'c:A01', vehicle: 'truck', walls: true });
    expect(parseEntryKey('c:A01@boat')).toEqual({ base: 'c:A01@boat', vehicle: 'car', walls: false });
  });
});

describe('class identities', () => {
  it('each class keeps its character', () => {
    // Specs side by side: the bike quick and light, the truck heavy, long and tall.
    expect(BIKE.foot.w).toBeLessThan(CAR.foot.w);
    expect(TRUCK.foot.f + TRUCK.foot.r).toBeGreaterThan(CAR.foot.f + CAR.foot.r);
    expect(TRUCK.hull[2].y).toBeGreaterThan(2 * CAR.hull[2].y);
    expect(TRUCK.invI.y).toBeLessThan(CAR.invI.y);
    expect(kmh(rolling('car', 0))).toBe(0);
  });
});
