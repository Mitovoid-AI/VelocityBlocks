// Block catalogue. Every block is described in a canonical local frame:
//   b = distance forward from the block's entry edge (along the entry heading)
//   a = lateral offset, positive to the driver's right
//   h = height above the block's base level
// The entry point (a = 0, b = 0) is the midpoint of the entry edge of the anchor cell.

import { CELL, LEVEL_H, WALL_OFF } from '../core/constants';
import { smoothstep } from '../core/vec';

export type BlockType =
  | 'start'
  | 'finish'
  | 'checkpoint'
  | 'straight'
  | 'boost'
  | 'turbo'
  | 'curveR'
  | 'curveL'
  | 'bigCurveR'
  | 'bigCurveL'
  | 'slopeUp'
  | 'slopeDown'
  | 'ramp';

export type GateKind = 'start' | 'checkpoint' | 'finish';
export type PadKind = 'boost' | 'turbo';

export interface BlockDef {
  type: BlockType;
  label: string;
  /** Short code used by the track text format. */
  code: string;
  /** Occupied cells as [lateral, forward, levelOffset] relative to the anchor cell. */
  cells: ReadonlyArray<readonly [number, number, number]>;
  path: 'line' | 'arc';
  /** Arc radius (metres) for arc paths. */
  radius: number;
  /** -1 left, 0 straight, +1 right. */
  turn: -1 | 0 | 1;
  /** Centre line length in metres. */
  length: number;
  /** Where the next block's anchor cell is, relative to this anchor (before the heading change). */
  next: { lat: number; fwd: number; dk: number };
  gate?: GateKind;
  pad?: PadKind;
  /** Height profile along the centre line. */
  height: (s: number) => number;
  /** dh/ds along the centre line. */
  slope: (s: number) => number;
}

const flat = () => 0;

const RAMP_START = 8;
/** Slopes climb one level over two cells. */
const SLOPE_LEN = CELL * 2;
const RAMP_H = 1.6;

function lineBlock(
  type: BlockType,
  label: string,
  code: string,
  extra: Partial<BlockDef> = {},
): BlockDef {
  return {
    type,
    label,
    code,
    cells: [[0, 0, 0]],
    path: 'line',
    radius: 0,
    turn: 0,
    length: CELL,
    next: { lat: 0, fwd: 1, dk: 0 },
    height: flat,
    slope: flat,
    ...extra,
  };
}

function arcBlock(type: BlockType, label: string, code: string, turn: 1 | -1, big: boolean): BlockDef {
  const radius = big ? CELL * 1.5 : CELL / 2;
  const cells: [number, number, number][] = big
    ? [
        [0, 0, 0],
        [turn, 0, 0],
        [0, 1, 0],
        [turn, 1, 0],
      ]
    : [[0, 0, 0]];
  return {
    type,
    label,
    code,
    cells,
    path: 'arc',
    radius,
    turn,
    length: (Math.PI / 2) * radius,
    next: big ? { lat: 2 * turn, fwd: 1, dk: 0 } : { lat: turn, fwd: 0, dk: 0 },
    height: flat,
    slope: flat,
  };
}

