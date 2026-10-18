import { describe, expect, it } from 'vitest';
import { buildTrack } from '../src/track/builder';
import { barrierRange, Track } from '../src/track/track';

describe('builder', () => {
  it('rejects overlapping layouts', () => {
    expect(() => buildTrack('loop', 'St R R R R S F')).toThrow(/overlaps/);
  });

  it('places a right turn heading east', () => {
    const t = new Track(buildTrack('turn', 'St R S F'));
    const last = t.blocks[t.blocks.length - 1];
    expect(last.p.dir).toBe(1);
  });

  it('reports road surface on the deck and grass beside it', () => {
    const t = new Track(buildTrack('s', '@1 St Sx2 F'));
    const c = t.blocks[1].centerWorld(16);
    const on = t.surfaceAt(c.x, c.y + 0.5, c.z);
    expect(on.road).toBe(true);
    expect(on.y).toBeCloseTo(8);
    const off = t.surfaceAt(c.x + 14, c.y + 0.5, c.z);
    expect(off.road).toBe(false);
    expect(off.y).toBe(0);
  });

  it('keeps barriers only on elevated decks', () => {
    // Ground level: the road edge opens onto the grass.
    const t0 = new Track(buildTrack('g', 'St Sx2 F'));
    const b0 = t0.blocks[1];
    const p0 = b0.toWorld(12, 16);
    expect(t0.wallAt(p0.x, 0.9, p0.z)).toBeNull();
    // Level 1: the same point at deck height is inside the barrier, pushed back toward the centre line.
    const t1 = new Track(buildTrack('h', '@1 St Sx2 F'));
    const b1 = t1.blocks[1];
    const p1 = b1.toWorld(12, 16);
    const wall = t1.wallAt(p1.x, 8.9, p1.z);
    expect(wall).not.toBeNull();
    expect(wall!.nx * b1.rx + wall!.nz * b1.rz).toBeCloseTo(-1);
    // A slope from the floor is a solid embankment with barriers on its upper half only.
    const t2 = new Track(buildTrack('s', 'St S U S F'));
    const u = t2.blocks[2];
    expect(u.embank).toBe(true);
    expect(u.highEndS).toBe(64);
    const r = barrierRange(u)!;
    expect(r[0]).toBeCloseTo(32, 3);
    expect(r[1]).toBe(64);
    expect(barrierRange(t2.blocks[1])).toBeNull();
    expect(barrierRange(t2.blocks[3])).toEqual([0, 32]);
  });
});
