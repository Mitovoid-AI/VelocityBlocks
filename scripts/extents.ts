// Prints each campaign track's footprint in cells: node <tmp>/extents.mjs
// (<tmp>/extents.mjs is this file bundled with the local esbuild; see Helper scripts in README.md)
import { campaign } from '../src/track/campaign';
import { cellsFor } from '../src/track/track';
for (const ct of campaign()) {
  const cells = ct.data.blocks.flatMap((b) => cellsFor(b));
  const w = Math.max(...cells.map((c) => c[0])) + 1;
  const h = Math.max(...cells.map((c) => c[1])) + 1;
  console.log(`${ct.data.name.padEnd(18)} ${w} x ${h}${w > 32 || h > 32 ? '  <-- too big' : ''}`);
}