export const BLOCKS: Record<BlockType, BlockDef> = {
  start: lineBlock('start', 'Start', 'St', { gate: 'start' }),
  finish: lineBlock('finish', 'Finish', 'F', { gate: 'finish' }),
  checkpoint: lineBlock('checkpoint', 'Checkpoint', 'C', { gate: 'checkpoint' }),
  straight: lineBlock('straight', 'Straight', 'S'),
  boost: lineBlock('boost', 'Boost pad', 'B', { pad: 'boost' }),
  turbo: lineBlock('turbo', 'Turbo pad', 'T', { pad: 'turbo' }),
  curveR: arcBlock('curveR', 'Curve right', 'R', 1, false),
  curveL: arcBlock('curveL', 'Curve left', 'L', -1, false),
  bigCurveR: arcBlock('bigCurveR', 'Wide curve right', 'R2', 1, true),
  bigCurveL: arcBlock('bigCurveL', 'Wide curve left', 'L2', -1, true),
  slopeUp: lineBlock('slopeUp', 'Slope up', 'U', {
    cells: [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 1],
    ],
    length: SLOPE_LEN,
    next: { lat: 0, fwd: 2, dk: 1 },
    height: (s) => LEVEL_H * smoothstep(clamp01(s / SLOPE_LEN)),
    slope: (s) => {
      const t = clamp01(s / SLOPE_LEN);
      return (LEVEL_H * 6 * t * (1 - t)) / SLOPE_LEN;
    },
  }),
  slopeDown: lineBlock('slopeDown', 'Slope down', 'D', {
    cells: [
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 1, -1],
    ],
    length: SLOPE_LEN,
    next: { lat: 0, fwd: 2, dk: -1 },
    height: (s) => -LEVEL_H * smoothstep(clamp01(s / SLOPE_LEN)),
    slope: (s) => {
      const t = clamp01(s / SLOPE_LEN);
      return (-LEVEL_H * 6 * t * (1 - t)) / SLOPE_LEN;
    },
  }),
  ramp: lineBlock('ramp', 'Jump ramp', 'J', {
    height: (s) => {
      if (s <= RAMP_START) return 0;
      const t = Math.min(1, (s - RAMP_START) / (CELL - RAMP_START));
      return RAMP_H * t * t;
    },
    slope: (s) => {
      if (s <= RAMP_START) return 0;
      const t = Math.min(1, (s - RAMP_START) / (CELL - RAMP_START));
      return (2 * RAMP_H * t) / (CELL - RAMP_START);
    },
  }),
};

export const BLOCK_LIST: BlockDef[] = Object.values(BLOCKS);

export const BLOCK_BY_CODE: Record<string, BlockDef> = Object.fromEntries(BLOCK_LIST.map((b) => [b.code, b]));

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Result of projecting a local (a, b) point onto a block's centre line. */
export interface LocalHit {
  /** Distance along the centre line. */
  s: number;
  /** Signed lateral offset, positive right. */
  d: number;
  /** Surface height above block base. */
  h: number;
  /** Unit tangent in local (a, b). */
  ta: number;
  tb: number;
  /** dh/ds at s. */
  slope: number;
}

/**
 * Project a local point onto the block centre line. Returns null when the point
 * lies before the entry or after the exit (with `margin` metres of tolerance).
 */
export function projectLocal(def: BlockDef, a: number, b: number, margin = 0): LocalHit | null {
  if (def.path === 'line') {
    if (b < -margin || b > def.length + margin) return null;
    const s = b < 0 ? 0 : b > def.length ? def.length : b;
    return { s, d: a, h: def.height(s), ta: 0, tb: 1, slope: def.slope(s) };
  }
  const R = def.radius;
  const sign = def.turn;
  const ra = a - sign * R;
  const rb = b;
  const r = Math.sqrt(ra * ra + rb * rb);
  // Angle travelled from the entry, 0..PI/2 inside the block.
  const phi = Math.atan2(rb, -sign * ra);
  const mAng = margin / R;
  if (phi < -mAng || phi > Math.PI / 2 + mAng) return null;
  const p = phi < 0 ? 0 : phi > Math.PI / 2 ? Math.PI / 2 : phi;
  return {
    s: p * R,
    d: sign * (R - r),
    h: 0,
    ta: sign * Math.sin(p),
    tb: Math.cos(p),
    slope: 0,
  };
}

/** Is the local point inside the block's drivable deck (up to the barrier)? */
export function onDeck(hit: LocalHit): boolean {
  return Math.abs(hit.d) <= WALL_OFF + 0.3;
}

/** Local (a, b) coordinate of the centre line at distance s. */
export function centerAt(def: BlockDef, s: number): { a: number; b: number; ta: number; tb: number } {
  if (def.path === 'line') return { a: 0, b: s, ta: 0, tb: 1 };
  const R = def.radius;
  const sign = def.turn;
  const p = s / R;
  return {
    a: sign * R - sign * R * Math.cos(p),
    b: R * Math.sin(p),
    ta: sign * Math.sin(p),
    tb: Math.cos(p),
  };
}
