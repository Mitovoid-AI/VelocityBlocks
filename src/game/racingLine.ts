// Racing-line assist data: a minimum-curvature line inside the road (outside, apex, outside), driven by
// a pace pilot that plans its speed from the physics' own grip and brake limits, sampled every metre
// of centre line and coloured from the measured speed profile: green throttle, yellow lift, red brake.
// Campaign lines are precomputed (scripts/racing-lines.ts writes src/track/racingLines.json for this
// PHYSICS_VERSION); other tracks run the same job time-sliced on the main thread through LineJobs.
// Pure TypeScript with no rendering (render/racingLine.ts draws it).

import { DT, PHYSICS_VERSION, ROAD_HALF } from '../core/constants';
import { clamp, vdot } from '../core/vec';
import {
  DRIFT_STEER,
  forwardOf,
  maxBrakeDecel,
  maxLatAccel,
  maxSteerAngle,
  NO_CONTROLS,
  speedOf,
  type Controls,
} from '../physics/vehicle';
import { nearestPoint, traceRoute, type Route, type RoutePoint } from '../track/route';
import type { Track } from '../track/track';
import racingLines from '../track/racingLines.json';
import { quantise, RaceSession } from './race';

// ---- Line shape -------------------------------------------------------------

/** Sample spacing along the centre line, in metres. */
export const LINE_STEP = 1;
/** Widest offset from the centre line: 2 m inside the road edge leaves room for the car and tracking error. */
export const LINE_HALF_WIDTH = ROAD_HALF - 2;
/** Offset limit over boost and turbo pads, which only fire within 7.5 m of the centre (race.ts checkPads). */
export const PAD_HALF_WIDTH = 5;
/** The line keeps to the centre up to here (the car spawns at 9 m). */
const PIN_START = 12;
/** Route points (about 2 m apart) on each side of a pinned point that are pinned too. */
const PIN_GROW = 3;

// ---- Pace pilot tuning ------------------------------------------------------

/** Share of the cornering limit (maxLatAccel) the pace pilot plans with. */
export const LAT_USE = 0.9;
/** Share of the full-brake deceleration (maxBrakeDecel) the speed plan brakes at. */
export const BRAKE_USE = 0.85;
/** Overspeed (m/s) that asks for the full brake pedal; less brakes in proportion. */
const BRAKE_GAIN = 4;
/** Overspeed (m/s) held with a light throttle before the brakes come in. */
const HOLD_BAND = 1;
/** The pilot releases the brakes at this steering (input or car), short of the drift range. */
const BRAKE_STEER = DRIFT_STEER - 0.02;
/** Speed target where nothing limits it. */
const V_FREE = 200;
/** A pace drive gives up when it has not moved along the route for this long (ticks). */
const STUCK_TICKS = 300;

// ---- Phases -----------------------------------------------------------------

/** What the line tells the driver to do at a sample. */
export const Phase = { Throttle: 0, Lift: 1, Brake: 2 } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/** Measured deceleration (m/s^2) that counts as braking; coasting, drag and climbs stay well under it. */
const BRAKE_DECEL_MIN = 8;
/** Mean gas below this (with no braking) is a lift. */
const GAS_FULL = 0.95;
/** A phase run shorter than this (m) between two runs of one more severe phase takes their phase. */
const GAP_FILL_M = 6;
/**
 * A lift shorter than this (m) between two brake runs joins them: one brake zone per corner, easing
 * off where the corner's speed plan has a step.
 */
const BRAKE_GAP_M = 40;
/** Shortest phase run (m) kept; shorter ones join the run before them. */
const MIN_RUN_M = 4;

/** A racing line, one sample per LINE_STEP metres of centre line from the start block's entry. */
export interface RacingLineData {
  /** Sample positions on the road surface. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Distance along the line from the first sample (m), never decreasing. */
  s: Float32Array;
  /** Lateral offset from the centre line (m, positive right) in 0.1 m steps. */
  e: Float32Array;
  phase: Uint8Array;
  /** Braking strength in Brake samples (share of the full-brake deceleration, 0..1, 1/15 steps), else 0. */
  brake: Float32Array;
  /** 1 where the pace car had its wheels down on the road: the only samples drawn. */
  visible: Uint8Array;
  /** The pace lap's time (ms). */
  time: number;
}

