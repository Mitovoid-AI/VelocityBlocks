// World and simulation constants shared by physics, track geometry and rendering.

/** Horizontal size of one track block cell, in metres. */
export const CELL = 32;
/** Vertical distance between two block levels, in metres. */
export const LEVEL_H = 8;
/** Half the drivable road width, in metres. */
export const ROAD_HALF = 10;
/** Lateral distance of the barrier face from the road centre line. */
export const WALL_OFF = 10.6;
/** Barrier height above the road surface. */
export const WALL_H = 1.4;
/** Outer edge of the deck slab (barrier outer face, gate posts), in metres from the centre line. */
export const DECK_EDGE = WALL_OFF + 0.5;
/** Decks at least this high above the stadium floor keep their side barriers; lower ones open onto the grass. */
export const BARRIER_MIN_Y = 4;
/** Deck slab thickness under the road surface. */
export const DECK_T = 0.8;
/** Editor grid size in cells (both axes). */
export const GRID = 32;
/** Highest level a block may be placed on. */
export const MAX_LEVEL = 7;
/** Stadium padding around the track footprint, in metres. */
export const STADIUM_PAD = 3 * CELL;

/** Fixed simulation rate. Physics always advances in steps of DT. */
export const TICK_HZ = 100;
export const DT = 1 / TICK_HZ;

export const GRAVITY = 12;
/** Hard speed cap (1000 km/h). */
export const MAX_SPEED = 1000 / 3.6;

/** Bump this whenever physics tuning changes so cached ghosts and author times are invalidated. */
export const PHYSICS_VERSION = 6;

/** Grid headings: 0 = north (-z), 1 = east (+x), 2 = south (+z), 3 = west (-x). Turning right adds 1. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_X = [0, 1, 0, -1] as const;
export const DIR_Z = [-1, 0, 1, 0] as const;

export function wrapDir(d: number): Dir {
  return (((d % 4) + 4) % 4) as Dir;
}
