// Track model: placed blocks, spatial lookup, surface/barrier queries and gate data.

import {
  BARRIER_MIN_Y,
  CELL,
  DECK_EDGE,
  DECK_T,
  DIR_X,
  DIR_Z,
  LEVEL_H,
  STADIUM_PAD,
  VEHICLE_REV,
  WALL_H,
  WALL_OFF,
  wrapDir,
  type Dir,
} from '../core/constants';
import type { VehicleClass } from '../core/vehicles';
import { BLOCKS, centerAt, projectLocal, type BlockDef, type BlockType, type LocalHit } from './blocks';

export interface Placement {
  type: BlockType;
  /** Anchor cell column (x). */
  i: number;
  /** Anchor cell row (z). */
  j: number;
  /** Level (0 = ground). */
  k: number;
  /** Entry heading. */
  dir: Dir;
}

export interface TrackData {
  name: string;
  author: string;
  blocks: Placement[];
  /** The car's author time in milliseconds when known (set by a walls-off test drive). */
  authorTime?: number;
  /** The other classes' author times, each with the VEHICLE_REV it was driven with (a retune retires it). */
  authorTimes?: Partial<Record<Exclude<VehicleClass, 'car'>, ClassAuthorTime>>;
}

/** A Bike or Truck author time on a custom track (ms), and the class revision it belongs to. */
export interface ClassAuthorTime {
  t: number;
  rev: number;
}

/** A custom track's author time for a vehicle class, or null when it has none for the class's current revision. */
export function authorTimeFor(d: TrackData, vehicle: VehicleClass): number | null {
  if (vehicle === 'car') return d.authorTime ?? null;
  const a = d.authorTimes?.[vehicle];
  return a && a.rev === VEHICLE_REV[vehicle] ? a.t : null;
}

/** A copy of the track data with one class's author time set (or cleared with undefined). */
export function withAuthorTime(d: TrackData, vehicle: VehicleClass, t: number | undefined): TrackData {
  if (vehicle === 'car') return { ...d, authorTime: t };
  const times = { ...d.authorTimes };
  if (t === undefined) delete times[vehicle];
  else times[vehicle] = { t, rev: VEHICLE_REV[vehicle] };
  return { ...d, authorTimes: Object.keys(times).length ? times : undefined };
}

export class PlacedBlock {
  readonly def: BlockDef;
  /** Entry point (world x/z). */
  readonly ex: number;
  readonly ez: number;
  /** Forward and right unit vectors (world x/z). */
  readonly fx: number;
  readonly fz: number;
  readonly rx: number;
  readonly rz: number;
  readonly baseY: number;
  /** Slope or ramp rising from the stadium floor: drawn and collided as a solid embankment. */
  readonly embank: boolean;
  /** Distance along the block of its high end (used for embankments). */
  readonly highEndS: number;

  constructor(
    readonly p: Placement,
    readonly index: number,
  ) {
    this.def = BLOCKS[p.type];
    this.fx = DIR_X[p.dir];
    this.fz = DIR_Z[p.dir];
    const rd = wrapDir(p.dir + 1);
    this.rx = DIR_X[rd];
    this.rz = DIR_Z[rd];
    const cx = (p.i + 0.5) * CELL;
    const cz = (p.j + 0.5) * CELL;
    this.ex = cx - this.fx * (CELL / 2);
    this.ez = cz - this.fz * (CELL / 2);
    this.baseY = p.k * LEVEL_H;
    const d = this.def;
    const y0 = this.baseY + d.height(0);
    const y1 = this.baseY + d.height(d.length);
    this.embank = d.path === 'line' && Math.min(y0, y1) <= 0.01 && Math.max(y0, y1) > 0.01;
    this.highEndS = y1 >= y0 ? d.length : 0;
  }

  /** World x/z at distance s along the centre line, offset d to the right of it. */
  pointAt(s: number, d: number): { x: number; z: number } {
    const c = centerAt(this.def, s);
    return this.toWorld(c.a + c.tb * d, c.b - c.ta * d);
  }

