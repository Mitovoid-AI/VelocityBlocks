import { describe, expect, it } from 'vitest';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { runBot } from '../src/game/bot';
import { campaignAuthorTime, classAuthorTimes, type AuthorTable } from '../src/game/medals';
import { classLines, type StoredLines } from '../src/game/racingLine';
import { assistsFor } from '../src/physics/vehicle';
import authorTimes from '../src/track/authorTimes.json';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import racingLines from '../src/track/racingLines.json';
import { traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';
import { GATES, TOUCH_DRIVERS } from './classGates';
import { dubinsLength } from './dubins';

/** Tightest turn a car cutting across the grass is credited with. */
const CUT_RADIUS = 20;
/** Shortest grass path between two ground-level gates must be at least this share of the road. */
const MIN_CUT_RATIO = 0.75;

const table = authorTimes as AuthorTable;
const lines = racingLines as StoredLines;

// Every vehicle class drives every campaign track; the Bike and the Truck also meet the round-3 gates (no
// spin, no long excursion, an author lap in a sane band of their racing line). The car's gates are as before.
describe.each(VEHICLE_CLASSES)('campaign: %s', (cls) => {
  const times = classAuthorTimes(table, cls);

  it('has a current author-time table', () => {
    // A stale table makes medals.ts run the bot on the main thread (a multi-second freeze on phones).
    expect(table.physics, 'authorTimes.json is for this PHYSICS_VERSION').toBe(PHYSICS_VERSION);
    expect(times, `authorTimes.json has a ${cls} section for VEHICLE_REV ${VEHICLE_REV[cls]}`).not.toBeNull();
    expect(Object.keys(times!).sort()).toEqual(CAMPAIGN_DEFS.map((d) => d[0]).sort());
  });

  for (const [id, , name, code] of CAMPAIGN_DEFS) {
    it(`${id} ${name} is connected and finishable`, () => {
      const track = new Track(buildTrack(`${id} ${name}`, code));
      const route = traceRoute(track);
      expect(route.complete, 'route reaches a finish').toBe(true);
      expect(track.checkpointCount).toBeGreaterThan(0);
      const res = runBot(track, 300, { vehicle: cls });
      console.log(
        `${cls} ${id} ${name}: ${res.finished ? (res.time! / 1000).toFixed(2) + 's' : 'DNF'} respawns=${res.respawns} autoRespawns=${res.autoRespawns} yaw=${res.maxYawErr.toFixed(0)} off=${res.maxOff.toFixed(1)} len=${route.length.toFixed(0)}m`,
      );
      expect(res.finished).toBe(true);
      expect(res.respawns).toBe(0);
      // Attract mode replays the bot without respawn handling, and a pre-checkpoint flip restart hides from respawns.
      expect(res.autoRespawns, 'no automatic flip respawns').toBe(0);
      expect(res.allRespawns, 'no respawns of any kind').toBe(0);
      expect(res.time, 'author time matches scripts/author-times.ts').toBe(times?.[id]);
      // Author times are driven with the nitro (at GO on every track, where the rule lets it).
      expect(res.nitros, 'fires the nitro').toBeGreaterThan(0);
      if (cls === 'car') return;
      expect(res.maxYawErr, 'no spin').toBeLessThanOrEqual(GATES.spinDeg);
      expect(res.maxOff, 'stays near the road').toBeLessThanOrEqual(GATES.offRoute);
      const ratio = res.time! / classLines(lines, cls)![id].time;
      expect(ratio, 'author lap over racing-line lap').toBeGreaterThanOrEqual(GATES.authorVsLine[0]);
      expect(ratio, 'author lap over racing-line lap').toBeLessThanOrEqual(GATES.authorVsLine[1]);
      expect(campaignAuthorTime(id, cls)).toBe(times![id]);
    });
  }

  // Phone players drive with digital buttons; every traction-control setting must stay drivable with them,
  // with or without pressing the nitro where the autopilot fires it.
  for (const driver of ['touch-normal', 'touch-low', 'nitro-normal', 'nitro-low'] as const) {
    it(`a touch-style driver (${driver}) finishes every track cleanly`, () => {
      const d = TOUCH_DRIVERS[driver];
      for (const [id, , name, code] of CAMPAIGN_DEFS) {
        const track = new Track(buildTrack(`${id} ${name}`, code));
        const res = runBot(track, 300, { vehicle: cls, assists: assistsFor(d.tc, d.auto), filter: d.filter });
        expect(res.finished, id).toBe(true);
        expect(res.allRespawns, id).toBe(0);
        if (cls === 'car') continue;
        expect(res.maxYawErr, `${id} no spin`).toBeLessThanOrEqual(GATES.spinDeg);
        expect(res.time!, `${id} not far off the autopilot`).toBeLessThanOrEqual(GATES.touchVsBot * times![id]);
      }
    }, 60000);
  }

  // Tilt and the on-screen wheel steer with the analog assist (faster steering rate), on by default: the
  // autopilot's analog steering with it must lap as cleanly as without (the bike once rolled after A12's jump).
  it('the autopilot with the analog steering assist finishes every track cleanly', () => {
    for (const tc of ['normal', 'low'] as const) {
      for (const [id, , name, code] of CAMPAIGN_DEFS) {
        const res = runBot(new Track(buildTrack(`${id} ${name}`, code)), 300, { vehicle: cls, assists: assistsFor(tc, false, true) });
        expect(res.finished, `${id} ${tc}`).toBe(true);
        expect(res.allRespawns, `${id} ${tc}`).toBe(0);
        expect(res.maxYawErr, `${id} ${tc} no spin`).toBeLessThanOrEqual(GATES.spinDeg);
      }
    }
  }, 60000);
});


// Ground-level roads have no barriers (unless walls on all roads is set) and checkpoints count in any
// order, so the only thing stopping a gate-to-gate cut across the grass is that the shortest drivable path
// is not much shorter.
describe('campaign layouts', () => {
  it('leaves no big grass shortcut between ground-level gates', () => {
    for (const [id, , name, code] of CAMPAIGN_DEFS) {
      const track = new Track(buildTrack(`${id} ${name}`, code));
      let s = 0;
      const gates: { s: number; k: number; x: number; z: number; th: number }[] = [];
      for (const b of traceRoute(track).blocks) {
        if (b.def.gate) {
          const c = b.centerWorld(16);
          gates.push({ s: s + 16, k: b.p.k, x: c.x, z: c.z, th: Math.atan2(c.hz, c.hx) });
        }
        s += b.def.length;
      }
      for (let n = 1; n < gates.length; n++) {
        const A = gates[n - 1], B = gates[n];
        if (A.k !== 0 || B.k !== 0) continue;
        const ratio = dubinsLength(A.x, A.z, A.th, B.x, B.z, B.th, CUT_RADIUS) / (B.s - A.s);
        expect(ratio, `${id} gates ${n - 1}->${n}`).toBeGreaterThanOrEqual(MIN_CUT_RATIO);
      }
    }
  });
});
