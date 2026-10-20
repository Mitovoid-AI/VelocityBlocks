// Acceptance gate for a vehicle class's tuning: the autopilot, the phone-style drivers (with and without
// the nitro) and the racing line on every campaign track, with the gates the campaign tests enforce. Run it from the project root
// after every VehicleSpec change (uses the local esbuild):
//   npx esbuild scripts/class-tune.ts --bundle --platform=node --format=esm --outfile=<tmp>/class-tune.mjs && node <tmp>/class-tune.mjs [car|bike|truck|all] [quick]
// 'quick' skips the racing lines. A class passes when the last line says "PASS".
// 'sweep' instead measures robustness: the autopilot and the phone-style drivers again with the start held
// back 4..28 ticks (single laps are chaotic: a few ticks change which bump a car meets at which speed) and
// counts the clean laps (no respawn, no spin, not over touchVsBot slower than the plain autopilot lap). The
// nitro drivers' counts should stay close to the plain touch drivers' (bot.ts NITRO_RULE was tuned on such
// sweeps).
// 'jumps' measures a nitro fired 30..250 m before every campaign jump, by the autopilot (gated in
// tests/campaignNitro.test.ts) and by a button player (touch-normal, measured like the sweep: few failures).
import { VEHICLE_CLASSES, isVehicleClass, type VehicleClass } from '../src/core/vehicles';
import { Autopilot, runBot, type BotResult } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { classAuthorTimes, type AuthorTable } from '../src/game/medals';
import { lateralLimits, minCurvatureOffsets, offsetRoute, paceRun, runJob, sampleLine, traceOnCentre } from '../src/game/racingLine';
import { assistsFor, DEFAULT_ASSISTS, lineHalfWidth, NO_CONTROLS, vehicleSpec, type Controls } from '../src/physics/vehicle';
import authorTimes from '../src/track/authorTimes.json';
import { campaign } from '../src/track/campaign';
import { nearestPoint, traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';
import { GATES, TOUCH_DRIVERS, type TouchDriver } from '../tests/classGates';

const arg = process.argv[2] ?? 'all';
const quick = process.argv.includes('quick');
const classes: VehicleClass[] = isVehicleClass(arg) ? [arg] : [...VEHICLE_CLASSES];
const sweep = process.argv.includes('sweep');
const jumpSweep = process.argv.includes('jumps');
const DELAYS = [4, 8, 12, 16, 20, 24, 28];

/** Holds the start back `delay` racing ticks, then drives with `filter` (or the plain autopilot). */
function delayed(delay: number, filter?: (c: Controls) => Controls): (c: Controls) => Controls {
  let k = delay;
  return (c) => (k-- > 0 ? { steer: 0, gas: 0, brake: 0 } : filter ? filter(c) : c);
}

if (jumpSweep) {
  for (const cls of classes) {
    for (const [name, filter] of [['bot', (c: Controls) => c], ['touch', TOUCH_DRIVERS['touch-normal'].filter]] as const) {
      const bad: string[] = [];
      let runs = 0;
      for (const ct of campaign()) {
        const track = new Track(ct.data);
        const pts = traceRoute(track).points;
        for (let n = 1; n < pts.length; n++) {
          if (!pts[n].air || pts[n - 1].air) continue;
          for (const before of [30, 60, 100, 160, 250]) {
            const at = pts[n].s - before;
            if (at < 10) continue;
            runs++;
            const race = new RaceSession(track, DEFAULT_ASSISTS, cls);
            const bot = new Autopilot(track, cls);
            let hint = -1, missing = 0;
            while (race.phase !== 'finished' && race.ticks < 30000) {
              let ctl: Controls = NO_CONTROLS;
              if (race.phase === 'racing') {
                const { steer, gas, brake } = filter(bot.controls(race));
                hint = nearestPoint(bot.route, race.car.pos.x, race.car.pos.y, race.car.pos.z, hint);
                ctl = { steer, gas, brake, nitro: race.nitroUses === 0 && bot.route.points[hint].s >= at };
              }
              for (const e of race.step(ctl)) if (e.type === 'missing' || e.type === 'respawn') missing++;
            }
            if (race.phase !== 'finished' || missing || race.nitroUses !== 1) bad.push(`${ct.id}@${pts[n].s.toFixed(0)}-${before}`);
          }
        }
      }
      console.log(`${cls} JUMPS ${name}: ${runs - bad.length}/${runs} clean ${bad.join(' ')}`);
    }
  }
  process.exit(0);
}

if (sweep) {
  for (const cls of classes) {
    const drivers: [string, TouchDriver | null][] = [['bot', null], ...Object.entries(TOUCH_DRIVERS)];
    const clean: Record<string, number> = {};
    const bad: string[] = [];
    for (const ct of campaign()) {
      const ref = runBot(new Track(ct.data), 300, { vehicle: cls }).time ?? Infinity;
      for (const [name, d] of drivers) {
        for (const delay of DELAYS) {
          const r = runBot(new Track(ct.data), 300, {
            vehicle: cls,
            assists: d ? assistsFor(d.tc, d.auto) : undefined,
            filter: delayed(delay, d?.filter),
          });
          const ok = r.finished && !r.allRespawns && r.maxYawErr <= GATES.spinDeg && r.time! <= GATES.touchVsBot * ref + delay * 10;
          clean[name] = (clean[name] ?? 0) + (ok ? 1 : 0);
          if (!ok) bad.push(`${ct.id}/${name}/${delay}`);
        }
      }
    }
    const n = 12 * DELAYS.length;
    console.log(`${cls} SWEEP clean laps: ${Object.entries(clean).map(([k, v]) => `${k} ${v}/${n}`).join(', ')}`);
    console.log(`${cls} SWEEP failures: ${bad.join(' ')}`);
  }
  process.exit(0);
}

const fmt = (ms: number | null) => (ms === null ? 'DNF' : (ms / 1000).toFixed(2));
const stats = (r: BotResult) => `${fmt(r.time)} r${r.allRespawns} yaw${r.maxYawErr.toFixed(0)} off${r.maxOff.toFixed(1)}`;

for (const cls of classes) {
  const fails: string[] = [];
  const table = classAuthorTimes(authorTimes as AuthorTable, cls);
  let total = 0, lineTotal = 0;
  for (const ct of campaign()) {
    const bot = runBot(new Track(ct.data), 300, { vehicle: cls });
    total += bot.time ?? 0;
    const same = table?.[ct.id] !== undefined ? (bot.time === table[ct.id] ? 'SAME' : `DIFF(${fmt(table[ct.id])})`) : '';
    let row = `${cls} ${ct.id} ${ct.data.name.padEnd(17)} bot ${stats(bot)} ${same}`;
    if (!bot.finished || bot.allRespawns) fails.push(`${ct.id} bot respawn/DNF`);
    if (bot.maxYawErr > GATES.spinDeg) fails.push(`${ct.id} bot spin ${bot.maxYawErr.toFixed(0)}`);
    if (bot.maxOff > GATES.offRoute) fails.push(`${ct.id} bot off-route ${bot.maxOff.toFixed(1)}`);
    for (const [name, d] of Object.entries(TOUCH_DRIVERS)) {
      const r = runBot(new Track(ct.data), 300, { vehicle: cls, assists: assistsFor(d.tc, d.auto), filter: d.filter });
      row += ` | ${name} ${stats(r)}`;
      if (!r.finished || r.allRespawns) fails.push(`${ct.id} ${name} respawn/DNF`);
      if (r.maxYawErr > GATES.spinDeg) fails.push(`${ct.id} ${name} spin ${r.maxYawErr.toFixed(0)}`);
      if (bot.time && r.time && r.time > GATES.touchVsBot * bot.time) fails.push(`${ct.id} ${name} slow x${(r.time / bot.time).toFixed(2)}`);
    }
    if (!quick) {
      // paceLineJob step by step, to see how far off the road the pace lap went.
      const track = new Track(ct.data);
      const base = traceRoute(track);
      const S = vehicleSpec(cls);
      const e = runJob(minCurvatureOffsets(base.points, lateralLimits(track, base, lineHalfWidth(S))));
      const { run } = runJob(paceRun(track, offsetRoute(base, e), S));
      const line = run.trace ? runJob(sampleLine(run.trace, track, base)) : null;
      lineTotal += line?.time ?? 0;
      if (!line) fails.push(`${ct.id} no line (${run.end})`);
      else {
        const ratio = (bot.time ?? Infinity) / line.time;
        const off = Math.max(...runJob(traceOnCentre(run.trace!, base)).e.map(Math.abs));
        row += ` | line ${fmt(line.time)} x${ratio.toFixed(2)} off${off.toFixed(1)}`;
        if (ratio < GATES.authorVsLine[0] || ratio > GATES.authorVsLine[1]) fails.push(`${ct.id} author/line ${ratio.toFixed(2)}`);
        if (off > GATES.lineOffRoute) fails.push(`${ct.id} line off-route ${off.toFixed(1)}`);
      }
    }
    console.log(row);
  }
  console.log(`${cls} author total ${fmt(total)}${quick ? '' : ` line total ${fmt(lineTotal)}`}`);
  // The car's gates are its campaign tests as before physics v6 classes; report, do not fail, the new ones.
  console.log(`${cls} ${fails.length ? (cls === 'car' ? 'INFO ' : 'FAIL ') + fails.join('; ') : 'PASS'}`);
}
