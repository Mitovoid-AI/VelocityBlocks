import { describe, expect, it } from 'vitest';
import { DECK_EDGE, WALL_OFF } from '../src/core/constants';
import { qfromYawDir } from '../src/core/vec';
import { Autopilot } from '../src/game/bot';
import { loggedControls, RaceSession } from '../src/game/race';
import { buildTrack } from '../src/track/builder';
import { Track, type Column } from '../src/track/track';
import { traceRoute } from '../src/track/route';
import { createCar, speedOf, stepCar, type CarState, type Controls } from '../src/physics/vehicle';

const code = 'St B Sx2 R S C S L2 S U S J G G Sx3 D S F';
const GAS: Controls = { steer: 0, gas: 1, brake: 0 };
/** Settled ride height of the car centre above a flat surface at y = 0. */
const RIDE_Y = 0.87;

/** A free car (no race rules) at world (x, z) on the floor, heading (hx, hz) at speed v. */
function carAt(track: Track, x: number, z: number, hx: number, hz: number, v = 0): CarState {
  const car = createCar(track);
  car.pos = { x, y: RIDE_Y, z };
  car.rot = qfromYawDir(hx, hz);
  car.vel = { x: hx * v, y: 0, z: hz * v };
  return car;
}

/** A race past its countdown. */
function racing(track: Track): RaceSession {
  const r = new RaceSession(track);
  while (r.phase === 'countdown') r.step({ steer: 0, gas: 0, brake: 0 });
  return r;
}

const dist = (car: CarState, c: Column) => Math.hypot(car.pos.x - c.x, car.pos.z - c.z);

describe('simulation', () => {
  it('replays inputs deterministically', () => {
    const track = new Track(buildTrack('det', code));
    const a = new RaceSession(track);
    const bot = new Autopilot(track);
    // Counted from events: a flip respawn before the first checkpoint restarts the run and resets a.respawns.
    let autos = 0;
    while (a.phase !== 'finished' && a.ticks < 20000) {
      for (const e of a.step(a.phase === 'racing' ? bot.controls(a) : { steer: 0, gas: 0, brake: 0 })) {
        if (e.type === 'respawn') autos++;
      }
    }
    expect(a.phase).toBe('finished');
    expect(autos).toBe(0);

    // Re-simulate purely from the recorded input log.
    const b = new RaceSession(track);
    let n = 0;
    while (b.phase !== 'finished' && n < a.inputs.length + 1000) {
      b.step(b.phase === 'racing' ? loggedControls(a.inputs, b.ticks) : { steer: 0, gas: 0, brake: 0 });
      n++;
    }
    expect(b.finishTime).toBe(a.finishTime);
    expect(b.car.pos).toEqual(a.car.pos);
  }, 20000);

  it('accelerates to a sensible top speed on a long straight', () => {
    const track = new Track(buildTrack('drag', 'St Sx40 F'));
    const r = new RaceSession(track);
    let t100 = 0;
    for (let n = 0; n < 150 + 1200; n++) {
      r.step({ steer: 0, gas: 1, brake: 0 });
      if (!t100 && speedOf(r.car) * 3.6 >= 100) t100 = r.ticks;
    }
    const kmh = speedOf(r.car) * 3.6;
    expect(t100 / 100).toBeGreaterThan(1.2);
    expect(t100 / 100).toBeLessThan(3.5);
    expect(kmh).toBeGreaterThan(260);
    expect(kmh).toBeLessThan(360);
  });

  it('requires every checkpoint before the finish counts', () => {
    const track = new Track(buildTrack('cp', 'St S C S F'));
    expect(track.checkpointCount).toBe(1);
    const route = traceRoute(track);
    expect(route.complete).toBe(true);
  });
});