/** Runs a time-sliced job to completion (tests, scripts). */
export function runJob<T>(job: Generator<void, T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

// ---- Minimum-curvature line -------------------------------------------------

/**
 * Largest lateral offset (m) per route point: 0 (pinned to the centre) near the start, across jump
 * gaps and on jump ramps, PAD_HALF_WIDTH over boost and turbo pads, else `halfW`.
 */
export function lateralLimits(track: Track, route: Route, halfW = LINE_HALF_WIDTH): Float64Array {
  const pts = route.points;
  const N = pts.length;
  const lim = new Float64Array(N).fill(halfW);
  const pin = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    const p = pts[n];
    if (p.air || p.s < PIN_START) pin[n] = 1;
    const list = track.blocksAt(p.x, p.z);
    if (!list) continue;
    for (const b of list) {
      if (Math.abs(b.baseY - p.y) >= 2.5) continue;
      if (b.def.type === 'ramp') pin[n] = 1;
      if (b.def.pad) {
        const l = b.toLocal(p.x, p.z);
        if (l.b >= 4 && l.b <= 28) lim[n] = Math.min(lim[n], PAD_HALF_WIDTH);
      }
    }
  }
  for (let n = 0; n < N; n++) {
    if (!pin[n]) continue;
    for (let m = Math.max(0, n - PIN_GROW); m <= Math.min(N - 1, n + PIN_GROW); m++) lim[m] = 0;
  }
  return lim;
}

/**
 * Lateral offsets (m, positive right) of the route points that minimise the summed squared curvature
 * of the offset line, each within its limit: projected Gauss-Seidel on the bi-Laplacian, coarse to
 * fine. (A shortest-path smoother would hug the inside kerbs instead.)
 */
export function* minCurvatureOffsets(
  pts: readonly RoutePoint[],
  limits: Float64Array,
  maxIters = 160,
  tol = 1e-3,
): Generator<void, Float64Array> {
  const N = pts.length;
  const bx = new Float64Array(N), bz = new Float64Array(N);
  const rx = new Float64Array(N), rz = new Float64Array(N);
  const X = new Float64Array(N), Z = new Float64Array(N);
  const e = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const p = pts[n];
    bx[n] = X[n] = p.x;
    bz[n] = Z[n] = p.z;
    // Right of the heading.
    rx[n] = -p.hz;
    rz[n] = p.hx;
  }
  for (const k of [8, 4, 2, 1]) {
    for (let it = 0; it < maxIters; it++) {
      let maxD = 0;
      for (let n = 2 * k; n < N - 2 * k; n++) {
        const lim = limits[n];
        if (lim <= 0) continue;
        // Where the fourth difference through the neighbours vanishes, moved along the normal only.
        const tx = (-X[n - 2 * k] + 4 * X[n - k] + 4 * X[n + k] - X[n + 2 * k]) / 6;
        const tz = (-Z[n - 2 * k] + 4 * Z[n - k] + 4 * Z[n + k] - Z[n + 2 * k]) / 6;
        const d = (tx - X[n]) * rx[n] + (tz - Z[n]) * rz[n];
        const v = clamp(e[n] + 0.5 * d, -lim, lim);
        maxD = Math.max(maxD, Math.abs(v - e[n]));
        e[n] = v;
        X[n] = bx[n] + rx[n] * v;
        Z[n] = bz[n] + rz[n] * v;
      }
      if (maxD < tol) break;
      if ((it & 7) === 7) yield;
    }
  }
  return e;
}