  /** World x/z -> local a/b. */
  toLocal(x: number, z: number): { a: number; b: number } {
    const dx = x - this.ex;
    const dz = z - this.ez;
    return { a: dx * this.rx + dz * this.rz, b: dx * this.fx + dz * this.fz };
  }

  /** Local a/b -> world x/z. */
  toWorld(a: number, b: number): { x: number; z: number } {
    return { x: this.ex + b * this.fx + a * this.rx, z: this.ez + b * this.fz + a * this.rz };
  }

  /** Local direction -> world direction (x/z). */
  dirToWorld(da: number, db: number): { x: number; z: number } {
    return { x: db * this.fx + da * this.rx, z: db * this.fz + da * this.rz };
  }

  /** World cells covered by this block: [i, j, k]. */
  cells(): [number, number, number][] {
    return cellsFor(this.p);
  }

  /** Placement of the block that would continue this one. */
  nextAnchor(): { i: number; j: number; k: number; dir: Dir } {
    const n = this.def.next;
    return {
      i: this.p.i + n.fwd * this.fx + n.lat * this.rx,
      j: this.p.j + n.fwd * this.fz + n.lat * this.rz,
      k: this.p.k + n.dk,
      dir: wrapDir(this.p.dir + this.def.turn),
    };
  }

  /** World position on the centre line at distance s. */
  centerWorld(s: number): { x: number; y: number; z: number; hx: number; hz: number } {
    const c = centerAt(this.def, s);
    const w = this.toWorld(c.a, c.b);
    const t = this.dirToWorld(c.ta, c.tb);
    return { x: w.x, y: this.baseY + this.def.height(s), z: w.z, hx: t.x, hz: t.z };
  }
}

export function cellsFor(p: Placement): [number, number, number][] {
  const def = BLOCKS[p.type];
  const fx = DIR_X[p.dir];
  const fz = DIR_Z[p.dir];
  const rd = wrapDir(p.dir + 1);
  const rx = DIR_X[rd];
  const rz = DIR_Z[rd];
  return def.cells.map(([lat, fwd, dk]) => [p.i + fwd * fx + lat * rx, p.j + fwd * fz + lat * rz, p.k + dk]);
}

export interface SurfaceHit {
  y: number;
  /** Surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Friction multiplier (1 = asphalt). */
  grip: number;
  road: boolean;
  block: PlacedBlock | null;
}

export interface WallHit {
  /** Push-out direction (horizontal unit vector). */
  nx: number;
  nz: number;
  depth: number;
}

export interface Gate {
  kind: 'start' | 'checkpoint' | 'finish';
  block: PlacedBlock;
  /** Order of the checkpoint among checkpoints (by placement order). */
  id: number;
}

/** Solid vertical cylinder: a gate post or a bridge pillar. */
export interface Column {
  x: number;
  z: number;
  r: number;
  /** Bottom and top heights. */
  y0: number;
  y1: number;
  kind: 'post' | 'pillar';
}

const GRASS_GRIP = 0.55;
/**
 * Walls on all roads: the face of an added (low) barrier as a hull meets it from the grass, the deck slab's
 * outer edge plus the 0.2 m hull-inside-bumper allowance the start back wall uses.
 */
const WALL_OUTER = DECK_EDGE + 0.2;
/**
 * A car centre at most this far out towards an added barrier is on the road: the barrier holds it in with
 * the full reach. Every class's centre stays inside it while its hull touches the barrier (the bike's
 * narrow hull touches with its centre at 10.15 m). A centre between this and WALL_OUTER straddles the
 * barrier line, which only happens around an open end (a jump gap, the finish): the slab then pushes a
 * hull point out of its nearer face only.
 */
const WALL_IN = WALL_OFF - 0.2;
/**
 * Largest push-out (m) an added barrier gives a hull point in one tick: a car that came round an open end
 * with a corner beyond the barrier line slides off it over a few ticks instead of jumping sideways.
 */
