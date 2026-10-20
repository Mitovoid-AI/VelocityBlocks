// Shareable track file format (JSON). Our own format; it is not compatible with any other game's files.
//
// {
//   "format": "velocity-blocks-track", "version": 1,
//   "name": "...", "author": "...", "authorTime": 23450,
//   "authorTimes": { "bike": { "t": 25100, "rev": 1 } },   // optional: the other vehicle classes
//   "blocks": [["St", 3, 4, 0, 0], ["S", 3, 3, 0, 0], ...]   // [code, i, j, level, dir]
// }
// authorTime is the car's. Older builds ignore authorTimes; an entry for another class revision is kept and
// simply not used (authorTimeFor), like an old ghost.

import { GRID, MAX_LEVEL, type Dir } from '../core/constants';
import { BLOCK_BY_CODE, BLOCKS } from './blocks';
import { cellsFor, type ClassAuthorTime, type Placement, type TrackData } from './track';

export const FORMAT_ID = 'velocity-blocks-track';

export function exportTrack(data: TrackData): string {
  return JSON.stringify(
    {
      format: FORMAT_ID,
      version: 1,
      name: data.name,
      author: data.author,
      authorTime: data.authorTime ?? null,
      ...(data.authorTimes && Object.keys(data.authorTimes).length ? { authorTimes: data.authorTimes } : {}),
      blocks: data.blocks.map((b) => [BLOCKS[b.type].code, b.i, b.j, b.k, b.dir]),
    },
    null,
    1,
  );
}

export function importTrack(text: string): TrackData {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const obj = o as Record<string, unknown>;
  if (!obj || obj.format !== FORMAT_ID) throw new Error('This is not a Velocity Blocks track file.');
  if (!Array.isArray(obj.blocks) || obj.blocks.length > 2000) throw new Error('The block list is missing or too large.');
  const blocks: Placement[] = [];
  const used = new Set<string>();
  for (const row of obj.blocks as unknown[]) {
    if (!Array.isArray(row) || row.length !== 5) throw new Error('Malformed block entry.');
    const [code, i, j, k, dir] = row as [string, number, number, number, number];
    const def = BLOCK_BY_CODE[code];
    if (!def) throw new Error(`Unknown block "${String(code)}".`);
    if (![i, j, k, dir].every((n) => Number.isInteger(n))) throw new Error('Block coordinates must be integers.');
    if (dir < 0 || dir > 3) throw new Error('Block direction out of range.');
    const p: Placement = { type: def.type, i, j, k, dir: dir as Dir };
    for (const [ci, cj, ck] of cellsFor(p)) {
      if (ci < 0 || cj < 0 || ci >= GRID || cj >= GRID || ck < 0 || ck > MAX_LEVEL)
        throw new Error('A block lies outside the 32 x 32 grid.');
      const key = `${ci},${cj},${ck}`;
      if (used.has(key)) throw new Error('Two blocks overlap.');
      used.add(key);
    }
    blocks.push(p);
  }
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 40) : 'Imported track';
  const author = typeof obj.author === 'string' ? obj.author.slice(0, 30) : 'Unknown';
  const at = typeof obj.authorTime === 'number' && obj.authorTime > 0 ? Math.round(obj.authorTime) : undefined;
  const authorTimes = classTimes(obj.authorTimes);
  return { name, author, blocks, authorTime: at, ...(authorTimes ? { authorTimes } : {}) };
}

/** The valid Bike and Truck author times of an imported file: positive finite times with a revision. */
function classTimes(raw: unknown): TrackData['authorTimes'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: NonNullable<TrackData['authorTimes']> = {};
  for (const cls of ['bike', 'truck'] as const) {
    const e = (raw as Record<string, unknown>)[cls] as Partial<ClassAuthorTime> | undefined;
    if (!e || typeof e !== 'object') continue;
    const { t, rev } = e;
    if (typeof t !== 'number' || !(t > 0) || !isFinite(t) || !Number.isInteger(rev) || rev! < 0) continue;
    out[cls] = { t: Math.round(t), rev: rev! };
  }
  return Object.keys(out).length ? out : undefined;
}