/** The route moved sideways by `e` (m, positive right): distances, headings and curvature recomputed. */
export function offsetRoute(base: Route, e: ArrayLike<number>): Route {
  const src = base.points;
  const N = src.length;
  const pts: RoutePoint[] = src.map((p, n) => ({ ...p, x: p.x - p.hz * e[n], z: p.z + p.hx * e[n], s: 0, curv: 0 }));
  for (let n = 1; n < N; n++) {
    const a = pts[n - 1], b = pts[n];
    b.s = a.s + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  for (let n = 0; n < N; n++) {
    const a = pts[Math.max(0, n - 1)], b = pts[Math.min(N - 1, n + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) {
      pts[n].hx = dx / l;
      pts[n].hz = dz / l;
    }
  }
  for (let n = 0; n < N; n++) {
    const a = pts[Math.max(0, n - 3)], b = pts[Math.min(N - 1, n + 3)];
    const turn = Math.abs(Math.atan2(a.hx * b.hz - a.hz * b.hx, a.hx * b.hx + a.hz * b.hz));
    const ds = b.s - a.s;
    const k = ds > 0 ? turn / ds : 0;
    pts[n].curv = k < 1e-3 ? 0 : k;
  }
  return { blocks: base.blocks, points: pts, length: N ? pts[N - 1].s : 0, complete: base.complete };
}

// ---- Pace pilot -------------------------------------------------------------

/** Fastest speed (m/s) the planner takes a curve of curvature k (1/m) at: v^2 k = LAT_USE * maxLatAccel(v). */
export function cornerSpeed(k: number): number {
  if (k <= 0 || V_FREE * V_FREE * k <= LAT_USE * maxLatAccel(V_FREE)) return V_FREE;
  let lo = 0, hi = V_FREE;
  for (let n = 0; n < 40; n++) {
    const m = (lo + hi) / 2;
    if (m * m * k <= LAT_USE * maxLatAccel(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** Anything that drives a race along a route (PacePilot, test stubs). */
export interface Pilot {
  readonly route: Route;
  controls(race: RaceSession): Controls;
}

/** A speed plan per route point (m/s). */
export interface SpeedPlan {
  /** Corner (and crest) speed limit. */
  vLimit: Float64Array;
  /** Planned speed: the limits, then a braking pass back from every later limit. */
  vTarget: Float64Array;
}

/**
 * The pace pilot's speed plan for a line, from the physics' cornering and braking limits. Crests are
 * taken flat unless `crests` is set (then they are limited as the autopilot does).
 */
export function* planSpeeds(route: Route, crests = false): Generator<void, SpeedPlan> {
  const pts = route.points;
  const N = pts.length;
  const lim = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    lim[n] = cornerSpeed(pts[n].curv);
    if ((n & 63) === 63) yield;
  }
  // Crests: keep the wheels on the road where the deck curves away.
  for (let n = 1; crests && n < N - 1; n++) {
    const ds = (pts[n + 1].s - pts[n - 1].s) / 2;
    if (ds <= 0 || pts[n].air || pts[n + 1].air || pts[n - 1].air) continue;
    const ypp = (pts[n + 1].y - 2 * pts[n].y + pts[n - 1].y) / (ds * ds);
    if (ypp < -1e-4) lim[n] = Math.min(lim[n], Math.sqrt(36 / -ypp));
  }
  const v = Float64Array.from(lim);
  for (let n = N - 2; n >= 0; n--) {
    const ds = pts[n + 1].s - pts[n].s;
    // No brakes in the air.
    const a = pts[n].air || pts[n + 1].air ? 0 : BRAKE_USE * maxBrakeDecel(v[n + 1]);
    v[n] = Math.min(v[n], Math.sqrt(v[n + 1] * v[n + 1] + 2 * a * ds));
  }
  return { vLimit: lim, vTarget: v };
}

/**
 * Drives a racing line at the physics' limits: pure pursuit steering (as the autopilot in bot.ts),
 * the speed plan of planSpeeds, and proportional brakes, released once the steering nears the drift
 * range. The autopilot stays the conservative author-time driver.
 */
export class PacePilot implements Pilot {
  readonly vLimit: Float64Array;
  readonly vTarget: Float64Array;
  private idx = -1;

  constructor(
    readonly route: Route,
    plan: SpeedPlan = runJob(planSpeeds(route)),
  ) {
    this.vLimit = plan.vLimit;
    this.vTarget = plan.vTarget;
  }

  controls(race: RaceSession): Controls {
    const car = race.car;
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
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / fl, fz = fwd.z / fl;
    const alpha = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz);
    const dist = Math.hypot(dx, dz) || 1;
    const delta = Math.atan(2.8 * ((2 * Math.sin(alpha)) / dist));
    const steer = clamp(delta / maxSteerAngle(vdot(car.vel, fwd)), -1, 1);

    // The speed target a little ahead (reaction margin).
    let ahead = this.idx;
    while (ahead < pts.length - 1 && pts[ahead].s - sNow < 6 + speed * 0.12) ahead++;
    const over = speed - this.vTarget[ahead];
    if (over <= 0) return { steer, gas: 1, brake: 0 };
    if (over < HOLD_BAND) return { steer, gas: 0.3, brake: 0 };
    // Braking ends at turn-in: the line shows red only where a full brake pedal (touch, keyboard) is
    // safe, and braking while steering in the drift range at speed starts a drift. The car's steering
    // moves from where it is towards the input, so neither end may reach that range.
    if (Math.max(Math.abs(steer), Math.abs(car.steer)) > BRAKE_STEER) return { steer, gas: 0, brake: 0 };
    return { steer, gas: 0, brake: clamp(over / BRAKE_GAIN, 0, 1) };
  }
}

/** Why a pace drive ended. */
export type DriveEnd = 'finished' | 'respawn' | 'missing' | 'stuck' | 'fell' | 'timeout';

/** Per-tick record of a pace drive, from GO (the start pose first) to the finish line. */
export interface PaceTrace {
  x: number[];
  y: number[];
  z: number[];
  /** Speed (m/s). */
  v: number[];
  /** Pedals as the race applied them (quantised, 0..1). */
  gas: number[];
  brake: number[];
  /** The car's steering (-1..1, as it moves towards the input). */
  steer: number[];
  /** 1 with at least two wheels down and not on the grass. */
  onRoad: number[];
  /** Horizontal lateral acceleration (m/s^2) from the change of velocity. */
  lat: number[];
  /** Finish time (ms). */
  time: number;
}

export interface PaceDrive {
  trace: PaceTrace | null;
  /** Racing ticks driven. */
  ticks: number;
  end: DriveEnd;
}

/** Tick budget for a pace drive on a route of this length: an 8 m/s average plus 10 s. */
export function paceTickCap(routeLength: number): number {
  return Math.round(100 * (routeLength / 8 + 10));
}

/**
 * Drives one clean lap with `pilot` (headless, deterministic, one racing tick per slice). Gives up at
 * once on a respawn, on a finish crossed with checkpoints missing, on a fall, when it has not moved
 * along the route for 3 s, or past `maxTicks`: a line needs a clean lap, and custom tracks must not
 * burn CPU.
 */
export function* drivePace(
  track: Track,
  pilot: Pilot,
  maxTicks = paceTickCap(pilot.route.length),
): Generator<void, PaceDrive> {
  const race = new RaceSession(track);
  while (race.phase === 'countdown') race.step(NO_CONTROLS);
  const t: PaceTrace = { x: [], y: [], z: [], v: [], gas: [], brake: [], steer: [], onRoad: [], lat: [], time: 0 };
  const record = (ctl: Controls, lat: number) => {
    const c = race.car;
    t.x.push(c.pos.x);
    t.y.push(c.pos.y);
    t.z.push(c.pos.z);
    t.v.push(speedOf(c));
    t.gas.push(ctl.gas);
    t.brake.push(ctl.brake);
    t.steer.push(c.steer);
    t.onRoad.push(c.grounded >= 2 && !c.onGrass ? 1 : 0);
    t.lat.push(lat);
  };
  record(NO_CONTROLS, 0);
  const pts = pilot.route.points;
  let hint = -1;
  let best = -Infinity;
  let bestTick = 0;
  for (let n = 1; n <= maxTicks; n++) {
    const ctl = quantise(pilot.controls(race));
    const pvx = race.car.vel.x, pvz = race.car.vel.z;
    for (const e of race.step(ctl)) {
      if (e.type === 'respawn' || e.type === 'missing') return { trace: null, ticks: n, end: e.type };
    }
    const c = race.car;
    const ax = (c.vel.x - pvx) / DT, az = (c.vel.z - pvz) / DT;
    const vh = Math.hypot(c.vel.x, c.vel.z);
    record(ctl, vh > 1 ? Math.abs(ax * c.vel.z - az * c.vel.x) / vh : 0);
    if (race.phase === 'finished') {
      t.time = race.finishTime!;
      return { trace: t, ticks: n, end: 'finished' };
    }
    if (c.pos.y < -10) return { trace: null, ticks: n, end: 'fell' };
    if (n % 100 === 0 && pts.length) {
      hint = nearestPoint(pilot.route, c.pos.x, c.pos.y, c.pos.z, hint);
      const p = pts[hint];
      if (c.onGrass && p.y - c.pos.y > 3) return { trace: null, ticks: n, end: 'fell' };
      if (p.s > best + 2) {
        best = p.s;
        bestTick = n;
      } else if (n - bestTick >= STUCK_TICKS) return { trace: null, ticks: n, end: 'stuck' };
    }
    yield;
  }
  return { trace: null, ticks: maxTicks, end: 'timeout' };
}

/**
 * The pace car's lap of a line and the pilot that drove it. Flying a crest can go wrong: the car is
 * in the air where the plan brakes and reaches the next turn-in too fast to brake there (A03), or it
 * lands badly on a custom track. A drive that ends in a respawn, a fall or stuck is tried once more
 * with the crests limited.
 */
export function* paceRun(track: Track, line: Route): Generator<void, { pilot: PacePilot; run: PaceDrive }> {
  let pilot = new PacePilot(line, yield* planSpeeds(line));
  let run = yield* drivePace(track, pilot);
  if (run.end === 'respawn' || run.end === 'fell' || run.end === 'stuck') {
    pilot = new PacePilot(line, yield* planSpeeds(line, true));
    run = yield* drivePace(track, pilot);
  }
  return { pilot, run };
}

// ---- Sampling and phases ----------------------------------------------------

/** Number of samples on a route of this length. */
export function sampleCount(routeLength: number): number {
  return Math.floor(routeLength / LINE_STEP + 1e-6) + 1;
}

/** 0.1 m steps, within what one signed byte stores (and no -0, which a decoded line cannot have). */
const quantE = (e: number) => clamp(Math.round(e * 10), -127, 127) / 10 + 0;
const quantBrake = (b: number) => Math.round(clamp(b, 0, 1) * 15) / 15;

/**
 * Positions of the samples at offsets `e` from the centre line, on the road surface, and the distance
 * along them; `road` gets 1 where the surface there is road. Shared by the pace job and the decoder,
 * so a stored line and a computed one are the same data.
 */
function* placeSamples(
  track: Track,
  base: Route,
  e: Float32Array,
  d: Pick<RacingLineData, 'x' | 'y' | 'z' | 's'>,
  road: Uint8Array | null,
): Generator<void, void> {
  const pts = base.points;
  let j = 0;
  for (let i = 0; i < e.length; i++) {
    const sb = i * LINE_STEP;
    while (j < pts.length - 2 && pts[j + 1].s <= sb) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const f = b.s > a.s ? clamp((sb - a.s) / (b.s - a.s), 0, 1) : 0;
    let hx = a.hx + (b.hx - a.hx) * f, hz = a.hz + (b.hz - a.hz) * f;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    const by = a.y + (b.y - a.y) * f;
    const x = a.x + (b.x - a.x) * f - hz * e[i];
    const z = a.z + (b.z - a.z) * f + hx * e[i];
    // Lateral offsets keep the height on every block, so the deck under the centre line is the one.
    const hit = track.surfaceAt(x, by + 1, z, 1.5);
    d.x[i] = x;
    d.y[i] = hit.road ? hit.y : by;
    d.z[i] = z;
    if (road) road[i] = hit.road ? 1 : 0;
    d.s[i] = i ? d.s[i - 1] + Math.hypot(x - d.x[i - 1], d.y[i] - d.y[i - 1], z - d.z[i - 1]) : 0;
    if ((i & 31) === 31) yield;
  }
}

/** Centre-line distance and lateral offset (m, positive right) of a point, near route point `hint`. */
function project(route: Route, x: number, y: number, z: number, hint: number): { s: number; e: number; idx: number } {
  const pts = route.points;
  const idx = nearestPoint(route, x, y, z, hint);
  let a = idx;
  const p = pts[idx];
  if (idx > 0 && ((x - p.x) * p.hx + (z - p.z) * p.hz < 0 || idx === pts.length - 1)) a = idx - 1;
  const A = pts[a], B = pts[Math.min(a + 1, pts.length - 1)];
  const sx = B.x - A.x, sz = B.z - A.z;
  const l2 = sx * sx + sz * sz;
  const f = l2 > 0 ? clamp(((x - A.x) * sx + (z - A.z) * sz) / l2, 0, 1) : 0;
  const hx = A.hx + (B.hx - A.hx) * f, hz = A.hz + (B.hz - A.hz) * f;
  const hl = Math.hypot(hx, hz) || 1;
  const e = ((x - A.x - sx * f) * -hz + (z - A.z - sz * f) * hx) / hl;
  return { s: A.s + (B.s - A.s) * f, e, idx };
}

/**
 * Every tick of a pace trace on the centre-line grid: distance along it (never going backwards; tick
 * k is nearest to sample round(s[k] / LINE_STEP)) and lateral offset.
 */
export function* traceOnCentre(t: PaceTrace, base: Route): Generator<void, { s: Float64Array; e: Float64Array }> {
  const K = t.x.length;
  const s = new Float64Array(K), e = new Float64Array(K);
  let hint = -1;
  for (let k = 0; k < K; k++) {
    const p = project(base, t.x[k], t.y[k], t.z[k], hint);
    hint = p.idx;
    s[k] = k ? Math.max(p.s, s[k - 1]) : p.s;
    e[k] = p.e;
    if ((k & 63) === 63) yield;
  }
  return { s, e };
}

/**
 * The pace trace as line samples on the centre-line grid: the driven offset, and the phase from the
 * speed profile, not from the pilot's pedal chatter. Braking is a measured deceleration over
 * BRAKE_DECEL_MIN with the brake on (not a landing), and never where the car steered in the drift
 * range (a full brake pedal there starts a drift); a lift is less than full gas (or braking too light
 * to count); the rest is throttle.
 */
export function* sampleLine(t: PaceTrace, track: Track, base: Route): Generator<void, RacingLineData> {
  const K = t.x.length;
  const n = sampleCount(base.length);
  const { s: sb, e: eb } = yield* traceOnCentre(t, base);
  // Pedal duties per sample: the ticks nearest to it.
  const gasSum = new Float64Array(n), brakeSum = new Float64Array(n);
  const cnt = new Uint32Array(n), off = new Uint8Array(n);
  // 1 where the car steered in the drift range: never a brake sample.
  const steered = new Uint8Array(n);
  const hard = (j: number) => Math.abs(t.steer[j]) > DRIFT_STEER;
  for (let k = 0; k < K; k++) {
    const i = Math.round(sb[k] / LINE_STEP);
    if (i < 0 || i >= n) continue;
    gasSum[i] += t.gas[k];
    brakeSum[i] += t.brake[k];
    cnt[i]++;
    if (!t.onRoad[k]) off[i] = 1;
    if (hard(k)) steered[i] = 1;
  }

  const e = new Float32Array(n);
  const v = new Float64Array(n);
  const tick = new Float64Array(n);
  const gas = new Float64Array(n), brk = new Float64Array(n);
  const driven = new Uint8Array(n);
  const visible = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = i * LINE_STEP;
    while (k < K - 2 && sb[k + 1] <= s) k++;
    if (s < sb[0] || s > sb[K - 1] || K < 2) {
      e[i] = quantE(s < sb[0] ? eb[0] : eb[K - 1]);
      continue;
    }
    const f = sb[k + 1] > sb[k] ? clamp((s - sb[k]) / (sb[k + 1] - sb[k]), 0, 1) : 0;
    driven[i] = 1;
    e[i] = quantE(eb[k] + (eb[k + 1] - eb[k]) * f);
    v[i] = t.v[k] + (t.v[k + 1] - t.v[k]) * f;
    tick[i] = k + f;
    gas[i] = cnt[i] ? gasSum[i] / cnt[i] : t.gas[k];
    brk[i] = cnt[i] ? brakeSum[i] / cnt[i] : t.brake[k];
    visible[i] = !off[i] && t.onRoad[k] && t.onRoad[k + 1] ? 1 : 0;
    if (hard(k) || hard(k + 1)) steered[i] = 1;
  }
  yield;

  const raw = new Uint8Array(n);
  const level = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!driven[i]) continue;
    // Deceleration over +-2 samples (dv/dt from the interpolated tick times).
    let i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
    while (!driven[i0]) i0++;
    while (!driven[i1]) i1--;
    const dt = (tick[i1] - tick[i0]) * DT;
    const a = dt > 0 ? (v[i1] - v[i0]) / dt : 0;
    level[i] = clamp(-a / maxBrakeDecel(v[i]), 0, 1);
    if (a < -BRAKE_DECEL_MIN && brk[i] > 0 && !steered[i]) raw[i] = Phase.Brake;
    else raw[i] = gas[i] < GAS_FULL || brk[i] > 0 ? Phase.Lift : Phase.Throttle;
  }
  yield;
  const phase = smoothPhases(raw, steered);
  yield;
  const brake = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (phase[i] !== Phase.Brake) continue;
    // Measured strength, box-filtered over +-2 samples of the zone (a joined lift is a light brake).
    let sum = 0, m = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      if (phase[j] !== Phase.Brake) continue;
      sum += level[j];
      m++;
    }
    brake[i] = quantBrake(sum / m);
  }

  const d: RacingLineData = {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    s: new Float32Array(n),
    e,
    phase,
    brake,
    visible,
    time: t.time,
  };
  const road = new Uint8Array(n);
  yield* placeSamples(track, base, e, d, road);
  for (let i = 0; i < n; i++) visible[i] &= road[i];
  return d;
}

