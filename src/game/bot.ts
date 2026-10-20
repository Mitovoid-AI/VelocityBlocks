// Autopilot used to validate tracks (every campaign track must be finishable) and to
// derive author medal times (one per vehicle class). Pure pursuit steering with a curvature-based
// speed plan, and the nitro where a whole push fits that plan (nitroFits). It drives the same with
// walls on all roads (the barriers only matter off its line), so author times and medal thresholds
// are shared by both wall modes.

import { GRAVITY } from '../core/constants';
import type { VehicleClass } from '../core/vehicles';
import { clamp, vdot } from '../core/vec';
import {
  cornerSpeedAt,
  DEFAULT_ASSISTS,
  forwardOf,
  maxSteerAngle,
  nitroDeltaV,
  nitroReady,
  NITRO_TIME,
  speedOf,
  vehicleSpec,
  type Assists,
  type CarState,
  type Controls,
  type VehicleSpec,
} from '../physics/vehicle';
import type { Track } from '../track/track';
import { nearestPoint, traceRoute, type Route } from '../track/route';
import { RaceSession } from './race';

/**
 * Corner speed plan per class. The car keeps its physics v6 rule (a share of its grip; its author times
 * depend on every digit). The others plan with a share (`use`) of their measured cornering limit
 * (maxLatAccel), which also covers the lock-limited hairpins a fixed share of grip overshoots.
 * `brake` is the deceleration (m/s^2) the plan brakes at; `look` the pursuit lookahead (m) at rest and
 * per m/s of speed. With `span` the speed target is the lowest one up to the reaction point, not the one
 * at it, so a short limit (a crest where the road falls away) is never stepped over; the car's downforce
 * holds it on crests the others must slow for. `crest` is the vertical acceleration (m/s^2) a crest is
 * taken at, at most: v^2 times the deck's downward curvature.
 */
interface BotPlan {
  readonly lat?: number;
  readonly use?: number;
  readonly brake: number;
  readonly look: readonly [number, number];
  readonly span: boolean;
  readonly crest: number;
}
const PLANS: Record<VehicleClass, BotPlan> = {
  car: { lat: 2.1 * GRAVITY * 0.78, brake: 13, look: [7, 0.32], span: false, crest: 36 },
  bike: { use: 0.68, brake: 11, look: [7, 0.32], span: true, crest: 36 },
  truck: { use: 0.72, brake: 12, look: [7, 0.32], span: true, crest: 25 },
};

/**
 * When the autopilot and the pace pilot fire the nitro (nitroFits): the most steering the car may have, how
 * square to the road it must point (cosine of the heading error), the seconds at the push's end speed the
 * speed plan must still allow after the push (its braking pass then keeps the car able to brake for what
 * follows), and how far (m) the road may rise or fall within that reach. The margins are for phone players
 * pressing where the autopilot does: a nitro that ends near a braking point, a slope or a crest makes them
 * arrive there faster, where on/off steering sets off brake-tap drifts and slides (a 1 s margin and no slope
 * check spun the car out on A10 every time). With these, a button driver copying it is about as clean as
 * without the nitro over 30 start delays per track and traction setting: car 719/720 laps (720 without),
 * bike 696 (700), truck 714 (714); see scripts/class-tune.ts sweep.
 */
export const NITRO_RULE = { steer: 0.25, align: 0.97, coast: 3, flat: 1 } as const;

/** Speed a whole nitro push adds on the flat (m/s). */
const NITRO_DV = nitroDeltaV();

/**
 * Whether a nitro fired now at route point `idx` fits the speed plan `vTarget` (NITRO_RULE): all wheels on
 * the road, nearly straight, no drift, pointing down the road, and within the push's reach plus
 * NITRO_RULE.coast seconds at its end speed no jump gap, no slope or crest, and nothing the plan wants
 * slower than that end speed. Greedy: the drivers fire at the first such point (at GO on most tracks).
 * The end speed and reach count the nitro's own push only, not the engine's pull during it: from low speed
 * (GO, a hairpin exit) the car ends the push near twice as fast as `vEnd` and covers more road. That is
 * deliberate: the bound is a lookahead for slopes, gaps and slow plan points, and the drivers still brake
 * on their own plan; the margin for button players who copy the rule is measured, not derived
 * (scripts/class-tune.ts sweep, tests/campaignNitro.test.ts).
 */
