// Regenerates src/track/racingLines.json, the campaign's racing lines for this PHYSICS_VERSION (run it from
// the project root after every physics change, with scripts/author-times.ts; uses the local esbuild):
//   npx esbuild scripts/racing-lines.ts --bundle --platform=node --format=esm --outfile=<tmp>/racing-lines.mjs && node <tmp>/racing-lines.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHYSICS_VERSION } from '../src/core/constants';
import { encodeLine, paceLineJob, Phase, runJob, type StoredLine } from '../src/game/racingLine';
import { campaign } from '../src/track/campaign';
import { traceRoute } from '../src/track/route';
import { Track } from '../src/track/track';

const lines: Record<string, StoredLine> = {};
let bytes = 0;
for (const ct of campaign()) {
  const track = new Track(ct.data);
  const d = runJob(paceLineJob(track));
  if (!d) throw new Error(`${ct.data.name}: no racing line (the pace car did not finish cleanly)`);
  lines[ct.id] = encodeLine(d, traceRoute(track).length);
  bytes += lines[ct.id].data.length;
  const share = (p: number) => ((d.phase.filter((q) => q === p).length / d.phase.length) * 100).toFixed(1);
  const time = (d.time / 1000).toFixed(2);
  console.log(`${ct.data.name.padEnd(20)} ${time}s  brake ${share(Phase.Brake)}%  lift ${share(Phase.Lift)}%`);
}
console.log(`${(bytes / 1024).toFixed(1)} KB of line data`);
// Relative to the working directory, not this file, so the bundle can live in a temp dir.
writeFileSync(
  resolve(process.cwd(), 'src/track/racingLines.json'),
  JSON.stringify({ physics: PHYSICS_VERSION, lines }, null, 2) + '\n',
);