/**
 * Removes phase flicker (lengths in samples), until nothing changes: a run shorter than `gap` whose
 * neighbours share a more severe phase takes it (brake, lift, brake is one brake zone), and a lift
 * shorter than `brakeGap` between brakes too; then a run shorter than `minRun` takes the phase of
 * the run before it (the next one's for the first run). Samples set in `noBrake` never become brake.
 */
export function smoothPhases(
  raw: Uint8Array,
  noBrake: Uint8Array | null = null,
  gap = Math.round(GAP_FILL_M / LINE_STEP),
  minRun = Math.round(MIN_RUN_M / LINE_STEP),
  brakeGap = Math.round(BRAKE_GAP_M / LINE_STEP),
): Uint8Array {
  let cur: Uint8Array = Uint8Array.from(raw);
  for (let pass = 0; pass < raw.length + 1; pass++) {
    const next = smoothOnce(cur, noBrake, gap, minRun, brakeGap);
    if (next.every((p, i) => p === cur[i])) return next;
    cur = next;
  }
  return cur;
}

function runsOf(a: Uint8Array): { start: number; len: number; phase: number }[] {
  const runs: { start: number; len: number; phase: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.phase === a[i]) last.len++;
    else runs.push({ start: i, len: 1, phase: a[i] });
  }
  return runs;
}

