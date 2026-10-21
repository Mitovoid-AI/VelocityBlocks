// The car's physics is bit-identical to physics v6 (HEAD cc14ec0, before vehicle classes, walls and the
// nitro) whenever the nitro is not pressed. PHYSICS_VERSION is 7 all the same: the author times are nitro
// laps now (A01 13.90 -> 12.86 s), so v6 records and custom-track author times (set without nitro) are
// not carried over, while the shipped author-time and racing-line tables stay valid as they are (they were
// made with this very car). These are the final states of a few deterministic drives recorded on v6
// (scripts/car-fingerprint.ts prints them); any change to the car's code path, however small, shows up
// here. The autopilot drives its v6 lap with its nitro presses dropped (it fires the nitro since round 3,
// which changes its lap, not the car). tests/nitro.test.ts checks a held-false nitro field against an absent one.
import { beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS_VERSION } from '../src/core/constants';
import { classAuthorTimes, type AuthorTable } from '../src/game/medals';
import { loadStoredLines, storedLine } from '../src/game/racingLine';
import authorTimes from '../src/track/authorTimes.json';
import racingLines from '../src/track/racingLines.json';
import { Autopilot } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { createCar, stepCar, type Assists, type CarState, type Controls } from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';

// The precomputed lines load on first use (the game's bundle leaves them out): campaign line jobs need them.
beforeAll(() => loadStoredLines());

const NONE: Controls = { steer: 0, gas: 0, brake: 0 };
const flat = {
  surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null }),
  wallAt: () => null,
  sideAt: () => null,
  columnsNear: () => null,
  spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
} as unknown as Track;

const state = (c: CarState) => [
  c.pos.x, c.pos.y, c.pos.z, c.vel.x, c.vel.y, c.vel.z, c.rot.x, c.rot.y, c.rot.z, c.rot.w,
  c.angVel.x, c.angVel.y, c.angVel.z, c.steer, c.drift, c.wheelSpin, c.odometer,
];

const V6 = {
  'flat-normal': [-50.745712942609146, 0.8661278411519506, 467.0919130933768, -1.1309230032676678, -4.1721726353867924e-5, 16.007279696188316, 4.2086021277185034e-5, -0.9993774817909041, -0.0011933251601347916, -0.035259368869848005, 0.0002785696909087207, 2.4857134978505372e-9, 1.851797730285597e-5, 0, 0, 464.3318376532011, 445.4993663471773],
  'flat-low': [-52.18581026601296, 0.866126332876957, 474.05746936316814, -1.305520497401926, -2.260083061619639e-5, 15.991953926943502, 4.87698668406863e-5, -0.9991700218890252, -0.00119771296177776, -0.04071646427977938, 0.00012980115491484454, -1.5725935648354288e-9, 9.995598520531574e-6, 0, 0, 476.75201127244554, 452.4445812459381],
  botTime: 25270,
  bot: [240.0761555759856, 0.8208030382236565, 112.03359462642992, -1.062521992952744, -0.02637464454894575, 42.293887323385626, -0.007281385677295742, -0.012030628704380838, 0.0006414173963712962, 0.9999009120804517, 0.00037447693194468966, 0.07345723319426012, 0.0014861476542302084, -0.05511811023622047, 0, 2656.892346011857, 956.4812445642691],
  wall: [56.45188069266015, 8.865344238051351, 269.94808772437574, -0.0003051292956879337, 0.004668591279992216, -0.04015202600939051, -0.0033382879478512212, -0.707397850451213, -0.0030831221424349746, 0.7068009842724016, -0.0003818025155047375, 0.008126045669398153, -0.002038818277485325, -1, 0, -11.047349913797062, 56.78178763370912],
};

describe('physics v7: the nitro', () => {
  it('bumped the version with the nitro, and the shipped tables (the same car) are v7', () => {
    expect(PHYSICS_VERSION).toBe(7);
    expect(authorTimes.physics).toBe(PHYSICS_VERSION);
    expect(racingLines.physics).toBe(PHYSICS_VERSION);
    // The nitro lap's author time, from the table (not recomputed by the autopilot).
    expect(classAuthorTimes(authorTimes as AuthorTable, 'car')?.A01).toBe(12860);
    expect(storedLine('A01')).not.toBeNull();
  });
});

describe('the car without the nitro is physics v6, bit for bit', () => {
  it('launch, brake-tap drift and slide on a flat plane, with either traction control', () => {
    for (const tc of ['normal', 'low'] as const) {
      const a: Assists = { tc };
      const c = createCar(flat);
      for (let n = 0; n < 1500; n++) {
        const t = n / 100;
        const ctl: Controls =
          t < 6 ? { steer: 0, gas: 1, brake: 0 }
          : t < 6.4 ? { steer: 0.8, gas: 1, brake: 0 }
          : t < 6.6 ? { steer: 1, gas: 0, brake: 1 }
          : t < 8 ? { steer: 0.7, gas: 1, brake: 0 }
          : t < 10 ? { steer: -0.3, gas: 0.6, brake: 0 }
          : { steer: 0, gas: 0, brake: 0.7 };
        stepCar(c, ctl, flat, a);
      }
      expect(state(c), tc).toEqual(V6[`flat-${tc}`]);
    }
  });

  it('an autopilot lap with pads, slopes, a jump, checkpoints and a hairpin', () => {
    const track = new Track(buildTrack('fp', 'St B Sx2 R S C S L2 S U S J G G Sx3 D S T S C S R R S F'));
    const race = new RaceSession(track);
    const bot = new Autopilot(track);
    const noNitro = ({ steer, gas, brake }: Controls): Controls => ({ steer, gas, brake });
    while (race.phase !== 'finished' && race.ticks < 20000) race.step(race.phase === 'racing' ? noNitro(bot.controls(race)) : NONE);
    expect(race.finishTime).toBe(V6.botTime);
    expect(race.nitroUses).toBe(0);
    expect(state(race.car)).toEqual(V6.bot);
  });

  it('barrier, post and reverse contacts on a raised deck', () => {
    const high = new Track(buildTrack('fp2', '@1 St Sx3 C Sx3 F'));
    const r = new RaceSession(high);
    for (let n = 0; n < 900; n++) {
      r.step(n < 150 ? NONE : n < 450 ? { steer: n > 250 ? 1 : 0, gas: 1, brake: 0 } : { steer: -1, gas: 0, brake: 1 });
    }
    expect(state(r.car)).toEqual(V6.wall);
  });
});