export function nitroFits(route: Route, vTarget: ArrayLike<number>, idx: number, speed: number, car: CarState): boolean {
  if (car.grounded < 4 || car.onGrass || car.drift > 0.05 || Math.abs(car.steer) > NITRO_RULE.steer) return false;
  const pts = route.points;
  if (idx < 0 || idx >= pts.length) return false;
  // Pointing down the road (a car turning out of a spin can have its wheels straight).
  const f = forwardOf(car);
  const fl = Math.hypot(f.x, f.z);
  if (fl < 0.5 || (f.x * pts[idx].hx + f.z * pts[idx].hz) / fl < NITRO_RULE.align) return false;
  const vEnd = speed + NITRO_DV;
  const reach = (speed + NITRO_DV / 2) * NITRO_TIME + 10 + vEnd * NITRO_RULE.coast;
  const s0 = pts[idx].s, y0 = pts[idx].y;
  for (let n = idx; n < pts.length && pts[n].s - s0 <= reach; n++) {
    const p = pts[n];
    if (p.air || vTarget[n] < vEnd || Math.abs(p.y - y0) > NITRO_RULE.flat) return false;
  }
  return true;
}

export class Autopilot {
  readonly route: Route;
  readonly spec: VehicleSpec;
  private readonly plan: BotPlan;
  private readonly vTarget: Float64Array;
  private idx = -1;