function smoothOnce(
  src: Uint8Array,
  noBrake: Uint8Array | null,
  gap: number,
  minRun: number,
  brakeGap: number,
): Uint8Array {
  const out = Uint8Array.from(src);
  const fill = (p: number, start: number, len: number) => {
    for (let i = start; i < start + len; i++) if (p !== Phase.Brake || !noBrake?.[i]) out[i] = p;
  };
  const runs = runsOf(src);
  for (let r = 1; r < runs.length - 1; r++) {
    const { start, len, phase } = runs[r];
    const p = runs[r - 1].phase;
    const max = p === Phase.Brake && phase === Phase.Lift ? Math.max(gap, brakeGap) : gap;
    if (len < max && p === runs[r + 1].phase && p > phase) fill(p, start, len);
  }
  const merged = runsOf(out);
  for (let r = 0; r < merged.length; r++) {
    const { start, len } = merged[r];
    if (len >= minRun || merged.length < 2) continue;
    fill(r > 0 ? out[start - 1] : merged[1].phase, start, len);
  }
  return out;
}

// ---- The job ----------------------------------------------------------------

/**
 * Whether a track can have a line: the route reaches a finish and every checkpoint is on it.
 * Checkpoints count in any order, so one off the chain would leave the pace car circling.
 */
export function lineable(track: Track, base: Route): boolean {
  if (!track.start || !base.complete || base.points.length < 8) return false;
  const on = new Set(base.blocks);
  return track.gates.every((g) => g.kind !== 'checkpoint' || on.has(g.block));
}