const WALL_STEP = 0.4;
/** Embankment faces: a hull point this far below the deck top counts as hitting the side. */
const SIDE_STEP = 0.05;
/** Width of the band inside an embankment's edge (and high end) that belongs to the solid face. */
const SIDE_BAND = 1.2;
/** Columns are indexed into every cell a car centred this close to their surface can be in. */
const COL_REACH = 3;
const key = (i: number, j: number) => (i + 512) * 4096 + (j + 512);

export class Track {
  readonly blocks: PlacedBlock[];
  private readonly index = new Map<number, PlacedBlock[]>();
  readonly gates: Gate[] = [];
  readonly start: PlacedBlock | null;
  /** Every start block (each one gets a back wall). */
  readonly starts: PlacedBlock[] = [];
  readonly checkpointCount: number;
  /** Bounds in cells (inclusive min, exclusive max). */
  readonly minI: number;
  readonly minJ: number;
  readonly maxI: number;
  readonly maxJ: number;
  /** Gate posts and pillars, shared by the renderer and the physics. */
  readonly columns: Column[] = [];
  private readonly colIndex = new Map<number, Column[]>();
  /** Settings > "Walls on all roads": barriers along every road edge, not only on raised decks. */
  readonly walls: boolean;

  constructor(
    readonly data: TrackData,
    opts: { walls?: boolean } = {},
  ) {
    this.walls = opts.walls === true;
    this.blocks = data.blocks.map((p, n) => new PlacedBlock(p, n));
    let minI = Infinity, minJ = Infinity, maxI = -Infinity, maxJ = -Infinity;
    let cps = 0;
    let start: PlacedBlock | null = null;
    for (const b of this.blocks) {
      for (const [i, j] of b.cells()) {
        const k = key(i, j);
        let list = this.index.get(k);
        if (!list) this.index.set(k, (list = []));
        if (!list.includes(b)) list.push(b);
        minI = Math.min(minI, i);
        minJ = Math.min(minJ, j);
        maxI = Math.max(maxI, i + 1);
        maxJ = Math.max(maxJ, j + 1);
      }
      const g = b.def.gate;
      if (g) {
        this.gates.push({ kind: g, block: b, id: g === 'checkpoint' ? cps++ : 0 });
        if (g === 'start') {
          if (!start) start = b;
          this.starts.push(b);
        }
      }
    }
    this.start = start;
    this.checkpointCount = cps;
    if (!isFinite(minI)) {
      minI = minJ = 0;
      maxI = maxJ = 1;
    }
    this.minI = minI;
    this.minJ = minJ;
    this.maxI = maxI;
    this.maxJ = maxJ;
    // Last: pillar placement queries surfaceAt, which needs the cell index.
    this.buildColumns();
  }

  private buildColumns(): void {
    for (const b of this.blocks) {
      if (b.def.gate) {
        const y0 = b.baseY + b.def.height(16);
        for (const side of [-1, 1]) {
          const w = b.pointAt(16, side * DECK_EDGE);
          this.addColumn({ x: w.x, z: w.z, r: 0.5, y0, y1: y0 + 7.5, kind: 'post' });
        }
      }
      // Embankments are solid down to the floor and need no pillars.
      if (b.embank) continue;
      const L = b.def.length;
      for (const s of L > 40 ? [L * 0.25, L * 0.75] : [L * 0.5]) {
        const top = b.baseY + b.def.height(s) - DECK_T;
        if (top < 1.5) continue;
        for (const side of [-1, 1]) {
          const w = b.pointAt(s, side * 6.5);
          // No pillar where it would stand on a deck below.
          if (this.surfaceAt(w.x, top - 1, w.z, 0).road) continue;
          this.addColumn({ x: w.x, z: w.z, r: 0.85, y0: 0, y1: top, kind: 'pillar' });
        }
      }
    }
  }

