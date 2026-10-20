// Prints a fingerprint of the car physics (final states of a few deterministic drives), so a refactor
// can prove it left the car bit-identical:
//   npx esbuild scripts/car-fingerprint.ts --bundle --platform=node --format=esm --outfile=<tmp>/fp.mjs && node <tmp>/fp.mjs
import { Autopilot } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { createCar, stepCar, type Assists, type CarState, type Controls } from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';

const NONE: Controls = { steer: 0, gas: 0, brake: 0 };
const flat = {
  surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null }),
  wallAt: () => null,
  sideAt: () => null,
  columnsNear: () => null,
  spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
} as unknown as Track;

const state = (c: CarState) => [c.pos.x, c.pos.y, c.pos.z, c.vel.x, c.vel.y, c.vel.z, c.rot.x, c.rot.y, c.rot.z, c.rot.w, c.angVel.x, c.angVel.y, c.angVel.z, c.steer, c.drift, c.wheelSpin, c.odometer];

const out: Record<string, number[] | number | null> = {};
// Flat plane: launch, brake-tap drift and slide, low traction control.
for (const tc of ['normal', 'low'] as const) {
  const a: Assists = { tc };
  const c = createCar(flat);
  for (let n = 0; n < 1500; n++) {
    const t = n / 100;
    const ctl: Controls = t < 6 ? { steer: 0, gas: 1, brake: 0 } : t < 6.4 ? { steer: 0.8, gas: 1, brake: 0 } : t < 6.6 ? { steer: 1, gas: 0, brake: 1 } : t < 8 ? { steer: 0.7, gas: 1, brake: 0 } : t < 10 ? { steer: -0.3, gas: 0.6, brake: 0 } : { steer: 0, gas: 0, brake: 0.7 };
    stepCar(c, ctl, flat, a);
  }
  out[`flat-${tc}`] = state(c);
}
// Autopilot on a jump/slope/barrier track (race rules, respawn state, pads).
const track = new Track(buildTrack('fp', 'St B Sx2 R S C S L2 S U S J G G Sx3 D S T S C S R R S F'));
const race = new RaceSession(track);
const bot = new Autopilot(track);
// Nitro presses dropped: the fingerprint is of the car, and the autopilot fires the nitro since round 3.
const noNitro = ({ steer, gas, brake }: Controls): Controls => ({ steer, gas, brake });
while (race.phase !== 'finished' && race.ticks < 20000) race.step(race.phase === 'racing' ? noNitro(bot.controls(race)) : NONE);
out.botTime = race.finishTime;
out.bot = state(race.car);
// Hull, barrier and column contacts: drive into an elevated barrier, then reverse.
const high = new Track(buildTrack('fp2', '@1 St Sx3 C Sx3 F'));
const r2 = new RaceSession(high);
for (let n = 0; n < 900; n++) r2.step(n < 150 ? NONE : n < 450 ? { steer: n > 250 ? 1 : 0, gas: 1, brake: 0 } : { steer: -1, gas: 0, brake: 1 });
out.wall = state(r2.car);
console.log(JSON.stringify(out));
