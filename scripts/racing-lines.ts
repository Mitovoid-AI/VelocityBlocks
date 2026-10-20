// Regenerates src/track/racingLines.json, the campaign's racing lines for this PHYSICS_VERSION (driven with
// the nitro, shown as Phase.Nitro), one section per vehicle class (the car's at the top level, the others
// tagged with their VEHICLE_REV). Run it from the
// project root after every physics or VehicleSpec change, BEFORE scripts/author-times.ts (which checks each
// author lap against its class's line); uses the local esbuild:
//   npx esbuild scripts/racing-lines.ts --bundle --platform=node --format=esm --outfile=<tmp>/racing-lines.mjs && node <tmp>/racing-lines.mjs [car|bike|truck]
// With a class, only that class's section is rewritten and the others are kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { isVehicleClass, VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { encodeLine, paceLineJob, Phase, runJob, type StoredLine, type StoredLines } from '../src/game/racingLine';
import { campaign } from '../src/track/campaign';
import { traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';

// Relative to the working directory, not this file, so the bundle can live in a temp dir.
const file = resolve(process.cwd(), 'src/track/racingLines.json');
const only = process.argv[2];
const classes: readonly VehicleClass[] = isVehicleClass(only) ? [only] : VEHICLE_CLASSES;
const old = JSON.parse(readFileSync(file, 'utf8')) as StoredLines;
const out: StoredLines = old.physics === PHYSICS_VERSION ? old : { physics: PHYSICS_VERSION, lines: {} };

for (const cls of classes) {
  const lines: Record<string, StoredLine> = {};
  let bytes = 0;
  for (const ct of campaign()) {
    const track = new Track(ct.data);
    const d = runJob(paceLineJob(track, cls));
    if (!d) throw new Error(`${cls} ${ct.data.name}: no racing line (the pace lap did not finish cleanly)`);
    lines[ct.id] = encodeLine(d, traceRoute(track).length);
    bytes += lines[ct.id].data.length;
    const share = (p: number) => ((d.phase.filter((q) => q === p).length / d.phase.length) * 100).toFixed(1);
    const time = (d.time / 1000).toFixed(2);
    console.log(`${cls.padEnd(5)} ${ct.data.name.padEnd(20)} ${time}s  brake ${share(Phase.Brake)}%  lift ${share(Phase.Lift)}%  nitro ${share(Phase.Nitro)}%`);
  }
  console.log(`${cls}: ${(bytes / 1024).toFixed(1)} KB of line data`);
  if (cls === 'car') out.lines = lines;
  else out[cls] = { rev: VEHICLE_REV[cls], lines };
}
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