describe('off-road', () => {
  it('drives off a ground road onto the grass', () => {
    const track = new Track(buildTrack('leave', 'St Sx8 F'));
    const r = racing(track);
    for (let n = 0; n < 250; n++) r.step({ steer: n > 100 && n < 140 ? 1 : 0, gas: 1, brake: 0 });
    const l = track.blocks[0].toLocal(r.car.pos.x, r.car.pos.z);
    expect(r.car.onGrass).toBe(true);
    expect(Math.abs(l.a)).toBeGreaterThan(WALL_OFF + 0.3);
    expect(r.car.pos.y).toBeGreaterThan(0.6);
    expect(r.car.pos.y).toBeLessThan(1.2);
  });

  it('grass caps top speed', () => {
    const track = new Track(buildTrack('grass', 'St Sx40 F'));
    const s = track.blocks[3];
    const w = s.toWorld(40, 0);
    const car = carAt(track, w.x, w.z, s.fx, s.fz);
    for (let n = 0; n < 2000; n++) stepCar(car, GAS, track);
    const kmh = speedOf(car) * 3.6;
    expect(car.onGrass).toBe(true);
    expect(kmh).toBeGreaterThan(90);
    expect(kmh).toBeLessThan(110);
  });

  it('elevated decks keep barriers', () => {
    const track = new Track(buildTrack('high', '@1 St Sx8 F'));
    const r = racing(track);
    let maxA = 0;
    for (let n = 0; n < 400; n++) {
      r.step({ steer: n > 100 ? 1 : 0, gas: 1, brake: 0 });
      maxA = Math.max(maxA, Math.abs(track.blocks[0].toLocal(r.car.pos.x, r.car.pos.z).a));
    }
    expect(maxA).toBeLessThan(WALL_OFF);
    expect(r.car.pos.y).toBeGreaterThan(8);
  });

  it('checkpoint counts only between the posts', () => {
    for (const [off, taken] of [[0, 1], [5, 1], [9, 1], [14, 0], [20, 0]]) {
      const track = new Track(buildTrack('cp', 'St Sx2 C Sx2 F'));
      const r = racing(track);
      const w = track.blocks[0].toWorld(off, 12);
      r.car.pos.x = w.x;
      r.car.pos.z = w.z;
      for (let n = 0; n < 500 && r.phase === 'racing'; n++) r.step(GAS);
      expect(r.taken.size, `offset ${off}`).toBe(taken);
    }
  });

  it('gate posts are solid', () => {
    const track = new Track(buildTrack('post', 'St Sx2 C Sx2 F'));
    const cp = track.blocks[3];
    const post = track.columns.find((c) => c.kind === 'post' && Math.abs(cp.toLocal(c.x, c.z).a - DECK_EDGE) < 0.01)!;
    expect(post).toBeDefined();
    const r = racing(track);
    const w = track.blocks[0].toWorld(DECK_EDGE, 12);
    r.car.pos.x = w.x;
    r.car.pos.z = w.z;
    let minD = Infinity;
    for (let n = 0; n < 300; n++) {
      r.step(GAS);
      minD = Math.min(minD, dist(r.car, post));
    }
    // Front of the footprint (2.25) plus the post radius (0.5), less a little penetration.
    expect(minD).toBeGreaterThan(2.6);
    expect(r.taken.size).toBe(0);
  });

  it('head-on post hit pins until reversing', () => {
    const track = new Track(buildTrack('pin', 'St Sx2 C Sx2 F'));
    const cp = track.blocks[3];
    const p = cp.toWorld(DECK_EDGE, 16);
    const post = track.columns.find((c) => c.kind === 'post' && Math.hypot(c.x - p.x, c.z - p.z) < 0.01)!;
    const car = carAt(track, p.x - cp.fx * 6, p.z - cp.fz * 6, cp.fx, cp.fz, 5);
    for (let n = 0; n < 200; n++) stepCar(car, GAS, track);
    expect(speedOf(car)).toBeLessThan(1.5);
    expect(dist(car, post)).toBeGreaterThan(2.6);
    expect(dist(car, post)).toBeLessThan(2.9);
    for (let n = 0; n < 150; n++) stepCar(car, { steer: 0, gas: 0, brake: 1 }, track);
    expect(dist(car, post)).toBeGreaterThan(4);
  });

  it('embankment sides are solid above a kerb', () => {
    const track = new Track(buildTrack('emb', 'St S U S F'));
    const u = track.blocks[2];
    expect(u.embank).toBe(true);
    const side = (s: number) => {
      const w = u.toWorld(-25, s);
      const car = carAt(track, w.x, w.z, u.rx, u.rz, 20);
      let maxA = -Infinity, maxY = 0;
      for (let n = 0; n < 300; n++) {
        stepCar(car, GAS, track);
        maxA = Math.max(maxA, u.toLocal(car.pos.x, car.pos.z).a);
        maxY = Math.max(maxY, car.pos.y);
      }
      return { maxA, maxY };
    };
    // Deck 1.86 m up: a wall. The car stops with its nose at the face.
    const high = side(20);
    expect(high.maxA).toBeLessThanOrEqual(-(DECK_EDGE + 2.25) + 0.3);
    expect(high.maxY).toBeLessThan(1.3);
    // Deck 0.52 m up: climbable like a kerb.
    const low = side(10);
    expect(low.maxA).toBeGreaterThan(0);
  });

  it('embankment high end is solid', () => {
    const track = new Track(buildTrack('emb', 'St S U S F'));
    const u = track.blocks[2];
    // On the grass under the level-1 block, driving back toward the slope's 8 m end face.
    const w = u.toWorld(0, 64 + 20);
    const car = carAt(track, w.x, w.z, -u.fx, -u.fz, 20);
    let minB = Infinity, maxY = 0;
    for (let n = 0; n < 300; n++) {
      stepCar(car, GAS, track);
      minB = Math.min(minB, u.toLocal(car.pos.x, car.pos.z).b);
      maxY = Math.max(maxY, car.pos.y);
    }
    expect(minB).toBeGreaterThanOrEqual(64 + 2.25 - 0.3);
    expect(maxY).toBeLessThan(1.3);
  });

  it('start back wall is solid from behind', () => {
    const track = new Track(buildTrack('back', 'St Sx3 F'));
    const st = track.blocks[0];
    const w = st.toWorld(3, -20);
    const car = carAt(track, w.x, w.z, st.fx, st.fz);
    let maxB = -Infinity;
    for (let n = 0; n < 300; n++) {
      stepCar(car, GAS, track);
      maxB = Math.max(maxB, st.toLocal(car.pos.x, car.pos.z).b);
    }
    // Solid slab back face at b = -0.8 (drawn face -0.6, hull 0.2 inside the bumper); front reach 2.25.
    expect(maxB).toBeLessThanOrEqual(-0.8 - 2.25 + 0.3);
    expect(maxB).toBeGreaterThan(-0.8 - 2.25 - 0.5);
  });

  it('slope edge: the barrier and the embankment face never fight over the car', () => {
    // Running wide off the barrier-free lower half of a floor slope into its barrier zone used to
    // teleport the car metres sideways, and could leave it shaking on the edge for seconds.
    const track = new Track(buildTrack('edge', 'St S U S F'));
    const u = track.blocks[2];
    for (const [s0, deg, v0, steer] of [[16, 15, 20, 0], [22, 25, 8, 0.15]]) {
      const p = u.toWorld(7, s0), out = u.toWorld(8, s0), ahead = u.toWorld(7, s0 + 1);
      const k = (deg * Math.PI) / 180;
      const hx = (ahead.x - p.x) * Math.cos(k) + (out.x - p.x) * Math.sin(k);
      const hz = (ahead.z - p.z) * Math.cos(k) + (out.z - p.z) * Math.sin(k);
      const car = carAt(track, p.x, p.z, hx, hz, v0);
      car.pos.y = u.baseY + u.def.height(s0) + RIDE_Y;
      let worst = 0, big = 0;
      for (let n = 0; n < 500; n++) {
        const x0 = car.pos.x, z0 = car.pos.z;
        stepCar(car, { steer, gas: 1, brake: 0 }, track);
        // Positional correction on top of the velocity step: contact push-outs.
        const corr = Math.hypot(car.pos.x - x0 - car.vel.x * 0.01, car.pos.z - z0 - car.vel.z * 0.01);
        worst = Math.max(worst, corr);
        if (corr > 0.5) big++;
      }
      expect(worst).toBeLessThan(1);
      expect(big).toBeLessThanOrEqual(3);
    }
  });

  it('pillars are solid', () => {
    const track = new Track(buildTrack('pil', 'St S U Sx3 F'));
    const blk = track.blocks.find((b) => b.p.k === 1 && b.def.type === 'straight')!;
    const w = blk.toWorld(6.5, 16 - 20);
    const pillars = track.columns.filter((c) => c.kind === 'pillar');
    expect(pillars.length).toBeGreaterThan(0);
    const pil = pillars.reduce((a, b) => (Math.hypot(a.x - w.x, a.z - w.z) < Math.hypot(b.x - w.x, b.z - w.z) ? a : b));
    const car = carAt(track, w.x, w.z, blk.fx, blk.fz);
    let minD = Infinity;
    for (let n = 0; n < 300; n++) {
      stepCar(car, GAS, track);
      minD = Math.min(minD, dist(car, pil));
    }
    // Front of the footprint (2.25) plus the pillar radius (0.85), less a little penetration.
    expect(minD).toBeGreaterThan(2.9);
    expect(car.pos.y).toBeLessThan(1.3);
  });

  it('stadium boundary holds', () => {
    const track = new Track(buildTrack('bound', 'St Sx3 F'));
    const st = track.blocks[0];
    const sp = track.spawn();
    const car = carAt(track, sp.x, sp.z, st.rx, st.rz);
    const e = track.extents();
    const limit = Math.max(e.x1 * st.rx, e.x0 * st.rx) + Math.max(e.z1 * st.rz, e.z0 * st.rz);
    let maxR = -Infinity;
    for (let n = 0; n < 1500; n++) {
      stepCar(car, GAS, track);
      maxR = Math.max(maxR, car.pos.x * st.rx + car.pos.z * st.rz);
    }
    // Inner face of the perimeter wall, less the footprint half-width, plus a little penetration.
    expect(maxR).toBeLessThanOrEqual(limit - 0.5 - 1.0 + 0.1);
    expect(maxR).toBeGreaterThan(limit - 0.5 - 2.5);
  });
});
