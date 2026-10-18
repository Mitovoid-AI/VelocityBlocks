// Autopilot used to validate tracks (every campaign track must be finishable) and to
// derive author medal times. Pure pursuit steering with a curvature-based speed plan.

import { GRAVITY } from '../core/constants';
import { clamp, vdot } from '../core/vec';
import { forwardOf, speedOf, type Controls } from '../physics/vehicle';
import type { Track } from '../track/track';
import { nearestPoint, traceRoute, type Route } from '../track/route';
import { RaceSession } from './race';

const LAT_ACCEL = 2.1 * GRAVITY * 0.78;
const BRAKE_DECEL = 13;

export class Autopilot {
  readonly route: Route;
  private readonly vTarget: Float64Array;
  private idx = -1;

  constructor(track: Track) {
    this.route = traceRoute(track);
    const pts = this.route.points;
    const v = new Float64Array(pts.length);
    for (let n = 0; n < pts.length; n++) {
      // Corner speed with some line-cutting allowance on tight curves. Low-level roads have no
      // barriers to lean on, so the allowance stays small enough to hold the road unaided.
      const k = pts[n].curv;
      v[n] = k > 0 ? Math.sqrt(LAT_ACCEL / k) * (k > 0.05 ? 1.3 : 1.15) : 200;
    }
    // Crests: keep the wheels on the road where the deck curves away.
    for (let n = 1; n < pts.length - 1; n++) {
      const ds = (pts[n + 1].s - pts[n - 1].s) / 2;
      if (ds <= 0 || pts[n].air || pts[n + 1].air || pts[n - 1].air) continue;
      const ypp = (pts[n + 1].y - 2 * pts[n].y + pts[n - 1].y) / (ds * ds);
      if (ypp < -1e-4) v[n] = Math.min(v[n], Math.sqrt(36 / -ypp));
    }
    // Backward pass: be able to brake down to every later limit.
    for (let n = pts.length - 2; n >= 0; n--) {
      const ds = pts[n + 1].s - pts[n].s;
      v[n] = Math.min(v[n], Math.sqrt(v[n + 1] * v[n + 1] + 2 * BRAKE_DECEL * ds));
    }
    this.vTarget = v;
  }

  private slowTicks = 0;
  private lastSteer = 0;
  private reverseTicks = 0;

  controls(race: RaceSession): Controls {
    const car = race.car;
    // Unstick: back away from a barrier when pinned against it.
    if (this.reverseTicks > 0) {
      this.reverseTicks--;
      return { steer: -this.lastSteer, gas: 0, brake: 1 };
    }
    if (speedOf(car) < 1.5) this.slowTicks++;
    else this.slowTicks = 0;
    if (this.slowTicks > 120) {
      this.slowTicks = 0;
      this.reverseTicks = 110;
    }
    const pts = this.route.points;
    if (pts.length < 2) return { steer: 0, gas: 1, brake: 0 };
    this.idx = nearestPoint(this.route, car.pos.x, car.pos.y, car.pos.z, this.idx);
    const speed = speedOf(car);
    const look = 7 + speed * 0.32;
    const sNow = pts[this.idx].s;
    let t = this.idx;
    while (t < pts.length - 1 && pts[t].s - sNow < look) t++;
    const tp = pts[t];
    const fwd = forwardOf(car);
    const dx = tp.x - car.pos.x;
    const dz = tp.z - car.pos.z;
    // Signed angle from the car heading to the target (positive = target to the right).
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fl, fz = fwd.z / fl;
    // Viewed from above (x right, z down) a positive cross product means the target is to the right.
    const cross = fx * dz - fz * dx;
    const dot = fx * dx + fz * dz;
    const alpha = Math.atan2(cross, dot);
    const dist = Math.hypot(dx, dz) || 1;
    const curvature = (2 * Math.sin(alpha)) / dist;
    const delta = Math.atan(2.8 * curvature);
    const maxSteer = 0.52 / (1 + Math.abs(vdot(car.vel, fwd)) / 22);
    const steer = clamp(delta / maxSteer, -1, 1);
    this.lastSteer = steer;

    // Speed planning a little ahead (reaction margin).
    let ahead = this.idx;
    while (ahead < pts.length - 1 && pts[ahead].s - sNow < 6 + speed * 0.12) ahead++;
    const vt = this.vTarget[ahead];
    // Slow corners brake on any overspeed: running wide there means leaving the road.
    const brake = speed > vt + (vt < 30 ? 0 : 3) ? 1 : 0;
    const gas = brake ? 0 : speed > vt ? 0.3 : 1;
    return { steer, gas, brake };
  }
}

export interface BotResult {
  finished: boolean;
  time: number | null;
  respawns: number;
  /**
   * Automatic flip respawns from RaceSession.step. Ones before the first checkpoint restart the run
   * and reset race.respawns, so only this field sees them.
   */
  autoRespawns: number;
  ticks: number;
}

/** Drive a track with the autopilot (headless). */
export function runBot(track: Track, maxSeconds = 240): BotResult {
  const race = new RaceSession(track);
  const bot = new Autopilot(track);
  const maxTicks = maxSeconds * 100;
  let stuck = 0;
  let autoRespawns = 0;
  let lastCheck = { x: race.car.pos.x, z: race.car.pos.z };
  for (let n = 0; n < maxTicks; n++) {
    if (race.phase === 'finished') break;
    const ctl = race.phase === 'racing' ? bot.controls(race) : { steer: 0, gas: 0, brake: 0 };
    for (const e of race.step(ctl)) if (e.type === 'respawn' && e.auto) autoRespawns++;
    if (race.phase === 'racing' && n % 100 === 0) {
      const moved = Math.hypot(race.car.pos.x - lastCheck.x, race.car.pos.z - lastCheck.z);
      lastCheck = { x: race.car.pos.x, z: race.car.pos.z };
      stuck = moved < 2 ? stuck + 1 : 0;
      const near = bot.route.points[nearestPoint(bot.route, race.car.pos.x, race.car.pos.y, race.car.pos.z)];
      const fell = race.car.onGrass && near && near.y - race.car.pos.y > 3;
      if (stuck >= 2 || race.car.pos.y < -10 || fell) {
        race.respawn();
        stuck = 0;
      }
    }
  }
  return {
    finished: race.phase === 'finished',
    time: race.finishTime,
    respawns: race.respawns,
    autoRespawns,
    ticks: race.ticks,
  };
}