  constructor(track: Track, vehicle: VehicleClass = 'car') {
    this.spec = vehicleSpec(vehicle);
    const plan = (this.plan = PLANS[this.spec.vehicle]);
    this.route = traceRoute(track);
    const pts = this.route.points;
    const v = new Float64Array(pts.length);
    for (let n = 0; n < pts.length; n++) {
      // Corner speed with some line-cutting allowance. Low-level roads have no barriers to lean on, so
      // the allowance stays small enough to hold the road unaided. Tight curves get less: the
      // slip-angle tyres (physics v6) push wide when a hairpin or a flick leaves no line to cut.
      const k = pts[n].curv;
      // For the Bike and the Truck the allowance lifts the plan past `use`: on gentle curves the truck plans at
      // about 0.72 x 1.15^2 = 0.95 of its limit, a little over the racing line's LAT_USE (0.9). Kept on
      // purpose: its laps pass every gate, and a lower plan would push its A05 author lap past the band over
      // its racing line (GATES.authorVsLine).
      const vk = plan.lat !== undefined ? Math.sqrt(plan.lat / k) : cornerSpeedAt(k, plan.use!, this.spec);
      v[n] = k > 0 ? vk * (k > 0.05 ? 1.1 : 1.15) : 200;
    }
    // Crests: keep the wheels on the road where the deck curves away.
    for (let n = 1; n < pts.length - 1; n++) {
      const ds = (pts[n + 1].s - pts[n - 1].s) / 2;
      if (ds <= 0 || pts[n].air || pts[n + 1].air || pts[n - 1].air) continue;
      const ypp = (pts[n + 1].y - 2 * pts[n].y + pts[n - 1].y) / (ds * ds);
      if (ypp < -1e-4) v[n] = Math.min(v[n], Math.sqrt(plan.crest / -ypp));
    }
    // Backward pass: be able to brake down to every later limit.
    for (let n = pts.length - 2; n >= 0; n--) {
      const ds = pts[n + 1].s - pts[n].s;
      v[n] = Math.min(v[n], Math.sqrt(v[n + 1] * v[n + 1] + 2 * plan.brake * ds));
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
    const look = this.plan.look[0] + speed * this.plan.look[1];
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
    const delta = Math.atan(this.spec.wheelbase * curvature);
    const maxSteer = maxSteerAngle(vdot(car.vel, fwd), this.spec);
    // Target behind (after a spin): full lock towards it. Pursuit steers by sin(alpha), which fades to
    // nothing as the target goes behind and leaves a spun car circling.
    const steer = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) : clamp(delta / maxSteer, -1, 1);
    this.lastSteer = steer;

    // Speed planning a little ahead (reaction margin).
    let ahead = this.idx;
    while (ahead < pts.length - 1 && pts[ahead].s - sNow < 6 + speed * 0.12) ahead++;
    let vt = this.vTarget[ahead];
    if (this.plan.span) for (let n = this.idx; n < ahead; n++) vt = Math.min(vt, this.vTarget[n]);
    // Slow corners brake on any overspeed: running wide there means leaving the road.
    const brake = speed > vt + (vt < 30 ? 0 : 3) ? 1 : 0;
    const gas = brake ? 0 : speed > vt ? 0.3 : 1;
    if (gas === 1 && nitroReady(car) && nitroFits(this.route, this.vTarget, this.idx, speed, car)) {
      return { steer, gas, brake, nitro: true };
    }
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
  /** Every respawn, the automatic ones and runBot's own when stuck or fallen (before the first checkpoint too). */
  allRespawns: number;
  ticks: number;
  /** Largest horizontal distance (m) of the car from the route's centre line while racing. */
  maxOff: number;
  /** Largest angle (deg) between the car's heading and the route's while racing: over 90 is a spin. */
  maxYawErr: number;
  /** Nitros fired (respawns included). */
  nitros: number;
}

/** Optional run settings; author times, attract mode and editor validation use the defaults. */
export interface BotOptions {
  /** Driver aids (default: normal traction control). */
  assists?: Readonly<Assists>;
  /** Vehicle class to drive (default car). */
  vehicle?: VehicleClass;
  /** Reshapes the autopilot's controls, e.g. into a phone player's on/off buttons. */
  filter?: (ctl: Controls) => Controls;
}

/** Drive a track with the autopilot (headless). */
export function runBot(track: Track, maxSeconds = 240, opts: BotOptions = {}): BotResult {
  const vehicle = opts.vehicle ?? 'car';
  const race = new RaceSession(track, opts.assists ?? DEFAULT_ASSISTS, vehicle);
  const bot = new Autopilot(track, vehicle);
  const maxTicks = maxSeconds * 100;
  let stuck = 0;
  let autoRespawns = 0;
  let allRespawns = 0;
  let maxOff = 0;
  let maxYawErr = 0;
  let nitros = 0;
  let hint = -1;
  let lastCheck = { x: race.car.pos.x, z: race.car.pos.z };
  const pts = bot.route.points;
  for (let n = 0; n < maxTicks; n++) {
    if (race.phase === 'finished') break;
    let ctl: Controls = { steer: 0, gas: 0, brake: 0 };
    if (race.phase === 'racing') ctl = opts.filter ? opts.filter(bot.controls(race)) : bot.controls(race);
    for (const e of race.step(ctl)) {
      if (e.type === 'nitro') nitros++;
      if (e.type !== 'respawn') continue;
      allRespawns++;
      if (e.auto) autoRespawns++;
    }
    if (race.phase === 'racing' && pts.length) {
      const c = race.car;
      hint = nearestPoint(bot.route, c.pos.x, c.pos.y, c.pos.z, hint);
      const p = pts[hint];
      maxOff = Math.max(maxOff, Math.hypot(c.pos.x - p.x, c.pos.z - p.z));
      const f = forwardOf(c);
      const fl = Math.hypot(f.x, f.z);
      if (fl > 0.3) {
        const cos = clamp((f.x * p.hx + f.z * p.hz) / fl, -1, 1);
        maxYawErr = Math.max(maxYawErr, (Math.acos(cos) * 180) / Math.PI);
      }
    }
    if (race.phase === 'racing' && n % 100 === 0) {
      const moved = Math.hypot(race.car.pos.x - lastCheck.x, race.car.pos.z - lastCheck.z);
      lastCheck = { x: race.car.pos.x, z: race.car.pos.z };
      stuck = moved < 2 ? stuck + 1 : 0;
      const near = bot.route.points[nearestPoint(bot.route, race.car.pos.x, race.car.pos.y, race.car.pos.z)];
      const fell = race.car.onGrass && near && near.y - race.car.pos.y > 3;
      if (stuck >= 2 || race.car.pos.y < -10 || fell) {
        allRespawns += race.respawn().length;
        stuck = 0;
      }
    }
  }
  return {
    finished: race.phase === 'finished',
    time: race.finishTime,
    respawns: race.respawns,
    autoRespawns,
    allRespawns,
    ticks: race.ticks,
    maxOff,
    maxYawErr,
    nitros,
  };
}