/** Computes a track's racing line, or null when it has none (time-sliced; see LineJobs). */
export function* paceLineJob(track: Track): Generator<void, RacingLineData | null> {
  const base = traceRoute(track);
  if (!lineable(track, base)) return null;
  yield;
  const limits = lateralLimits(track, base);
  yield;
  const e = yield* minCurvatureOffsets(base.points, limits);
  const line = offsetRoute(base, e);
  yield;
  const { run } = yield* paceRun(track, line);
  if (!run.trace) return null;
  return yield* sampleLine(run.trace, track, base);
}

// ---- Precomputed lines ------------------------------------------------------

/** One stored line: two bytes per sample (offset in 0.1 m; phase, visible and brake bits), base64. */
export interface StoredLine {
  /** Centre-line length (m, 0.1 m), to catch a changed layout. */
  len: number;
  /** Pace lap time (ms). */
  time: number;
  data: string;
}

export interface StoredLines {
  physics: number;
  lines: Record<string, StoredLine>;
}

const table = racingLines as StoredLines;

/** The precomputed line for a campaign track id, or null when there is none for this PHYSICS_VERSION. */
export function storedLine(id: string): StoredLine | null {
  return table.physics === PHYSICS_VERSION ? (table.lines[id] ?? null) : null;
}

export function encodeLine(d: RacingLineData, routeLength: number): StoredLine {
  const n = d.e.length;
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    bytes[2 * i] = Math.round(d.e[i] * 10) & 0xff;
    bytes[2 * i + 1] = d.phase[i] | (d.visible[i] << 2) | (Math.round(d.brake[i] * 15) << 3);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { len: Math.round(routeLength * 10) / 10, time: d.time, data: btoa(bin) };
}

