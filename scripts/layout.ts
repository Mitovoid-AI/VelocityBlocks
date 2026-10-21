// Prints an ASCII map of a track code or a campaign id: node <tmp>/layout.mjs "<code>" | D03
// (<tmp>/layout.mjs is this file bundled with the local esbuild; see Helper scripts in README.md)
// Each cell shows the first letter of its block code and its level ("~0" is water).
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { cellsFor } from '../src/track/track';
import { BLOCKS } from '../src/track/blocks';

const arg = process.argv[2];
const code = CAMPAIGN_DEFS.find((d) => d[0] === arg)?.[3] ?? arg;
try {
  const t = buildTrack('layout', code);
  const grid = new Map<string, string>();
  let maxI = 0, maxJ = 0;
  t.blocks.forEach((p) => {
    for (const [i, j, k] of cellsFor(p)) {
      const ch = BLOCKS[p.type].code[0] + String(k);
      grid.set(`${i},${j}`, (grid.get(`${i},${j}`) ?? '') + ch);
      maxI = Math.max(maxI, i); maxJ = Math.max(maxJ, j);
    }
  });
  for (let j = 0; j <= maxJ + 1; j++) {
    let row = '';
    for (let i = 0; i <= maxI + 1; i++) row += (grid.get(`${i},${j}`) ?? '.').padEnd(4).slice(0, 4);
    console.log(row);
  }
  console.log(`OK ${t.blocks.length} blocks, ${maxI + 1}x${maxJ + 1} cells`);
} catch (e) {
  console.log(String(e));
}
