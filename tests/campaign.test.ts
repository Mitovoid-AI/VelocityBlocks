import { describe, expect, it } from 'vitest';
import { runBot } from '../src/game/bot';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';
import { dubinsLength } from './dubins';

/** Tightest turn a car cutting across the grass is credited with. */
const CUT_RADIUS = 20;
/** Shortest grass path between two ground-level gates must be at least this share of the road. */
const MIN_CUT_RATIO = 0.75;

describe('campaign', () => {
  for (const [id, , name, code] of CAMPAIGN_DEFS) {
    it(`${id} ${name} is connected and finishable`, () => {
      const track = new Track(buildTrack(`${id} ${name}`, code));
      const route = traceRoute(track);
      expect(route.complete, 'route reaches a finish').toBe(true);
      expect(track.checkpointCount).toBeGreaterThan(0);
      const res = runBot(track, 300);
      console.log(
        `${id} ${name}: ${res.finished ? (res.time! / 1000).toFixed(2) + 's' : 'DNF'} respawns=${res.respawns} autoRespawns=${res.autoRespawns} len=${route.length.toFixed(0)}m`,
      );
      expect(res.finished).toBe(true);
      expect(res.respawns).toBe(0);
      // Attract mode replays the bot without respawn handling, and a pre-checkpoint flip restart hides from respawns.
      expect(res.autoRespawns, 'no automatic flip respawns').toBe(0);
    });
  }

  // Ground-level roads have no barriers and checkpoints count in any order, so the only thing
  // stopping a gate-to-gate cut across the grass is that the shortest drivable path is not much shorter.
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
