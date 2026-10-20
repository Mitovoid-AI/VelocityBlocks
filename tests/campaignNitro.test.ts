// The nitro for button players on the campaign (a file of its own, so it runs beside tests/campaign.test.ts).
import { describe, expect, it } from 'vitest';
import { Autopilot, runBot } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { assistsFor, DEFAULT_ASSISTS, NO_CONTROLS, type Controls } from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { nearestPoint, traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';
import { TOUCH_DRIVERS } from './classGates';

// Single laps are chaotic (a few ticks of start delay change which bump a car meets at which speed), so the
// car's button driver with the nitro is also run with its start held back: the nitro rule must not make a
// button player crash where they would not without it (the design's first rule spun out on A10 every time).
describe('campaign: the nitro for button players', () => {
  it('the car with the nitro finishes every track cleanly from a range of start delays', () => {
    const bad: string[] = [];
    for (const delay of [3, 8, 13, 18, 23, 28]) {
      for (const driver of ['nitro-normal', 'nitro-low'] as const) {
        const d = TOUCH_DRIVERS[driver];
        for (const [id, , name, code] of CAMPAIGN_DEFS) {
          let k = delay;
          const filter = (c: Controls) => (k-- > 0 ? { steer: 0, gas: 0, brake: 0 } : d.filter(c));
          const res = runBot(new Track(buildTrack(`${id} ${name}`, code)), 300, { assists: assistsFor(d.tc, d.auto), filter });
          if (!res.finished || res.allRespawns) bad.push(`${id} ${driver} +${delay}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120000);
});

// A player may fire anywhere, the autopilot's rule aside: a nitro fired on the run-up to a jump must not
// throw the vehicle off the road or over a checkpoint (the push stops in the air, braking ends it). Every
// class: the bike once rolled after landing A11's second jump nose first (its hull now reaches its rays).
describe.each(VEHICLE_CLASSES)('campaign: a nitro before every jump (%s)', (cls) => {
  it('the autopilot still lands every jump cleanly after a nitro 30 to 250 m before it', () => {
    const bad: string[] = [];
    let jumps = 0;
    for (const [id, , name, code] of CAMPAIGN_DEFS) {
      const track = new Track(buildTrack(`${id} ${name}`, code));
      const pts = traceRoute(track).points;
      for (let n = 1; n < pts.length; n++) {
        if (!pts[n].air || pts[n - 1].air) continue;
        jumps++;
        for (const before of [30, 60, 100, 160, 250]) {
          const at = pts[n].s - before;
          if (at < 10) continue;
          const race = new RaceSession(track, DEFAULT_ASSISTS, cls);
          const bot = new Autopilot(track, cls);
          let hint = -1, missing = 0;
          while (race.phase !== 'finished' && race.ticks < 30000) {
            let ctl: Controls = NO_CONTROLS;
            if (race.phase === 'racing') {
              const { steer, gas, brake } = bot.controls(race);
              hint = nearestPoint(bot.route, race.car.pos.x, race.car.pos.y, race.car.pos.z, hint);
              ctl = { steer, gas, brake, nitro: race.nitroUses === 0 && bot.route.points[hint].s >= at };
            }
            for (const e of race.step(ctl)) if (e.type === 'missing' || e.type === 'respawn') missing++;
          }
          if (race.phase !== 'finished' || missing || race.nitroUses !== 1) bad.push(`${id} jump at ${pts[n].s.toFixed(0)} m, fired ${before} m before`);
        }
      }
    }
    expect(jumps).toBeGreaterThanOrEqual(9);
    expect(bad).toEqual([]);
  }, 120000);
});
