// Text track format: a "turtle" walks the grid placing connected blocks.
//
//   St  start            F   finish          C  checkpoint
//   S   straight         B   boost pad       T  turbo pad
//   R/L tight curve      R2/L2 wide curve
//   U   slope up         D   slope down      J  jump ramp
//   G   gap (skip one cell, no block)
//   @n  set the current level to n          Sx3  repeat a token three times
//
// Placement order is preserved, so checkpoints are numbered in driving order.

import { DIR_X, DIR_Z, GRID, type Dir } from '../core/constants';
import { BLOCK_BY_CODE } from './blocks';
import { cellsFor, PlacedBlock, type Placement, type TrackData } from './track';

export function buildTrack(name: string, code: string, author = 'Velocity Works'): TrackData {
  let i = 0;
  let j = 0;
  let k = 0;
  let dir: Dir = 0;
  const blocks: Placement[] = [];
  const used = new Set<string>();

  const tokens = code.trim().split(/\s+/);
  for (let n = 0; n < tokens.length; n++) {
    const tok = tokens[n];
    if (tok.startsWith('@')) {
      k = Number(tok.slice(1));
      continue;
    }
    const m = /^(St|R2|L2|[FCSBTRLUDJG])(?:x(\d+))?$/.exec(tok);
    if (!m) throw new Error(`${name}: bad token "${tok}"`);
    const repeat = m[2] ? Number(m[2]) : 1;
    for (let r = 0; r < repeat; r++) {
      if (m[1] === 'G') {
        i += DIR_X[dir];
        j += DIR_Z[dir];
        continue;
      }
      const def = BLOCK_BY_CODE[m[1]];
      if (!def) throw new Error(`${name}: unknown block "${m[1]}"`);
      const p: Placement = { type: def.type, i, j, k, dir };
      for (const [ci, cj, ck] of cellsFor(p)) {
        const key = `${ci},${cj},${ck}`;
        if (used.has(key)) throw new Error(`${name}: block ${tok} (#${n}) overlaps cell ${key}`);
        if (ck < 0) throw new Error(`${name}: block ${tok} (#${n}) goes below ground`);
        used.add(key);
      }
      blocks.push(p);
      const nx = new PlacedBlock(p, 0).nextAnchor();
      i = nx.i;
      j = nx.j;
      k = nx.k;
      dir = nx.dir;
    }
  }
  return { name, author, blocks: normalise(blocks) };
}

/** Shift a block list so its footprint starts at cell (1, 1). */
export function normalise(blocks: Placement[]): Placement[] {
  let minI = Infinity;
  let minJ = Infinity;
  for (const p of blocks) {
    for (const [ci, cj] of cellsFor(p)) {
      minI = Math.min(minI, ci);
      minJ = Math.min(minJ, cj);
    }
  }
  if (!isFinite(minI)) return blocks;
  return blocks.map((p) => ({ ...p, i: p.i - minI + 1, j: p.j - minJ + 1 }));
}

/** Does the track fit inside the editor grid? */
export function fitsGrid(data: TrackData): boolean {
  return data.blocks.every((p) => cellsFor(p).every(([i, j]) => i >= 0 && j >= 0 && i < GRID && j < GRID));
}
