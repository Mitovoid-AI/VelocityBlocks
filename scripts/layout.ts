// Prints an ASCII map of a track code: node <tmp>/layout.mjs "<code>"
// (<tmp>/layout.mjs is this file bundled with the local esbuild; see Helper scripts in README.md)
import { buildTrack } from '../src/track/builder';
import { cellsFor } from '../src/track/track';
import { BLOCKS } from '../src/track/blocks';

const code = process.argv[2];
try {
  const t = buildTrack('layout', code);
  const grid = new Map<string, string>();
  let maxI = 0, maxJ = 0;
  t.blocks.forEach((p, n) => {
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
