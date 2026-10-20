// Custom-track author times, one per vehicle class, set by the creator's own test drives. The
// car's is TrackData.authorTime; the Bike's and Truck's are TrackData.authorTimes, tagged with the
// class revision (track.ts authorTimeFor / withAuthorTime), so a retune retires them.

import type { VehicleClass } from '../core/vehicles';
import { authorTimeFor, withAuthorTime, type TrackData } from '../track/track';

/** What a walls-on test drive's results say: "Walls on all roads" can make a route faster than the track as built. */
export const AUTHOR_WALLS_NOTE = 'Author time is set with walls off';

/** A custom track's author time for a vehicle class (this revision), or null when none is set. */
export function customAuthorTime(data: TrackData, vehicle: VehicleClass): number | null {
  const t = authorTimeFor(data, vehicle);
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

/** The track with a class's author time set (the other classes' kept). */
export function withCustomAuthorTime(data: TrackData, vehicle: VehicleClass, time: number): TrackData {
  return withAuthorTime(data, vehicle, time);
}

/** The track with every class's author time cleared: a block edit makes it a different track. */
export function withoutAuthorTimes(data: TrackData): TrackData {
  return { ...data, authorTime: undefined, authorTimes: undefined };
}

/**
 * The author time a finished editor test drive leaves: the first finish sets it and a faster one
 * lowers it, but only with walls off (a walls-on drive can lean on barriers the track as built does
 * not have). Null when it stays as it was.
 */
export function authorTimeAfter(current: number | null, time: number, walls: boolean): number | null {
  if (walls) return null;
  return current === null || time < current ? time : null;
}