/** A stored line on a track, or null when it does not fit the track's route. */
export function* decodeLine(track: Track, st: StoredLine): Generator<void, RacingLineData | null> {
  const base = traceRoute(track);
  const n = sampleCount(base.length);
  const bin = atob(st.data);
  if (Math.abs(Math.round(base.length * 10) / 10 - st.len) > 1e-6 || bin.length !== n * 2) return null;
  const d: RacingLineData = {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    s: new Float32Array(n),
    e: new Float32Array(n),
    phase: new Uint8Array(n),
    brake: new Float32Array(n),
    visible: new Uint8Array(n),
    time: st.time,
  };
  for (let i = 0; i < n; i++) {
    const q = bin.charCodeAt(2 * i);
    const f = bin.charCodeAt(2 * i + 1);
    d.e[i] = (q > 127 ? q - 256 : q) / 10;
    d.phase[i] = Math.min(f & 3, Phase.Brake);
    d.visible[i] = (f >> 2) & 1;
    d.brake[i] = (f >> 3) / 15;
  }
  yield;
  yield* placeSamples(track, base, d.e, d, null);
  return d;
}

/**
 * The line job for a race entry key: the stored line for a campaign key ('c:A01') when it fits this
 * physics and layout, else the pace job.
 */
export function* lineJob(key: string, track: Track): Generator<void, RacingLineData | null> {
  const st = key.startsWith('c:') ? storedLine(key.slice(2)) : null;
  if (st) {
    const d = yield* decodeLine(track, st);
    if (d) return d;
  }
  return yield* paceLineJob(track);
}

// ---- Lookups and colours ----------------------------------------------------

/**
 * Index of the sample closest to (x, y, z), heights weighted double so stacked decks stay apart.
 * Searches a window around `hint` (30 back, 120 ahead) and everything when that is over 40 m off.
 */
export function nearestSample(d: RacingLineData, x: number, y: number, z: number, hint = -1): number {
  const n = d.x.length;
  let best = 0;
  let bestD = Infinity;
  const from = hint >= 0 ? Math.max(0, hint - 30) : 0;
  const to = hint >= 0 ? Math.min(n, hint + 120) : n;
  for (let i = from; i < to; i++) {
    const dx = d.x[i] - x, dy = (d.y[i] - y) * 2, dz = d.z[i] - z;
    const q = dx * dx + dy * dy + dz * dz;
    if (q < bestD) {
      bestD = q;
      best = i;
    }
  }
  if (hint >= 0 && bestD > 40 * 40) return nearestSample(d, x, y, z, -1);
  return best;
}

/** Distance along the line of the point nearest to (x, z) on the segments next to sample i. */
export function lineDistanceAt(d: RacingLineData, i: number, x: number, z: number): number {
  const n = d.x.length;
  if (n < 2) return n ? d.s[0] : 0;
  let best = d.s[i];
  let bestD = Infinity;
  for (const a of [i - 1, i]) {
    if (a < 0 || a >= n - 1) continue;
    const sx = d.x[a + 1] - d.x[a], sz = d.z[a + 1] - d.z[a];
    const l2 = sx * sx + sz * sz;
    const f = l2 > 0 ? clamp(((x - d.x[a]) * sx + (z - d.z[a]) * sz) / l2, 0, 1) : 0;
    const px = d.x[a] + sx * f - x, pz = d.z[a] + sz * f - z;
    const q = px * px + pz * pz;
    if (q < bestD) {
      bestD = q;
      best = d.s[a] + (d.s[a + 1] - d.s[a]) * f;
    }
  }
  return best;
}

/** Display colours (sRGB, 0..1). */
const THROTTLE_RGB = [0.18, 0.83, 0.35];
const LIFT_RGB = [1.0, 0.76, 0.1];
const BRAKE_LIGHT_RGB = [1.0, 0.48, 0.1];
const BRAKE_HARD_RGB = [1.0, 0.16, 0.12];

