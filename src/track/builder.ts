// Text track format: a "turtle" walks the grid placing connected blocks.
//
//   St  start            F   finish          C  checkpoint
//   S   straight         B   boost pad       T  turbo pad
//   R/L tight curve      R2/L2 wide curve
//   U   slope up         D   slope down      J  jump ramp
//   G   gap (skip one cell, no block)       W  splash zone (shallow water on a straight)
//   @n  set the current level to n          Sx3  repeat a token three times
//
// Themes and water (the Desert and Water sets):
//   !desert !water !stadium   the track's theme (default stadium)      !sunset  low orange sun
//   !lake  a lagoon: every floor cell of the footprint (one cell beyond it) is water, except those within one
//          cell of a ground-level road (so a road on the floor always has a cell of land on each side)
//   ~    a gap with water in it: skips one cell like G and floods it, and the water runs on sideways as a
//        river (across the whole track footprint, one cell beyond it, past every ground-level road cell)
//   ~2   the same, but the river runs at most 2 cells to each side
//   ~S   (a prefix on any block, ~2S too) water under the block's cells, as a river: a bridge on a raised
//        deck, or a causeway at ground level (whose own cell stays dry)
//
// Placement order is preserved, so checkpoints are numbered in driving order. Water blocks come last.

import { DIR_X, DIR_Z, GRID, wrapDir, type Dir } from '../core/constants';
import { BLOCK_BY_CODE } from './blocks';
import { cellsFor, PlacedBlock, type Placement, type SkyKind, type Theme, type TrackData } from './track';

/** A river source: a cell, the heading the turtle crossed it with, and how far (cells) the river runs to each side. */
interface RiverSeed {
  i: number;
  j: number;
  dir: Dir;
  half: number;
}

export function buildTrack(name: string, code: string, author = 'Velocity Works'): TrackData {
  let i = 0;
  let j = 0;
  let k = 0;
  let dir: Dir = 0;
  let theme: Theme | undefined;
  let sky: SkyKind | undefined;
  let lake = false;
  const blocks: Placement[] = [];
  const used = new Set<string>();
  const seeds: RiverSeed[] = [];

  const tokens = code.trim().split(/\s+/);
  for (let n = 0; n < tokens.length; n++) {
    const tok = tokens[n];
    if (tok.startsWith('@')) {
      k = Number(tok.slice(1));
      continue;
    }
    if (tok.startsWith('!')) {
      const w = tok.slice(1);
      if (w === 'desert' || w === 'water' || w === 'stadium') theme = w;
      else if (w === 'sunset') sky = 'sunset';
      else if (w === 'lake') lake = true;
      else throw new Error(`${name}: bad token "${tok}"`);
      continue;
    }
    const gap = /^~(\d*)(?:x(\d+))?$/.exec(tok);
    const m = gap ? null : /^(?:~(\d*))?(St|R2|L2|[FCSBTRLUDJGW])(?:x(\d+))?$/.exec(tok);
    if (!gap && !m) throw new Error(`${name}: bad token "${tok}"`);
    const wet = gap !== null || tok.startsWith('~');
    const half = gap ? (gap[1] ? Number(gap[1]) : Infinity) : m![1] ? Number(m![1]) : Infinity;
    const sym = gap ? 'G' : m![2];
    const rep = gap ? gap[2] : m![3];
    const repeat = rep ? Number(rep) : 1;
    for (let r = 0; r < repeat; r++) {
      if (sym === 'G') {
        if (wet) seeds.push({ i, j, dir, half });
        i += DIR_X[dir];
        j += DIR_Z[dir];
        continue;
      }
      const def = BLOCK_BY_CODE[sym];
      if (!def || def.water) throw new Error(`${name}: unknown block "${sym}"`);
      const p: Placement = { type: def.type, i, j, k, dir };
      for (const [ci, cj, ck] of cellsFor(p)) {
        const key = `${ci},${cj},${ck}`;
        if (used.has(key)) throw new Error(`${name}: block ${tok} (#${n}) overlaps cell ${key}`);
        if (ck < 0) throw new Error(`${name}: block ${tok} (#${n}) goes below ground`);
        used.add(key);
        if (wet) seeds.push({ i: ci, j: cj, dir, half });
      }
      blocks.push(p);
      const nx = new PlacedBlock(p, 0).nextAnchor();
      i = nx.i;
      j = nx.j;
      k = nx.k;
      dir = nx.dir;
    }
  }
  blocks.push(...rivers(seeds, blocks, used, lake));
  return {
    name,
    author,
    blocks: normalise(blocks),
    ...(theme && theme !== 'stadium' ? { theme } : {}),
    ...(sky ? { sky } : {}),
  };
}

/** One cell beyond the road footprint: how far a river runs past the outermost road. */
const RIVER_MARGIN = 1;

/**
 * Water blocks for the river seeds: from each seed sideways (square to the heading it was crossed with) up to
 * its half-width or one cell past the road footprint, on every cell whose floor level is free. A ground-level
 * road cell stays dry (a causeway) and the river carries on beyond it.
 */
function rivers(seeds: RiverSeed[], roads: Placement[], used: Set<string>, lake: boolean): Placement[] {
  if (!seeds.length && !lake) return [];
  let minI = Infinity, minJ = Infinity, maxI = -Infinity, maxJ = -Infinity;
  for (const p of roads) {
    for (const [ci, cj] of cellsFor(p)) {
      minI = Math.min(minI, ci);
      minJ = Math.min(minJ, cj);
      maxI = Math.max(maxI, ci);
      maxJ = Math.max(maxJ, cj);
    }
  }
  minI -= RIVER_MARGIN;
  minJ -= RIVER_MARGIN;
  maxI += RIVER_MARGIN;
  maxJ += RIVER_MARGIN;
  const out: Placement[] = [];
  const wet = new Set<string>();
  const flood = (ci: number, cj: number, dir: Dir) => {
    const key = `${ci},${cj}`;
    if (wet.has(key) || used.has(`${ci},${cj},0`)) return;
    wet.add(key);
    out.push({ type: 'water', i: ci, j: cj, k: 0, dir });
  };
  if (lake) {
    // Land: every floor-level road cell and its eight neighbours.
    const land = new Set<string>();
    for (const key of used) {
      const [ci, cj, ck] = key.split(',').map(Number);
      if (ck !== 0) continue;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) land.add(`${ci + di},${cj + dj}`);
    }
    for (let cj = minJ; cj <= maxJ; cj++) {
      for (let ci = minI; ci <= maxI; ci++) if (!land.has(`${ci},${cj}`)) flood(ci, cj, 0);
    }
  }
  for (const s of seeds) {
    const rd = wrapDir(s.dir + 1);
    for (const side of [-1, 1]) {
      for (let t = side < 0 ? 1 : 0; t <= s.half; t++) {
        const ci = s.i + side * t * DIR_X[rd];
        const cj = s.j + side * t * DIR_Z[rd];
        if (ci < minI || ci > maxI || cj < minJ || cj > maxJ) break;
        flood(ci, cj, s.dir);
      }
    }
  }
  return out;
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
