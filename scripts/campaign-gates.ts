// Runs the campaign acceptance gates (tests/campaign*.test.ts, tests/walls.test.ts, the racing-line pace laps)
// on chosen campaign tracks without the stored tables, for authoring new tracks:
//   npx esbuild scripts/campaign-gates.ts --bundle --platform=node --format=esm --outfile=<tmp>/gates.mjs
//   node <tmp>/gates.mjs [ids...] [--quick] [--class car|bike|truck]
// Default: every Desert and Water track, every class. --quick runs only the autopilot, the touch drivers and
// the pace line (no start delays, no nitro sweeps). Prints one line per failure and a summary per track.
import { VEHICLE_CLASSES, isVehicleClass, type VehicleClass } from '../src/core/vehicles';
import { Autopilot, runBot } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { paceLineJob, runJob } from '../src/game/racingLine';
import { assistsFor, DEFAULT_ASSISTS, NO_CONTROLS, type Controls } from '../src/physics/vehicle';
import { buildTrack, fitsGrid } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { nearestPoint, traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';
import { GATES, TOUCH_DRIVERS } from '../tests/classGates';
import { dubinsLength } from '../tests/dubins';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const ci = args.indexOf('--class');
const only = ci >= 0 ? args[ci + 1] : undefined;
const classes: readonly VehicleClass[] = isVehicleClass(only) ? [only] : VEHICLE_CLASSES;
const ids = args.filter((a, n) => !a.startsWith('--') && args[n - 1] !== '--class');
// An argument with a space in it is a track code to try (named X1, X2, ...).
const defs: [string, string, string, string][] = ids.some((a) => a.includes(' '))
  ? ids.map((code, n) => [`X${n + 1}`, '', 'trial', code])
  : CAMPAIGN_DEFS.filter(([id]) => (ids.length ? ids.includes(id) : !id.startsWith('A'))).map(([id, s, n, c]) => [id, s, n, c]);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

for (const [id, , name, code] of defs) {
  const data = buildTrack(`${id} ${name}`, code);
  const track = new Track(data);
  const route = traceRoute(track);
  const t0 = Date.now();
  console.log(`${id} ${name}: ${route.length.toFixed(0)} m, ${track.checkpointCount} CPs, theme ${data.theme ?? 'stadium'}${data.sky ? ' ' + data.sky : ''}`);
  if (!route.complete) fail(`${id} route incomplete`);
  if (!fitsGrid(data)) fail(`${id} does not fit the grid`);

  // Grass shortcuts between ground-level gates (tests/campaign.test.ts).
  {
    let s = 0;
    const gates: { s: number; k: number; x: number; z: number; th: number }[] = [];
    for (const b of route.blocks) {
      if (b.def.gate) {
        const c = b.centerWorld(16);
        gates.push({ s: s + 16, k: b.p.k, x: c.x, z: c.z, th: Math.atan2(c.hz, c.hx) });
      }
      s += b.def.length;
    }
    for (let n = 1; n < gates.length; n++) {
      const A = gates[n - 1], B = gates[n];
      if (A.k !== 0 || B.k !== 0) continue;
      const ratio = dubinsLength(A.x, A.z, A.th, B.x, B.z, B.th, 20) / (B.s - A.s);
      if (ratio < 0.75) fail(`${id} shortcut gates ${n - 1}->${n} ratio ${ratio.toFixed(2)}`);
    }
  }

  for (const cls of classes) {
    const tag = `${cls} ${id}`;
    const r = runBot(track, 300, { vehicle: cls });
    const line = runJob(paceLineJob(new Track(data), cls));
    const ratio = line && r.time ? r.time / line.time : NaN;
    console.log(
      `  ${cls.padEnd(5)} bot ${r.finished ? (r.time! / 1000).toFixed(2) + 's' : 'DNF'} resp=${r.allRespawns} yaw=${r.maxYawErr.toFixed(0)} off=${r.maxOff.toFixed(1)} nitros=${r.nitros}  line ${line ? (line.time / 1000).toFixed(2) + 's' : 'NONE'} x${ratio.toFixed(2)}`,
    );
    if (!r.finished || r.allRespawns) fail(`${tag} autopilot not clean`);
    if (r.nitros === 0) fail(`${tag} no nitro`);
    if (r.maxYawErr > GATES.spinDeg) fail(`${tag} spin ${r.maxYawErr.toFixed(0)}`);
    if (r.maxOff > GATES.offRoute) fail(`${tag} off route ${r.maxOff.toFixed(1)}`);
    if (!line) fail(`${tag} no racing line`);
    else if (cls !== 'car' && (ratio < GATES.authorVsLine[0] || ratio > GATES.authorVsLine[1])) fail(`${tag} author/line ${ratio.toFixed(2)}`);
    else if (cls === 'car' && !(line.time < r.time!)) fail(`${tag} line not faster than author`);
    const w = runBot(new Track(data, { walls: true }), 300, { vehicle: cls });
    if (w.time !== r.time || w.allRespawns) fail(`${tag} walls parity ${w.time} vs ${r.time}`);

    for (const driver of ['touch-normal', 'touch-low', 'nitro-normal', 'nitro-low'] as const) {
      const d = TOUCH_DRIVERS[driver];
      const t = runBot(track, 300, { vehicle: cls, assists: assistsFor(d.tc, d.auto), filter: d.filter });
      if (!t.finished || t.allRespawns) fail(`${tag} ${driver} not clean`);
      else if (cls !== 'car' && t.maxYawErr > GATES.spinDeg) fail(`${tag} ${driver} spin`);
      else if (cls !== 'car' && r.time && t.time! > GATES.touchVsBot * r.time) fail(`${tag} ${driver} slow x${(t.time! / r.time).toFixed(2)}`);
    }
    for (const tc of ['normal', 'low'] as const) {
      const a = runBot(track, 300, { vehicle: cls, assists: assistsFor(tc, false, true) });
      if (!a.finished || a.allRespawns || a.maxYawErr > GATES.spinDeg) fail(`${tag} analog ${tc}`);
    }
    if (quick) continue;

    // Start delays: the Bike's and the Truck's autopilots (tests/campaignDelays.test.ts), the car's nitro
    // button drivers (tests/campaignNitro.test.ts).
    if (cls !== 'car') {
      for (const tc of ['normal', 'low'] as const) {
        for (const delay of [4, 9, 14, 19, 24, 29]) {
          let k = delay;
          const filter = (c: Controls) => (k-- > 0 ? NO_CONTROLS : c);
          const res = runBot(track, 300, { vehicle: cls, assists: assistsFor(tc, false), filter });
          if (!res.finished || res.allRespawns || res.maxYawErr > GATES.spinDeg) fail(`${tag} delay ${tc} +${delay}`);
        }
      }
    } else {
      for (const delay of [3, 8, 13, 18, 23, 28]) {
        for (const driver of ['nitro-normal', 'nitro-low'] as const) {
          const d = TOUCH_DRIVERS[driver];
          let k = delay;
          const filter = (c: Controls) => (k-- > 0 ? { steer: 0, gas: 0, brake: 0 } : d.filter(c));
          const res = runBot(track, 300, { assists: assistsFor(d.tc, d.auto), filter });
          if (!res.finished || res.allRespawns) fail(`${tag} ${driver} +${delay}`);
        }
      }
    }

    // A nitro 30..250 m before every jump (tests/campaignNitro.test.ts).
    const pts = route.points;
    for (let n = 1; n < pts.length; n++) {
      if (!pts[n].air || pts[n - 1].air) continue;
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
        if (race.phase !== 'finished' || missing || race.nitroUses !== 1) fail(`${tag} nitro ${before} m before the jump at ${pts[n].s.toFixed(0)} m`);
      }
    }
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
console.log(failures ? `${failures} failures` : 'all gates passed');
