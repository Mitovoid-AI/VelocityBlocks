// Regenerates src/track/authorTimes.json from the autopilot (run from the project root; uses the local esbuild):
//   npx esbuild scripts/author-times.ts --bundle --platform=node --format=esm --outfile=<tmp>/author-times.mjs && node <tmp>/author-times.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHYSICS_VERSION } from '../src/core/constants';
import { runBot } from '../src/game/bot';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

const times: Record<string, number> = {};
for (const ct of campaign()) {
  const r = runBot(new Track(ct.data), 300);
  if (!r.finished || r.respawns || r.autoRespawns) throw new Error(`${ct.data.name}: autopilot did not finish cleanly`);
  times[ct.id] = r.time!;
  console.log(`${ct.data.name.padEnd(20)} ${(r.time! / 1000).toFixed(2)}s`);
}
// Relative to the working directory, not this file, so the bundle can live in a temp dir.
writeFileSync(
  resolve(process.cwd(), 'src/track/authorTimes.json'),
  JSON.stringify({ physics: PHYSICS_VERSION, times }, null, 2) + '\n',
);