/**
 * RGB per sample: green throttle, yellow lift, orange to red by braking strength, blurred over +-2
 * samples so changes are short gradients. `liftAsThrottle` paints lifts green, for auto-accelerate,
 * which cannot lift.
 */
export function lineColors(d: RacingLineData, liftAsThrottle = false): Float32Array {
  const n = d.phase.length;
  const raw = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = d.phase[i];
    let c = p === Phase.Lift && !liftAsThrottle ? LIFT_RGB : THROTTLE_RGB;
    if (p === Phase.Brake) {
      const t = clamp((d.brake[i] - 0.3) / 0.5, 0, 1);
      c = [0, 1, 2].map((k) => BRAKE_LIGHT_RGB[k] + (BRAKE_HARD_RGB[k] - BRAKE_LIGHT_RGB[k]) * t);
    }
    raw.set(c, i * 3);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let j = a; j <= b; j++) sum += raw[j * 3 + k];
      out[i * 3 + k] = sum / (b - a + 1);
    }
  }
  return out;
}

// ---- Time-sliced jobs -------------------------------------------------------

type LineCallback = (d: RacingLineData | null) => void;
type MakeJob = (key: string, track: Track) => Generator<void, RacingLineData | null>;

interface Job {
  key: string;
  it: Generator<void, RacingLineData | null>;
  waiters: LineCallback[];
  /** Queued by prefetch: kept even with no waiters. */
  prefetch: boolean;
}

/** Frame time (s) over which a race frame skips the line work, so a slow frame is not made slower. */
const SLOW_FRAME = 0.0175;

/**
 * Racing lines by race entry key ('c:A01', 'u:<layout hash>'), computed by time-sliced jobs on the main
 * thread, one job per key, and kept in a small memory-only LRU (nothing is persisted, so a physics change
 * can never serve a stale line). A failed job stores null and is not retried this session.
 */
export class LineJobs {
  private readonly cache = new Map<string, RacingLineData | null>();
  private queue: Job[] = [];

  constructor(
    private readonly make: MakeJob = lineJob,
    private readonly max = 8,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The finished line (null: the track has none), or undefined when it is not computed yet. */
  peek(key: string): RacingLineData | null | undefined {
    const d = this.cache.get(key);
    if (d !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, d);
    }
    return d;
  }

  /**
   * Calls `cb` with the line once it is ready: at once when it is cached, else from pump(). The job goes
   * to the front of the queue (a prefetched one is reused). Returns a cancel function; a job left with no
   * waiters is dropped unless it was prefetched.
   */
  request(key: string, track: Track, cb: LineCallback): () => void {
    const hit = this.peek(key);
    if (hit !== undefined) {
      cb(hit);
      return () => {};
    }
    let job = this.queue.find((j) => j.key === key);
    if (job) this.queue = this.queue.filter((j) => j !== job);
    else job = { key, it: this.make(key, track), waiters: [], prefetch: false };
    this.queue.unshift(job);
    job.waiters.push(cb);
    const j = job;
    return () => {
      const at = j.waiters.indexOf(cb);
      if (at >= 0) j.waiters.splice(at, 1);
      if (!j.waiters.length && !j.prefetch) this.queue = this.queue.filter((q) => q !== j);
    };
  }

  /** Queues a line at the back (e.g. the next campaign track on the results screen). */
  prefetch(key: string, track: Track): void {
    if (this.cache.has(key)) return;
    const job = this.queue.find((j) => j.key === key);
    if (job) job.prefetch = true;
    else this.queue.push({ key, it: this.make(key, track), waiters: [], prefetch: true });
  }

  /** True while a job is queued. */
  get busy(): boolean {
    return this.queue.length > 0;
  }

  /** Runs queued jobs until they are done or `budgetMs` has passed (it may overrun by one slice). */
  pump(budgetMs: number): void {
    const end = this.now() + budgetMs;
    while (this.queue.length) {
      const job = this.queue[0];
      let r: IteratorResult<void, RacingLineData | null>;
      try {
        r = job.it.next();
      } catch (err) {
        console.warn(`Racing line for ${job.key} failed`, err);
        r = { done: true, value: null };
      }
      if (r.done) {
        this.queue.shift();
        this.store(job.key, r.value);
        for (const cb of job.waiters) cb(r.value);
      }
      if (this.now() >= end) break;
    }
  }

  /**
   * Once per rendered frame: 1.5 ms while driving, and only after a frame of 17.5 ms or less; 6 ms
   * otherwise (countdown, pause, results).
   */
  pumpFrame(dt: number, driving: boolean): void {
    if (!this.queue.length || (driving && dt > SLOW_FRAME)) return;
    this.pump(driving ? 1.5 : 6);
  }

  private store(key: string, d: RacingLineData | null): void {
    this.cache.delete(key);
    this.cache.set(key, d);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
  }
}

/** The app's line jobs. */
export const lineJobs = new LineJobs();
