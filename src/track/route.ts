// Recovers the driving order of a track by chaining block exits to block entries,
// bridging jump gaps, and samples the centre line as a polyline.

import { CELL, DIR_X, DIR_Z } from '../core/constants';
import type { PlacedBlock, Track } from './track';

export interface RoutePoint {
  x: number;
  y: number;
  z: number;
  /** Heading (unit, x/z). */
  hx: number;
  hz: number;
  /** Cumulative distance from the start line. */
  s: number;
  /** Curvature (1/m), 0 on straights. */
  curv: number;
  /** True for interpolated points across a gap (no road). */
  air: boolean;
}

export interface Route {
  blocks: PlacedBlock[];
  points: RoutePoint[];
  length: number;
  /** True when the chain reaches a finish block. */
  complete: boolean;
}

const STEP = 2;

export function traceRoute(track: Track): Route {
  const order: PlacedBlock[] = [];
  const points: RoutePoint[] = [];
  const byAnchor = new Map<string, PlacedBlock>();
  for (const b of track.blocks) if (!b.def.water) byAnchor.set(`${b.p.i},${b.p.j},${b.p.k},${b.p.dir}`, b);

  let cur = track.start;
  let s = 0;
  let complete = false;
  const seen = new Set<PlacedBlock>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    const def = cur.def;
    const n = Math.max(2, Math.ceil(def.length / STEP));
    const startIdx = points.length;
    for (let q = points.length === 0 ? 0 : 1; q <= n; q++) {
      const ls = (def.length * q) / n;
      const c = cur.centerWorld(ls);
      points.push({
        x: c.x,
        y: c.y,
        z: c.z,
        hx: c.hx,
        hz: c.hz,
        s: s + ls,
        curv: def.path === 'arc' ? 1 / def.radius : 0,
        air: false,
      });
    }
    if (startIdx === points.length) break;
    s += def.length;
    if (def.gate === 'finish') {
      complete = true;
      break;
    }

    const nx = cur.nextAnchor();
    let next = byAnchor.get(`${nx.i},${nx.j},${nx.k},${nx.dir}`) ?? null;
    let gapCells = 0;
    if (!next) {
      // Jump gap: look further ahead along the heading, at the same or lower levels.
      search: for (let g = 1; g <= 8; g++) {
        for (const dk of [0, -1, -2, 1, -3]) {
          const cand = byAnchor.get(`${nx.i + DIR_X[nx.dir] * g},${nx.j + DIR_Z[nx.dir] * g},${nx.k + dk},${nx.dir}`);
          if (cand && !seen.has(cand)) {
            next = cand;
            gapCells = g;
            break search;
          }
        }
      }
    }
    if (!next) break;
    if (gapCells > 0) {
      const last = points[points.length - 1];
      const gapLen = gapCells * CELL;
      const m = Math.ceil(gapLen / STEP);
      for (let q = 1; q < m; q++) {
        const t = q / m;
        points.push({
          x: last.x + last.hx * gapLen * t,
          y: last.y + (next.baseY - last.y) * t,
          z: last.z + last.hz * gapLen * t,
          hx: last.hx,
          hz: last.hz,
          s: s + gapLen * t,
          curv: 0,
          air: true,
        });
      }
      s += gapLen;
    }
    cur = next;
  }
  return { blocks: order, points, length: s, complete };
}

/** Index of the route point closest to (x, z), searching near `hint` first. */
export function nearestPoint(route: Route, x: number, y: number, z: number, hint = -1): number {
  const pts = route.points;
  let best = 0;
  let bestD = Infinity;
  const from = hint >= 0 ? Math.max(0, hint - 20) : 0;
  const to = hint >= 0 ? Math.min(pts.length, hint + 60) : pts.length;
  for (let n = from; n < to; n++) {
    const p = pts[n];
    const dx = p.x - x, dy = (p.y - y) * 2, dz = p.z - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (hint >= 0 && bestD > 40 * 40) return nearestPoint(route, x, y, z, -1);
  return best;
}
