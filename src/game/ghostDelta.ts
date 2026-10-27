// Live time gap to a ghost: how far ahead (negative) or behind (positive) the player is, in ms, at the
// point of the road the player has reached. Each ghost sample is placed along the track's centre-line
// route once; during the race the player's own place along it is looked up every tick (a hinted, local
// nearest-point search) and compared with the time the ghost reached the same place.

import { TICK_HZ } from '../core/constants';
import { nearestPoint, type Route } from '../track/route';
import type { Ghost } from './ghost';
import type { MedalTimes } from './medals';
import type { ChaseTarget } from './storage';

const STRIDE = 8;

/** Route distance (m) at x, z near route point `i`: projected onto the segment before or after it, so it is continuous. */
export function routeS(route: Route, i: number, x: number, z: number): number {
  const pts = route.points;
  const p = pts[i];
  let best = p.s;
  let bestD = Infinity;
  for (const j of [i - 1, i]) {
    const a = pts[j], b = pts[j + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-9) continue;
    const k = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const ex = a.x + dx * k - x, ez = a.z + dz * k - z;
    const d = ex * ex + ez * ez;
    if (d < bestD) {
      bestD = d;
      best = a.s + (b.s - a.s) * k;
    }
  }
  return best;
}

export class GhostDelta {
  /** Route distance (m) reached by each ghost sample, never going back (a respawn or wobble cannot rewind it). */
  private readonly s: Float64Array;
  /** Race time (ms) of each sample. */
  private readonly t: Float64Array;

  constructor(
    readonly route: Route,
    readonly ghost: Ghost,
  ) {
    const n = Math.floor(ghost.samples.length / STRIDE);
    this.s = new Float64Array(n);
    this.t = new Float64Array(n);
    let hint = -1;
    let best = 0;
    const pts = route.points;
    for (let i = 0; i < n; i++) {
      const g = ghost.samples;
      hint = nearestPoint(route, g[i * STRIDE], g[i * STRIDE + 1], g[i * STRIDE + 2], hint);
      if (pts[hint]) best = Math.max(best, routeS(route, hint, g[i * STRIDE], g[i * STRIDE + 2]));
      this.s[i] = best;
      this.t[i] = ((i * ghost.interval) / TICK_HZ) * 1000;
    }
  }

  /** The time (ms) the ghost reached route distance `s`, interpolated; its finish time past its last sample. */
  timeAt(s: number): number {
    const S = this.s, T = this.t;
    const n = S.length;
    if (n === 0) return 0;
    if (s <= S[0]) return T[0];
    if (s >= S[n - 1]) return this.ghost.time;
    // First sample at or past s.
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (S[m] < s) lo = m + 1;
      else hi = m;
    }
    const s0 = S[lo - 1], s1 = S[lo];
    const k = s1 > s0 ? (s - s0) / (s1 - s0) : 1;
    return T[lo - 1] + (T[lo] - T[lo - 1]) * k;
  }
}

/**
 * The player's place along a route, followed tick by tick: the furthest route distance reached so far
 * (from a hinted nearest-point search), so a slide or a respawn never shows a sudden gain.
 */
export class RouteProgress {
  private hint = -1;
  s = 0;

  constructor(readonly route: Route) {}

  reset(): void {
    this.hint = -1;
    this.s = 0;
  }

  update(x: number, y: number, z: number): number {
    if (!this.route.points.length) return 0;
    this.hint = nearestPoint(this.route, x, y, z, this.hint);
    const s = routeS(this.route, this.hint, x, z);
    // A plausible step only (about 4 m a tick is 1440 km/h): a jump to another deck of the route is ignored.
    if (s > this.s && s - this.s < 60) this.s = s;
    return this.s;
  }
}

/** "+1.23" / "-0.45" with a true minus sign; tenths of a second are not enough to race against. */
export function formatDelta(ms: number): string {
  const v = Math.abs(ms) / 1000;
  return `${ms < 0 ? '−' : '+'}${v.toFixed(2)}`;
}

/**
 * The ghost "auto" chases: Gold until gold is won, then the Author, then the personal best once the author
 * time is beaten (the next goal, always).
 */
export function autoChase(best: number | null, m: MedalTimes | null): Exclude<ChaseTarget, 'auto'> {
  if (!m) return 'pb';
  if (best !== null && best <= m.author) return 'pb';
  if (best !== null && best <= m.gold) return 'author';
  return 'gold';
}
