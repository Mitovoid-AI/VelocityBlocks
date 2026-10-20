// Regenerates src/track/authorTimes.json from the autopilot (which fires the nitro: bot.ts nitroFits), one
// section per vehicle class (the car's at the top level, the others tagged with their VEHICLE_REV). Run it from the project root AFTER
// scripts/racing-lines.ts (each class's author lap must sit in a sane band of its racing-line lap); uses the
// local esbuild:
//   npx esbuild scripts/author-times.ts --bundle --platform=node --format=esm --outfile=<tmp>/author-times.mjs && node <tmp>/author-times.mjs [car|bike|truck]
// With a class, only that class's section is rewritten and the others are kept. It refuses a lap with a
// respawn, a spin or a long excursion, and (for the Bike and the Truck) an author lap outside the band;
// author times are open-road times, and the autopilot must also lap cleanly with walls on all roads.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { isVehicleClass, VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { runBot } from '../src/game/bot';
import type { AuthorTable } from '../src/game/medals';
import { classLines, type StoredLines } from '../src/game/racingLine';
import { campaign } from '../src/track/campaign';
import racingLines from '../src/track/racingLines.json';
import { Track } from '../src/track/track';
import { GATES } from '../tests/classGates';

// Relative to the working directory, not this file, so the bundle can live in a temp dir.
const file = resolve(process.cwd(), 'src/track/authorTimes.json');
const only = process.argv[2];
const classes: readonly VehicleClass[] = isVehicleClass(only) ? [only] : VEHICLE_CLASSES;
const old = JSON.parse(readFileSync(file, 'utf8')) as AuthorTable;
const out: AuthorTable = old.physics === PHYSICS_VERSION ? old : { physics: PHYSICS_VERSION, times: {} };
const stored = racingLines as StoredLines;

for (const cls of classes) {
  const lines = stored.physics === PHYSICS_VERSION ? classLines(stored, cls) : null;
  if (!lines) throw new Error(`${cls}: racingLines.json has no current lines; run scripts/racing-lines.ts first`);
  const times: Record<string, number> = {};
  for (const ct of campaign()) {
    const name = `${cls} ${ct.data.name}`;
    const r = runBot(new Track(ct.data), 300, { vehicle: cls });
    if (!r.finished || r.allRespawns) throw new Error(`${name}: autopilot did not finish cleanly`);
    if (r.maxYawErr > GATES.spinDeg || r.maxOff > GATES.offRoute) {
      throw new Error(`${name}: autopilot spun or ran wide (${r.maxYawErr.toFixed(0)} deg, ${r.maxOff.toFixed(1)} m)`);
    }
    const ratio = r.time! / lines[ct.id].time;
    const [lo, hi] = GATES.authorVsLine;
    // The car's band is its campaign tests as before (its laps sit at 1.17..1.36).
    if (cls !== 'car' && (ratio < lo || ratio > hi)) throw new Error(`${name}: author lap ${ratio.toFixed(2)}x its racing line`);
    const walled = runBot(new Track(ct.data, { walls: true }), 300, { vehicle: cls });
    if (!walled.finished || walled.allRespawns) throw new Error(`${name}: autopilot did not finish cleanly with walls on`);
    // Medal thresholds are shared by both wall modes because the autopilot laps the same with walls on.
    if (walled.time !== r.time) {
      throw new Error(`${name}: walls-on lap ${walled.time} differs from open ${r.time}; author times would need a walls table`);
    }
    times[ct.id] = r.time!;
    console.log(`${name.padEnd(26)} ${(r.time! / 1000).toFixed(2)}s  x${ratio.toFixed(2)} line  same with walls`);
  }
  if (cls === 'car') out.times = times;
  else out[cls] = { rev: VEHICLE_REV[cls], times };
}
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
