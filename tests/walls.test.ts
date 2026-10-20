// Walls on all roads (Settings): barriers along every road edge, solid from the road and from the grass,
// calm around open ends, and nothing changes with the option off.
import { describe, expect, it } from 'vitest';
import { DECK_EDGE, WALL_OFF } from '../src/core/constants';
import { qfromYawDir } from '../src/core/vec';
import { VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { runBot } from '../src/game/bot';
import { classAuthorTimes, type AuthorTable } from '../src/game/medals';
import { RaceSession } from '../src/game/race';
import { createCar, speedOf, stepCar, upOf, vehicleSpec, type CarState, type Controls } from '../src/physics/vehicle';
import { projectLocal } from '../src/track/blocks';
import { buildTrack } from '../src/track/builder';
import { campaign } from '../src/track/campaign';
import { barrierRange, Track } from '../src/track/track';
import authorTimes from '../src/track/authorTimes.json';

const WALLS = { walls: true };
const GAS: Controls = { steer: 0, gas: 1, brake: 0 };
/** Outer face of an added barrier as a hull meets it from the grass (track.ts WALL_OUTER). */
const WALL_OUTER = DECK_EDGE + 0.2;

/** A free vehicle (no race rules) at world (x, z) on a deck at height y0, heading (hx, hz) at speed v. */
function carAt(track: Track, x: number, z: number, hx: number, hz: number, v = 0, cls: VehicleClass = 'car', y0 = 0): CarState {
  const car = createCar(track, cls);
  const l = Math.hypot(hx, hz);
  car.pos = { x, y: y0 + vehicleSpec(cls).rideHeight, z };
  car.rot = qfromYawDir(hx / l, hz / l);
  car.vel = { x: (hx / l) * v, y: 0, z: (hz / l) * v };
  return car;
}

/** Top speed (m/s) of a class flat out on a long straight (engine against drag and rolling losses). */
function topSpeed(cls: VehicleClass): number {
  const track = new Track(buildTrack('top', 'St Sx60 F'));
  const car = createCar(track, cls);
  let top = 0;
  for (let n = 0; n < 6000; n++) {
    stepCar(car, GAS, track);
    top = Math.max(top, speedOf(car));
  }
  return top;
}

function racing(track: Track): RaceSession {
  const r = new RaceSession(track);
  while (r.phase === 'countdown') r.step({ steer: 0, gas: 0, brake: 0 });
  return r;
}

/** Positional correction of the last step beyond its velocity step: contact push-outs (m). */
function stepped(car: CarState, ctl: Controls, track: Track): number {
  const x0 = car.pos.x, z0 = car.pos.z;
  stepCar(car, ctl, track);
  return Math.hypot(car.pos.x - x0 - car.vel.x * 0.01, car.pos.z - z0 - car.vel.z * 0.01);
}

/** Where (x, z) is against the ground blocks' interiors: on a road, inside a barrier line, or out on the grass. */
function sideState(track: Track, x: number, z: number): 'road' | 'wall' | 'out' {
  let best: 'road' | 'wall' | 'out' = 'out';
  for (const blk of track.blocks) {
    if (blk.baseY > 0.5) continue;
    const l = blk.toLocal(x, z);
    const h = projectLocal(blk.def, l.a, l.b, 0);
    if (!h || h.s < 1 || h.s > blk.def.length - 1) continue;
    const ad = Math.abs(h.d);
    if (ad < WALL_OFF - 0.3) return 'road';
    if (ad <= DECK_EDGE + 0.3) best = 'wall';
  }
  return best;
}

describe('walls on all roads', () => {
  it('keeps the car on a ground road it used to leave', () => {
    const track = new Track(buildTrack('leave', 'St Sx8 F'), WALLS);
    const r = racing(track);
    let maxA = 0;
    for (let n = 0; n < 400; n++) {
      r.step({ steer: n > 100 && n < 140 ? 1 : 0, gas: 1, brake: 0 });
      maxA = Math.max(maxA, Math.abs(track.blocks[0].toLocal(r.car.pos.x, r.car.pos.z).a));
    }
    expect(r.car.onGrass).toBe(false);
    expect(maxA).toBeLessThan(WALL_OFF);
  });

  it('is solid from the grass side too (no pull through onto the road)', () => {
    const track = new Track(buildTrack('out', 'St Sx8 F'), WALLS);
    const s = track.blocks[4];
    for (const deg of [90, 30]) {
      const k = (deg * Math.PI) / 180;
      // 25 m right of the centre line, driving back toward the road at `deg` to it.
      const p = s.toWorld(25, 0);
      const car = carAt(track, p.x, p.z, -s.rx * Math.sin(k) + s.fx * Math.cos(k), -s.rz * Math.sin(k) + s.fz * Math.cos(k), 15);
      let minA = Infinity, worst = 0;
      for (let n = 0; n < 400; n++) {
        worst = Math.max(worst, stepped(car, GAS, track));
        minA = Math.min(minA, track.blocks[0].toLocal(car.pos.x, car.pos.z).a);
      }
      expect(minA, `${deg} deg`).toBeGreaterThan(WALL_OUTER + 1.0 - 0.35);
      expect(worst, `${deg} deg`).toBeLessThan(1);
    }
  });

  it('holds a fast shallow hit without tunnelling', () => {
    const track = new Track(buildTrack('fast', 'St Sx12 F'), WALLS);
    const s = track.blocks[2];
    const k = (20 * Math.PI) / 180;
    const p = s.toWorld(0, 0);
    const car = carAt(track, p.x, p.z, s.fx * Math.cos(k) + s.rx * Math.sin(k), s.fz * Math.cos(k) + s.rz * Math.sin(k), 70);
    let maxA = 0;
    for (let n = 0; n < 300; n++) {
      stepCar(car, GAS, track);
      maxA = Math.max(maxA, Math.abs(track.blocks[0].toLocal(car.pos.x, car.pos.z).a));
    }
    expect(maxA).toBeLessThan(WALL_OFF);
    expect(speedOf(car)).toBeGreaterThan(30);
  });

  it('walls the lower half of a floor slope, which is no longer a kerb from the side', () => {
    const track = new Track(buildTrack('emb', 'St S U S F'), WALLS);
    const u = track.blocks[2];
    expect(barrierRange(u, true)).toEqual([0, 64]);
    expect(barrierRange(u)![0]).toBeCloseTo(32, 3);
    const w = u.toWorld(-25, 10);
    const car = carAt(track, w.x, w.z, u.rx, u.rz, 20);
    let maxA = -Infinity;
    for (let n = 0; n < 300; n++) {
      stepCar(car, GAS, track);
      maxA = Math.max(maxA, u.toLocal(car.pos.x, car.pos.z).a);
    }
    expect(maxA).toBeLessThan(-(WALL_OUTER + 2.25) + 0.4);
  });

  it('slope edge: running wide on the lower half meets a calm barrier', () => {
    const track = new Track(buildTrack('edge', 'St S U S F'), WALLS);
    const u = track.blocks[2];
    for (const [s0, deg, v0, steer] of [[16, 15, 20, 0], [22, 25, 8, 0.15], [6, 30, 30, 0.3]]) {
      const p = u.toWorld(7, s0), out = u.toWorld(8, s0), ahead = u.toWorld(7, s0 + 1);
      const k = (deg * Math.PI) / 180;
      const hx = (ahead.x - p.x) * Math.cos(k) + (out.x - p.x) * Math.sin(k);
      const hz = (ahead.z - p.z) * Math.cos(k) + (out.z - p.z) * Math.sin(k);
      const car = carAt(track, p.x, p.z, hx, hz, v0, 'car', u.baseY + u.def.height(s0));
      let worst = 0, maxA = 0;
      for (let n = 0; n < 500; n++) {
        worst = Math.max(worst, stepped(car, { steer, gas: 1, brake: 0 }, track));
        const l = u.toLocal(car.pos.x, car.pos.z);
        if (l.b >= 0 && l.b <= 64) maxA = Math.max(maxA, l.a);
      }
      expect(worst).toBeLessThan(1);
      expect(maxA).toBeLessThan(WALL_OFF);
    }
  }, 30000);

  it('tight U-turn: the inner wall is solid and calm', () => {
    const track = new Track(buildTrack('u', 'St Sx2 R R Sx2 F'), WALLS);
    const r = racing(track);
    let worst = 0;
    for (let n = 0; n < 1500 && r.phase === 'racing'; n++) {
      const x0 = r.car.pos.x, z0 = r.car.pos.z;
      r.step({ steer: n > 150 ? 1 : 0, gas: 0.6, brake: 0 });
      worst = Math.max(worst, Math.hypot(r.car.pos.x - x0 - r.car.vel.x * 0.01, r.car.pos.z - z0 - r.car.vel.z * 0.01));
      expect(r.car.onGrass).toBe(false);
    }
    expect(worst).toBeLessThan(1);
  }, 30000);

  it('picks the face by the car centre, and changes nothing with the option off', () => {
    const data = buildTrack('g', 'St Sx2 F');
    const off = new Track(data);
    const b = off.blocks[1];
    const p = b.toWorld(10.9, 16);
    expect(off.walls).toBe(false);
    expect(off.wallAt(p.x, 0.9, p.z)).toBeNull();
    const on = new Track(data, WALLS);
    const inward = (w: { nx: number; nz: number } | null) => w!.nx * b.rx + w!.nz * b.rz;
    // Centre on the road: pushed back towards the centre line, by the depth past the barrier face.
    const road = b.toWorld(8, 16);
    const w1 = on.wallAt(p.x, 0.9, p.z, road.x, road.z)!;
    expect(inward(w1)).toBeCloseTo(-1);
    expect(w1.depth).toBeCloseTo(10.9 - WALL_OFF, 6);
    // Centre on the grass: pushed out, by the depth inside the outer face.
    const grass = b.toWorld(13, 16);
    const w2 = on.wallAt(p.x, 0.9, p.z, grass.x, grass.z)!;
    expect(inward(w2)).toBeCloseTo(1);
    expect(w2.depth).toBeCloseTo(WALL_OUTER - 10.9, 6);
    // Deep in the grass beyond the slab: nothing.
    const far = b.toWorld(12, 16);
    expect(on.wallAt(far.x, 0.9, far.z, grass.x, grass.z)).toBeNull();
    // Raised decks keep their one-sided barrier either way.
    const high = new Track(buildTrack('h', '@1 St Sx2 F'), WALLS);
    const hb = high.blocks[1];
    const hp = hb.toWorld(12, 16), hc = hb.toWorld(14, 16);
    const w3 = high.wallAt(hp.x, 8.9, hp.z, hc.x, hc.z)!;
    expect(w3.nx * hb.rx + w3.nz * hb.rz).toBeCloseTo(-1);
  });

  it('no class gets onto a floor slope through its side barrier from the grass', () => {
    // The truck's low barrier probes once slipped between the barrier and the slope's solid side face, and
    // the bike's front rays (ahead of its short hull) could reach the low deck over the barrier slab.
    const track = new Track(buildTrack('emb', 'St S U S F'), WALLS);
    const u = track.blocks[2];
    const L = u.def.length;
    for (const cls of VEHICLE_CLASSES) {
      const on: string[] = [];
      let runs = 0;
      for (const side of [-1, 1]) {
        for (let s0 = 2; s0 <= L / 2 + 2; s0 += 0.5) {
          for (const deg of [30, 60, 90]) {
            for (const v of [6, 12, 20]) {
              runs++;
              const k = (deg * Math.PI) / 180;
              // 4 m outside the barrier's outer face, driving in at `deg` to the road.
              const p = u.toWorld(side * (WALL_OUTER + 4), s0);
              const da = -side * Math.sin(k), db = Math.cos(k);
              const car = carAt(track, p.x, p.z, u.rx * da + u.fx * db, u.rz * da + u.fz * db, v, cls);
              for (let n = 0; n < 250; n++) {
                stepCar(car, GAS, track);
                const l = u.toLocal(car.pos.x, car.pos.z);
                if (Math.abs(l.a) < WALL_OFF - 0.5 && l.b > 0 && l.b < L) {
                  on.push(`${side > 0 ? 'L' : 'R'} s${s0} ${deg}deg ${v}m/s`);
                  break;
                }
              }
            }
          }
        }
      }
      expect(runs).toBeGreaterThan(300);
      expect(on, cls).toEqual([]);
    }
  }, 90000);

  // Reviewer sweep: cars on the grass driving at the added barriers of curves, hairpins and a jump.
  for (const [label, code] of [
    ['curves', 'St Sx2 R Sx2 L Sx2 R R Sx2 F'],
    ['jump', 'St Sx3 J G S Sx2 F'],
  ] as const) {
    it(`outside approaches never cross onto the road through a wall (${label})`, () => {
      const track = new Track(buildTrack(label, code), WALLS);
      let runs = 0, pulls = 0, worst = 0;
      for (const blk of track.blocks) {
        if (blk.baseY > 0.5 || blk.def.gate) continue;
        const L = blk.def.length;
        for (const sFrac of [0.02, 0.3, 0.7, 0.98]) {
          for (const side of [-1, 1]) {
            const s = L * sFrac;
            const p = blk.pointAt(s, side * 15.5), q = blk.pointAt(s, 0);
            if (track.surfaceAt(p.x, 2, p.z).road) continue;
            for (const ang of [-60, -30, 0, 30, 60]) {
              for (const v of [6, 30]) {
                const dx = q.x - p.x, dz = q.z - p.z, k = (ang * Math.PI) / 180;
                const car = carAt(track, p.x, p.z, dx * Math.cos(k) - dz * Math.sin(k), dx * Math.sin(k) + dz * Math.cos(k), v);
                runs++;
                let prev = sideState(track, car.pos.x, car.pos.z);
                const recent: number[] = [];
                for (let n = 0; n < 150; n++) {
                  const corr = stepped(car, GAS, track);
                  worst = Math.max(worst, corr);
                  recent.push(corr);
                  if (recent.length > 4) recent.shift();
                  const now = sideState(track, car.pos.x, car.pos.z);
                  // A car that rolls over the 1.4 m barrier is not a pull-through.
                  if (prev !== 'road' && now === 'road' && Math.max(...recent) > 0.3 && upOf(car).y > 0.5) {
                    pulls++;
                    break;
                  }
                  if (now !== 'road') prev = now;
                }
              }
            }
          }
        }
      }
      expect(runs).toBeGreaterThan(100);
      expect(pulls).toBe(0);
      expect(worst).toBeLessThanOrEqual(0.75);
    }, 60000);
  }

  it('a car on the jump-gap grass meets the landing block calmly at the barrier line', () => {
    // Open ends: the barrier stops where the road does, so a car can come round its end astride the line.
    const track = new Track(buildTrack('gap', 'St Sx3 J G S Sx2 F'), WALLS);
    const land = track.blocks.find((b) => b.index === 5)!;
    let worst = 0;
    for (const d of [-12.5, -11.5, -10.84, -10.4, 10.4, 10.84, 11.5, 12.5]) {
      for (const ang of [-40, -15, 0, 15, 40]) {
        for (const v of [5, 15]) {
          const p = land.toWorld(d, -6);
          const k = (ang * Math.PI) / 180;
          const car = carAt(track, p.x, p.z, land.fx * Math.cos(k) + land.rx * Math.sin(k), land.fz * Math.cos(k) + land.rz * Math.sin(k), v);
          for (let n = 0; n < 150; n++) worst = Math.max(worst, stepped(car, GAS, track));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(0.75);
  }, 30000);

  for (const cls of VEHICLE_CLASSES) {
    it(`holds a ${cls} that slides into a ground barrier at speed, up to its top speed and beyond with the nitro`, () => {
      // Inside hits at 40 m/s up to past top speed with the nitro or a pad (92 m/s, 331 km/h) and 8..35 degrees,
      // sliding up to 60 degrees: the centre stays on the road, as a raised barrier holds it.
      const track = new Track(buildTrack('slide', 'St Sx16 F'), WALLS);
      const blk = track.blocks[3];
      const top = topSpeed(cls);
      const escaped: string[] = [];
      let runs = 0, beyond = 0;
      for (const v of [40, 60, 84, 92]) {
        for (const velDeg of [8, 20, 35]) {
          for (const slipDeg of [-60, 0, 30]) {
            runs++;
            const p = blk.pointAt(4, 4);
            const kv = (velDeg * Math.PI) / 180, kh = ((velDeg + slipDeg) * Math.PI) / 180;
            const car = carAt(track, p.x, p.z, blk.fx * Math.cos(kh) + blk.rx * Math.sin(kh), blk.fz * Math.cos(kh) + blk.rz * Math.sin(kh), 0, cls);
            car.vel = { x: (blk.fx * Math.cos(kv) + blk.rx * Math.sin(kv)) * v, y: 0, z: (blk.fz * Math.cos(kv) + blk.rz * Math.sin(kv)) * v };
            let maxA = -Infinity;
            for (let n = 0; n < 120; n++) {
              stepCar(car, { steer: 0, gas: 0.5, brake: 0 }, track);
              maxA = Math.max(maxA, track.blocks[0].toLocal(car.pos.x, car.pos.z).a);
            }
            if (maxA > DECK_EDGE + 0.5) escaped.push(`${v} m/s ${velDeg}/${slipDeg}`);
            if (maxA > DECK_EDGE + 0.5 && v > top) beyond++;
          }
        }
      }
      expect(runs).toBe(36);
      expect(top).toBeGreaterThan(70);
      // Past its own top speed the car can still clear a barrier in the steepest slide (as it does a raised
      // one: physics v6, kept bit for bit); the bike's hull now reaches its ray anchors and holds every case.
      expect(escaped.length - beyond, `${cls} (top ${top.toFixed(1)} m/s): ${escaped.join(', ')}`).toBe(0);
      expect(beyond, `${cls}: ${escaped.join(', ')}`).toBeLessThanOrEqual(cls === 'car' ? 1 : 0);
    }, 30000);
  }

  it('a hop next to a barrier stays inside it for every class (the truck is tall)', () => {
    // A 1.4 m barrier on a raised deck; the vehicle hits it at a shallow angle with an upward kick.
    const track = new Track(buildTrack('hop', '@1 St Sx16 F'));
    const blk = track.blocks[3];
    for (const cls of VEHICLE_CLASSES) {
      let through = 0;
      for (const v of [22, 42, 61]) {
        for (const ang of [10, 20, 35]) {
          for (const vy of [0, 3, 6]) {
            const p = blk.pointAt(4, 6);
            const k = (ang * Math.PI) / 180;
            const car = carAt(track, p.x, p.z, blk.fx * Math.cos(k) + blk.rx * Math.sin(k), blk.fz * Math.cos(k) + blk.rz * Math.sin(k), v, cls, blk.baseY);
            car.vel.y = vy;
            let maxA = -Infinity;
            for (let n = 0; n < 200; n++) {
              stepCar(car, GAS, track);
              maxA = Math.max(maxA, track.blocks[0].toLocal(car.pos.x, car.pos.z).a);
            }
            if (maxA > DECK_EDGE + 0.5) through++;
          }
        }
      }
      expect(through, cls).toBe(0);
    }
  }, 30000);

  it('the autopilot laps every campaign track cleanly with walls on, in every class, in its author time', () => {
    // The menu's attract lap drives with the player's wall setting and has no respawn handling. Medal
    // thresholds are shared by both wall modes on the grounds that the author lap is the same with walls on.
    for (const cls of VEHICLE_CLASSES) {
      const author = classAuthorTimes(authorTimes as AuthorTable, cls)!;
      for (const ct of campaign()) {
        const r = runBot(new Track(ct.data, WALLS), 300, { vehicle: cls });
        expect(r.finished, `${cls} ${ct.id}`).toBe(true);
        expect(r.allRespawns, `${cls} ${ct.id}`).toBe(0);
        expect(r.time, `${cls} ${ct.id} walls parity`).toBe(author[ct.id]);
      }
    }
  }, 120000);
});
