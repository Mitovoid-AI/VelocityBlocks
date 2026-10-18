// Physics diagnostics: node <tmp>/diag.mjs "<track code>" [seconds] [mode]
// (<tmp>/diag.mjs is this file bundled with the local esbuild; see Helper scripts in README.md)
import { buildTrack } from '../src/track/builder';
import { Track } from '../src/track/track';
import { RaceSession } from '../src/game/race';
import { Autopilot } from '../src/game/bot';
import { forwardOf, speedOf, upOf } from '../src/physics/vehicle';

const code = process.argv[2] ?? 'St Sx12 F';
const secs = Number(process.argv[3] ?? 6);
const mode = process.argv[4] ?? 'gas';
const track = new Track(buildTrack('diag', code));
const race = new RaceSession(track);
const bot = new Autopilot(track);
for (let n = 0; n < (secs * 100 + 150); n++) {
  const ctl = race.phase !== 'racing' ? { steer: 0, gas: 0, brake: 0 } : mode === 'bot' ? bot.controls(race) : { steer: 0, gas: 1, brake: 0 };
  const ev = race.step(ctl);
  for (const e of ev) if (e.type !== 'countdown') console.log('  event', JSON.stringify(e));
  if (n % 25 === 0 || n < 3) {
    const c = race.car;
    const f = forwardOf(c), u = upOf(c);
    console.log(`t=${(n / 100).toFixed(2)} ph=${race.phase} pos=(${c.pos.x.toFixed(1)},${c.pos.y.toFixed(2)},${c.pos.z.toFixed(1)}) v=${(speedOf(c) * 3.6).toFixed(0)}km/h gr=${c.grounded} comp=${c.comp.map((x) => x.toFixed(2)).join('/')} fwd=(${f.x.toFixed(2)},${f.y.toFixed(2)},${f.z.toFixed(2)}) up.y=${u.y.toFixed(2)} steer=${c.steer.toFixed(2)} ctl=${mode === 'bot' && race.phase === 'racing' ? JSON.stringify(bot.controls(race)) : ''}`);
  }
  if (race.phase === 'finished') { console.log('FINISHED', race.finishTime); break; }
}