  private addColumn(c: Column): void {
    this.columns.push(c);
    const keys = new Set<number>();
    const m = c.r + COL_REACH;
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) keys.add(key(Math.floor((c.x + dx * m) / CELL), Math.floor((c.z + dz * m) / CELL)));
    }
    for (const k of keys) {
      let list = this.colIndex.get(k);
      if (!list) this.colIndex.set(k, (list = []));
      list.push(c);
    }
  }

  /** Gate posts and pillars that a car centred at (x, z) could touch. */
  columnsNear(x: number, z: number): Column[] | undefined {
    return this.colIndex.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  /** Solid faces of embankments: push-out for a hull point below the deck top near a side or the high end. */
  sideAt(x: number, y: number, z: number): WallHit | null {
    const list = this.blocksAt(x, z);
    if (!list) return null;
    for (const blk of list) {
      if (!blk.embank) continue;
      const l = blk.toLocal(x, z);
      const L = blk.def.length;
      if (l.b < 0 || l.b > L) continue;
      const ad = Math.abs(l.a);
      if (ad >= DECK_EDGE) continue;
      const sy = blk.baseY + blk.def.height(l.b);
      if (y >= sy - SIDE_STEP || y < -1) continue;
      let best: WallHit | null = null;
      if (ad > DECK_EDGE - SIDE_BAND) {
        const sg = l.a > 0 ? 1 : -1;
        best = { nx: blk.rx * sg, nz: blk.rz * sg, depth: DECK_EDGE - ad };
      }
      const endDepth = blk.highEndS > 0 ? L - l.b : l.b;
      if (endDepth < SIDE_BAND && (!best || endDepth < best.depth)) {
        const sg = blk.highEndS > 0 ? 1 : -1;
        best = { nx: blk.fx * sg, nz: blk.fz * sg, depth: endDepth };
      }
      if (best) return best;
    }
    return null;
  }

  /** Deck height of the highest embankment whose solid footprint contains (x, z), or null. */
  embankTopAt(x: number, z: number): number | null {
    const list = this.blocksAt(x, z);
    if (!list) return null;
    let top: number | null = null;
    for (const blk of list) {
      if (!blk.embank) continue;
      const l = blk.toLocal(x, z);
      if (l.b < 0 || l.b > blk.def.length || Math.abs(l.a) >= DECK_EDGE) continue;
      const sy = blk.baseY + blk.def.height(l.b);
      if (top === null || sy > top) top = sy;
    }
    return top;
  }

  /** Blocks whose footprint includes the cell containing world (x, z). */
  blocksAt(x: number, z: number): PlacedBlock[] | undefined {
    return this.index.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  /**
   * Highest drivable surface at (x, z) that is not more than `reach` metres above y.
   * Falls back to the grass ground plane at y = 0.
   */
  surfaceAt(x: number, y: number, z: number, reach = 1.5): SurfaceHit {
    let best: SurfaceHit | null = null;
    const list = this.blocksAt(x, z);
    if (list) {
      for (const blk of list) {
        const l = blk.toLocal(x, z);
        const hit = projectLocal(blk.def, l.a, l.b);
        if (!hit || Math.abs(hit.d) > WALL_OFF + 0.3) continue;
        const sy = blk.baseY + hit.h;
        if (sy > y + reach) continue;
        if (best && sy <= best.y) continue;
        // Below an embankment's top near its side or high end: that is the solid face (sideAt), not the deck.
        if (blk.embank && y < sy - SIDE_STEP) {
          const endDepth = blk.highEndS > 0 ? blk.def.length - l.b : l.b;
          if (Math.abs(l.a) > DECK_EDGE - SIDE_BAND || endDepth < SIDE_BAND) continue;
        }
        best = surfaceFromHit(blk, hit, sy);
      }
    }
    if (best) return best;
    return { y: 0, nx: 0, ny: 1, nz: 0, grip: GRASS_GRIP, road: false, block: null };
  }

  /**
   * Barrier contact for a point; returns the push-out vector when the point is inside a barrier. (cx, cz) is
   * the car centre (stepCar passes where it was a moment ago): with walls on all roads a low barrier can be
   * met from the grass too, and the centre picks the face. `lift` is how far the probe sits above the hull
   * point it stands for (VehicleSpec.wallProbe), so the embankment hand-over below meets sideAt's step.
   */
  wallAt(x: number, y: number, z: number, cx = x, cz = z, lift = 0.3): WallHit | null {
    // Back wall behind each start line, solid from both sides and not tied to one cell. The drawn wall
    // spans b in [-0.6, 0]; hull corners sit about 0.2 m inside the visible bumpers, so the solid slab
    // is the drawn one grown by that much and the car stops touching the concrete.
    for (const blk of this.starts) {
      const l = blk.toLocal(x, z);
      if (Math.abs(l.a) >= DECK_EDGE || l.b <= -0.8 || l.b >= 0.2) continue;
      if (y < blk.baseY - 1.2 || y > blk.baseY + WALL_H) continue;
      return l.b >= -0.3
        ? { nx: blk.fx, nz: blk.fz, depth: 0.2 - l.b }
        : { nx: -blk.fx, nz: -blk.fz, depth: l.b + 0.8 };
    }
    const list = this.blocksAt(x, z);
    if (list) {
      let wall: WallHit | null = null;
      for (const blk of list) {
        const l = blk.toLocal(x, z);
        const hit = projectLocal(blk.def, l.a, l.b, 0.5);
        if (!hit) continue;
        const sy = blk.baseY + hit.h;
        if (y < sy - 1.2 || y > sy + WALL_H) continue;
        const ad = Math.abs(hit.d);
        // On the deck of some block at this height: no barrier applies here.
        if (ad <= WALL_OFF && projectLocal(blk.def, l.a, l.b)) return null;
        // Side barriers only where the deck is high enough to fall from; low decks open onto the grass.
        // On an embankment the solid side face (sideAt) owns everything below the deck and outside the
        // drawn barrier; letting both claim a point pushes the car back and forth by metres per tick.
        // The probe sits `lift` above its hull point, which sideAt claims below sy - SIDE_STEP: the barrier
        // takes over exactly there, so no hull point slips between the two (the car's 0.3 lift gives the
        // 0.25 it always had; the truck's low probe would otherwise leave a 0.27 m gap onto a low slope).
        const reach = blk.embank ? DECK_EDGE : WALL_OFF + 2.6;
        if (blk.embank && y < sy + 0.25 - (0.3 - lift)) continue;
        if (wall || ad <= WALL_OFF) continue;
        const native = sy >= BARRIER_MIN_Y;
        if (!native && !this.walls) continue;
        // Right-of-tangent direction in local frame is (tb, -ta); w points back towards the centre line.
        const sgn = hit.d > 0 ? -1 : 1;
        const w = blk.dirToWorld(hit.tb * sgn, -hit.ta * sgn);
        if (native) {
          if (ad < reach) wall = { nx: w.x, nz: w.z, depth: ad - WALL_OFF };
          continue;
        }
        // An added barrier: the centre's offset towards this barrier (negative across the centre line).
        const cd = this.centreOffset(blk, cx, cz) * Math.sign(hit.d);
        if (cd < WALL_IN && (this.spans(blk, cx, cz) || this.onDeckAt(cx, y, cz))) {
          // A car on the road: held in like by a raised barrier.
          if (ad < reach) wall = { nx: w.x, nz: w.z, depth: Math.min(ad - WALL_OFF, WALL_STEP) };
        } else if (ad < WALL_OUTER) {
          // From the grass, astride the barrier line, or beside an open end: only the slab is solid, and the
          // hull point leaves it by the outer face (or the inner one, when that is nearer and the car is not
          // clearly outside).
          const outward = cd >= WALL_OUTER || WALL_OUTER - ad <= ad - WALL_OFF;
          wall = outward ? { nx: -w.x, nz: -w.z, depth: WALL_OUTER - ad } : { nx: w.x, nz: w.z, depth: ad - WALL_OFF };
        }
      }
      if (wall) return wall;
    }
    // Stadium boundary, at the inner face of the 1 m perimeter wall.
    const e = this.extents();
    const x0 = e.x0 + 0.5, x1 = e.x1 - 0.5;
    const z0 = e.z0 + 0.5, z1 = e.z1 - 0.5;
    if (x < x0) return { nx: 1, nz: 0, depth: x0 - x };
    if (x > x1) return { nx: -1, nz: 0, depth: x - x1 };
    if (z < z0) return { nx: 0, nz: 1, depth: z0 - z };
    if (z > z1) return { nx: 0, nz: -1, depth: z - z1 };
    return null;
  }

  /** Signed lateral offset (m, positive right) of (x, z) from a block's centre line, beyond its ends too. */
  private centreOffset(blk: PlacedBlock, x: number, z: number): number {
    const l = blk.toLocal(x, z);
    // An unbounded margin never misses: a line keeps its lateral offset, an arc its radius (d = turn * (R - r)).
    return projectLocal(blk.def, l.a, l.b, Infinity)!.d;
  }

  /** Is (x, z) alongside the block, between its entry and exit? */
  private spans(blk: PlacedBlock, x: number, z: number): boolean {
    const l = blk.toLocal(x, z);
    return projectLocal(blk.def, l.a, l.b) !== null;
  }

  /** Is (x, z) over a road deck near height y (a car crossing from one block to the next)? */
  private onDeckAt(x: number, y: number, z: number): boolean {
    const list = this.blocksAt(x, z);
    if (!list) return false;
    for (const blk of list) {
      const l = blk.toLocal(x, z);
      const hit = projectLocal(blk.def, l.a, l.b);
      if (hit && Math.abs(hit.d) <= WALL_OFF && Math.abs(blk.baseY + hit.h - y) < 2) return true;
    }
    return false;
  }

  /** Spawn pose on the start block. */
  spawn(): { x: number; y: number; z: number; hx: number; hz: number } {
    const s = this.start;
    if (!s) return { x: 0, y: 1, z: 0, hx: 0, hz: -1 };
    const c = s.centerWorld(9);
    return { x: c.x, y: c.y, z: c.z, hx: c.hx, hz: c.hz };
  }

  /** Stadium extents in world metres. */
  extents(): { x0: number; z0: number; x1: number; z1: number } {
    const pad = STADIUM_PAD;
    return {
      x0: this.minI * CELL - pad,
      z0: this.minJ * CELL - pad,
      x1: this.maxI * CELL + pad,
      z1: this.maxJ * CELL + pad,
    };
  }
}

/**
 * Stretch of a block (distance along it) that keeps side barriers: where the deck is at least
 * BARRIER_MIN_Y above the floor, or all of it with walls on all roads (`all`, Track.walls). Heights are
 * monotonic along every block, so there is one crossing at most.
 */
export function barrierRange(blk: PlacedBlock, all = false): [number, number] | null {
  const L = blk.def.length;
  if (all) return [0, L];
  const high = (s: number) => blk.baseY + blk.def.height(s) >= BARRIER_MIN_Y;
  const a = high(0);
  const b = high(L);
  if (a && b) return [0, L];
  if (!a && !b) return null;
  let lo = 0, hi = L;
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    if (high(mid) === a) lo = mid;
    else hi = mid;
  }
  const sc = (lo + hi) / 2;
  return a ? [0, sc] : [sc, L];
}

function surfaceFromHit(blk: PlacedBlock, hit: LocalHit, sy: number): SurfaceHit {
  // Normal of y = h(s): (-h' * t, 1) normalised, with t the world tangent.
  const t = blk.dirToWorld(hit.ta, hit.tb);
  const nx = -hit.slope * t.x;
  const nz = -hit.slope * t.z;
  const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
  return { y: sy, nx: nx * inv, ny: inv, nz: nz * inv, grip: 1, road: true, block: blk };
}

/** Check that two placements do not share a cell on the same level. */
export function overlaps(a: Placement, b: Placement): boolean {
  const ca = cellsFor(a);
  const cb = cellsFor(b);
  return ca.some(([i, j, k]) => cb.some(([i2, j2, k2]) => i === i2 && j === j2 && k === k2));
}
