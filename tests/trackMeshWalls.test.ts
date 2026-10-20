// Barrier meshes with "Walls on all roads": drawn exactly where the physics has a wall (raycast against
// the merged barrier mesh vs Track.wallAt, from the road and from the grass), end caps only at open ends,
// and the campaign still inside the draw-call budget with one merged barrier mesh.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BARRIER_MIN_Y, DECK_EDGE, WALL_H, WALL_OFF } from '../src/core/constants';
import { centerAt, projectLocal } from '../src/track/blocks';
import { buildTrack } from '../src/track/builder';
import { campaign } from '../src/track/campaign';
import { barrierRange, Track, type PlacedBlock } from '../src/track/track';
import { barrierPlan, buildTrackVisual } from '../src/render/trackMesh';

function barrierOf(track: Track): THREE.Mesh | undefined {
  const v = buildTrackVisual(track);
  const m = v.group.children.find((c) => c.name === 'barrier') as THREE.Mesh | undefined;
  m?.updateMatrixWorld(true);
  return m;
}

const tris = (m: THREE.Mesh | undefined) =>
  m ? (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3 : 0;

/** World point and the outward (side) lateral direction at distance s, offset d, height above the deck. */
function frame(blk: PlacedBlock, s: number, d: number, up: number, side: number) {
  const c = centerAt(blk.def, s);
  const w = blk.toWorld(c.a + c.tb * d, c.b - c.ta * d);
  const r = blk.dirToWorld(c.tb * side, -c.ta * side);
  const y = blk.baseY + blk.def.height(s) + up;
  return { p: new THREE.Vector3(w.x, y, w.z), out: new THREE.Vector3(r.x, 0, r.z) };
}

/** Distance along a ray to the first barrier face, or null. */
function hit(mesh: THREE.Mesh | undefined, from: THREE.Vector3, dir: THREE.Vector3, far: number): number | null {
  if (!mesh) return null;
  const hits = new THREE.Raycaster(from, dir.clone().normalize(), 0, far).intersectObject(mesh, false);
  return hits.length ? hits[0].distance : null;
}

/** Layouts with every block kind: ground roads, curves both ways, a jump with its gap, slopes up to a raised deck and down. */
const LAYOUTS = [
  'St S R S L C R2 S J G S L2 S U S R S D S F',
  '@1 St S R R2 S L S D S F',
  'St B T S R R S U @1 J G S D L S F',
];

describe.each(LAYOUTS)('barriers match the physics: %s', (code) => {
  for (const walls of [false, true]) {
    const track = new Track(buildTrack('t', code), { walls });
    const mesh = barrierOf(track);
    const mid = (WALL_OFF + DECK_EDGE) / 2;

    it(`walls ${walls ? 'on' : 'off'}: from the road, a barrier is drawn at the inner face exactly where wallAt pushes back`, () => {
      let walled = 0;
      for (const blk of track.blocks) {
        // Not 0.5: a slope's deck is exactly BARRIER_MIN_Y there, where a native barrier starts or stops.
        for (const f of [0.1, 0.3, 0.45, 0.7, 0.9]) {
          const s = blk.def.length * f;
          for (const side of [-1, 1]) {
            // A probe inside the drawn slab, at mid barrier height, with the car centre on the road.
            const probe = frame(blk, s, side * mid, WALL_H / 2, side);
            const centre = frame(blk, s, side * 5, WALL_H / 2, side);
            const phys = track.wallAt(probe.p.x, probe.p.y, probe.p.z, centre.p.x, centre.p.z) !== null;
            const from = frame(blk, s, side * (WALL_OFF - 1), WALL_H / 2, side);
            const dist = hit(mesh, from.p, from.out, 2.5);
            const where = `${blk.def.type}#${blk.index} s=${s.toFixed(1)} side ${side}`;
            expect(dist !== null, where).toBe(phys);
            if (dist !== null) {
              // Curves are drawn as chords: the outer barrier of a tight curve sits up to 4 cm inside the arc.
              expect(Math.abs(dist - 1), where).toBeLessThan(0.04);
              walled++;
            }
          }
        }
      }
      if (walls) expect(walled).toBe(track.blocks.length * 10);
      else expect(walled).toBeGreaterThan(0);
    });
  }

  it('walls on: from the grass, the outer face is drawn at the deck edge and the physics pushes the car back out', () => {
    const track = new Track(buildTrack('t', code), { walls: true });
    const mesh = barrierOf(track);
    let n = 0;
    for (const blk of track.blocks) {
      for (const f of [0.3, 0.7]) {
        const s = blk.def.length * f;
        if (blk.baseY + blk.def.height(s) >= BARRIER_MIN_Y) continue; // a raised deck: no one meets it from outside
        for (const side of [-1, 1]) {
          const from = frame(blk, s, side * (DECK_EDGE + 1.5), WALL_H / 2, side);
          const dist = hit(mesh, from.p, from.out.clone().negate(), 3);
          const where = `${blk.def.type}#${blk.index} s=${s.toFixed(1)} side ${side}`;
          expect(dist, where).not.toBeNull();
          expect(Math.abs(dist! - 1.5), where).toBeLessThan(0.05);
          const probe = frame(blk, s, side * (DECK_EDGE + 0.1), WALL_H / 2, side);
          const centre = frame(blk, s, side * (DECK_EDGE + 2.5), WALL_H / 2, side);
          const w = track.wallAt(probe.p.x, probe.p.y, probe.p.z, centre.p.x, centre.p.z);
          expect(w, where).not.toBeNull();
          // Outward: along the side direction, away from the road.
          expect(w!.nx * probe.out.x + w!.nz * probe.out.z, where).toBeGreaterThan(0.9);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(8);
  });
});

describe('barrier end caps', () => {
  /** Per block of a straight (2 rows): inner face 4, rounded top 8, outer face 2 triangles a side. */
  const PER_STRAIGHT = 2 * (4 + 8 + 2);
  /** One end cap: the 5-point rounded profile, both windings. */
  const CAP = 2 * 8;

  it('closes only open ends: a joint between two barriers has none', () => {
    for (const k of [1, 3, 8]) {
      const track = new Track(buildTrack('s', `St Sx${k} F`), { walls: true });
      // Caps at the start's entry and the finish's exit only, two sides each.
      expect(tris(barrierOf(track))).toBe((k + 2) * PER_STRAIGHT + 4 * CAP);
    }
    // Raised the same way without the setting (native barriers).
    expect(tris(barrierOf(new Track(buildTrack('h', '@1 St Sx3 F'))))).toBe(5 * PER_STRAIGHT + 4 * CAP);
  });

  it('keeps caps at a jump gap, the start, the finish and where a barrier stops mid-slope', () => {
    const jump = new Track(buildTrack('j', 'St S J G S F'), { walls: true });
    const plan = barrierPlan(jump);
    const [st, s1, ramp, land, fin] = jump.blocks;
    expect(plan.joined(st, 0)).toBe(false);
    expect(plan.joined(st, 32)).toBe(true);
    expect(plan.joined(s1, 0)).toBe(true);
    expect(plan.joined(ramp, 0)).toBe(true);
    expect(plan.joined(ramp, 32)).toBe(false); // the ramp lip, over the gap
    expect(plan.joined(land, 0)).toBe(false); // the landing's entry
    expect(plan.joined(fin, 32)).toBe(false);
    expect(plan.joined(s1, 16)).toBe(false); // never mid-block
    // Without the setting a slope from the floor walls only its upper half: that end is open.
    const slope = new Track(buildTrack('u', 'St S U S D S F'));
    const sp = barrierPlan(slope);
    const up = slope.blocks[2];
    const r = sp.ranges[up.index]!;
    expect(r).toEqual(barrierRange(up));
    expect(r[0]).toBeGreaterThan(0);
    expect(sp.joined(up, 64)).toBe(true);
    expect(sp.joined(slope.blocks[3], 0)).toBe(true);
    expect(sp.joined(slope.blocks[3], 32)).toBe(true);
  });

  it('a ray along a continuous barrier meets no cap; across a gap it meets both lips', () => {
    const mid = (WALL_OFF + DECK_EDGE) / 2;
    const straight = new Track(buildTrack('s', 'St Sx3 F'), { walls: true });
    const m1 = barrierOf(straight);
    const a = straight.blocks[1];
    for (const side of [-1, 1]) {
      const from = frame(a, 1, side * mid, WALL_H / 2, side).p;
      // Along the road inside the slab, from block 1 to the end of block 3 (96 m).
      expect(hit(m1, from, new THREE.Vector3(a.fx, 0, a.fz), 94)).toBeNull();
    }
    const jump = new Track(buildTrack('j', 'St S J G S F'), { walls: true });
    const m2 = barrierOf(jump);
    const ramp = jump.blocks[2];
    for (const side of [-1, 1]) {
      // Just past the lip, over the gap at lip height, back towards the ramp: its cap faces the gap.
      const lip = frame(ramp, 32, side * mid, 0.5, side).p;
      const fwd = new THREE.Vector3(ramp.fx, 0, ramp.fz);
      expect(hit(m2, lip.clone().addScaledVector(fwd, 1), fwd.clone().negate(), 2)).toBeCloseTo(1, 3);
      // On to the landing block: its entry cap.
      const land = frame(jump.blocks[3], 0, side * mid, 0.5, side).p;
      expect(hit(m2, land.clone().addScaledVector(fwd, -1), fwd, 2)).toBeCloseTo(1, 3);
    }
  });
});

describe('pillars with walls on all roads', () => {
  it('no campaign pillar stands inside a barrier (custom tracks can still place one there)', () => {
    let pillars = 0;
    for (const ct of campaign()) {
      const track = new Track(ct.data, { walls: true });
      for (const c of track.columns) {
        if (c.kind !== 'pillar') continue;
        pillars++;
        // Clear of the slab by the half-diagonal of the drawn pillar's 2 m cap, at any heading.
        const reach = Math.SQRT2;
        for (const blk of track.blocks) {
          const l = blk.toLocal(c.x, c.z);
          const h = projectLocal(blk.def, l.a, l.b, 0);
          if (!h) continue;
          const deck = blk.baseY + h.h;
          if (deck > c.y1 || deck + WALL_H < c.y0) continue; // the barrier is above or below this pillar
          const ad = Math.abs(h.d);
          expect(ad < WALL_OFF - reach || ad > DECK_EDGE + reach, `${ct.id} pillar at ${c.x.toFixed(1)},${c.z.toFixed(1)} by ${blk.def.type}#${blk.index}`).toBe(true);
        }
      }
    }
    expect(pillars).toBeGreaterThan(100);
  });

});

describe.each(campaign().map((c) => ({ id: c.id, data: c.data })))('$id with walls on all roads', ({ data }) => {
  it('stays within the draw-call budget, with one merged barrier mesh along every block', () => {
    const open = buildTrackVisual(new Track(data));
    const v = buildTrackVisual(new Track(data, { walls: true }));
    const ms = v.group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    expect(ms.length).toBeLessThanOrEqual(16);
    const barriers = ms.filter((m) => m.name === 'barrier');
    expect(barriers.length).toBe(1);
    const b = barriers[0];
    expect(b.castShadow).toBe(true);
    expect(Array.from(b.geometry.attributes.position.array).every(Number.isFinite)).toBe(true);
    const col = b.geometry.attributes.color.array as Float32Array;
    expect(col.reduce((a, x) => Math.min(a, x), 1)).toBeGreaterThanOrEqual(0);
    expect(col.reduce((a, x) => Math.max(a, x), 0)).toBeLessThanOrEqual(1);
    const openBarrier = open.group.children.find((c) => c.name === 'barrier') as THREE.Mesh | undefined;
    expect(tris(b)).toBeGreaterThanOrEqual(tris(openBarrier));
    const track = new Track(data, { walls: true });
    const plan = barrierPlan(track);
    for (const blk of track.blocks) expect(plan.ranges[blk.index]).toEqual([0, blk.def.length]);
    // Same meshes otherwise: walls add at most the barrier mesh itself.
    expect(ms.length - open.group.children.length).toBeLessThanOrEqual(1);
    open.dispose();
    v.dispose();
  });
});
