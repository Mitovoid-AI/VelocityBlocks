// Robustness of the Bike's and the Truck's autopilots on the campaign (a file of its own, so it runs beside
// tests/campaign.test.ts and tests/campaignNitro.test.ts).
import { describe, expect, it } from 'vitest';
import { runBot } from '../src/game/bot';
import { assistsFor, NO_CONTROLS, type Controls } from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { Track } from '../src/track/track';
import { GATES } from './classGates';

// The Bike's and the Truck's autopilots (the menu's attract lap, editor validation) with the start held back:
// single laps are chaotic, and the bike's landings after A11's and A12's jumps once rolled it on a few delays.
describe.each(['bike', 'truck'] as const)('campaign: the %s autopilot from a range of start delays', (cls) => {
  it('finishes every track cleanly on both traction settings', () => {
    const bad: string[] = [];
    for (const tc of ['normal', 'low'] as const) {
      for (const delay of [4, 9, 14, 19, 24, 29]) {
        for (const [id, , name, code] of CAMPAIGN_DEFS) {
          let k = delay;
          const filter = (c: Controls) => (k-- > 0 ? NO_CONTROLS : c);
          const res = runBot(new Track(buildTrack(`${id} ${name}`, code)), 300, { vehicle: cls, assists: assistsFor(tc, false), filter });
          if (!res.finished || res.allRespawns || res.maxYawErr > GATES.spinDeg) bad.push(`${id} ${tc} +${delay}`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 180000);
});
