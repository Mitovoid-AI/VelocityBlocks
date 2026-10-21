// World and simulation constants shared by physics, track geometry and rendering.

import type { VehicleClass } from './vehicles';

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

/**
 * Water (the Water set's lakes and rivers, track.ts): a water cell has no ground. Its bed lies WATER_BED below
 * the floor, the surface is drawn WATER_SURFACE_Y above it (flush with the lawn, so no hole is cut in it), and
 * a car whose centre sinks below WATER_SINK_Y over water has fallen in (race.ts: an automatic respawn).
 */
export const WATER_BED = -4;
export const WATER_SURFACE_Y = 0.04;
export const WATER_SINK_Y = -0.35;

/** Fixed simulation rate. Physics always advances in steps of DT. */
export const TICK_HZ = 100;
export const DT = 1 / TICK_HZ;

export const GRAVITY = 12;
/** Hard speed cap (1000 km/h). */
export const MAX_SPEED = 1000 / 3.6;

/**
 * Bump this whenever physics tuning changes so cached ghosts and author times are invalidated. v7: the
 * nitro. The car without it is v6 bit for bit (tests/carGolden.test.ts), but the author times are nitro
 * laps now (A01 13.90 -> 12.86 s), so v6 records would lose their Author medals and v6 custom-track author
 * times (set without nitro) would be too easy. Campaign unlocks survive a bump ('finished' in storage).
 */
export const PHYSICS_VERSION = 7;

/**
 * Per-class tuning revision on top of PHYSICS_VERSION: bump one class's number when only that class's
 * VehicleSpec changes, so only its records, ghosts and author times reset. The car stays 0 (its keys,
 * ghosts and tables carry no revision); PHYSICS_VERSION is for changes every class shares.
 */
export const VEHICLE_REV: Readonly<Record<VehicleClass, number>> = Object.freeze({ car: 0, bike: 1, truck: 1 });

/** Grid headings: 0 = north (-z), 1 = east (+x), 2 = south (+z), 3 = west (-x). Turning right adds 1. */
export type Dir = 0 | 1 | 2 | 3;
export const DIR_X = [0, 1, 0, -1] as const;
export const DIR_Z = [-1, 0, 1, 0] as const;

export function wrapDir(d: number): Dir {
  return (((d % 4) + 4) % 4) as Dir;
}
