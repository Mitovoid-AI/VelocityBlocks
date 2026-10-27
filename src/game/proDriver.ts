// Pro driver: a racing-line pilot whose driving is tuned per track by practice. It starts from the pace
// pilot's settings (racingLine.ts) and searches the share of grip it corners at, the braking it plans with,
// its steering lookahead, how wide it uses the road, how it takes crests, and a speed factor for every
// SEG_M metres of road, keeping only changes that give a faster clean lap (finished, no respawn, no barrier
// hit). The physics is deterministic, so a tuned driver laps the same every time: its laps set the author
// times and the medal ghosts (scripts/pro-laps.ts), and the same driver plays the game for tests (autoplay).
// Pure TypeScript with no rendering, like the autopilot and the pace pilot.

import { clamp, vdot } from '../core/vec';
import type { VehicleClass } from '../core/vehicles';
import {
  cornerSpeedAt,
  DEFAULT_ASSISTS,
  DRIFT_STEER,
  forwardOf,
  lineHalfWidth,
  maxBrakeDecel,
  maxSteerAngle,
  nitroReady,
  speedOf,
  vehicleSpec,
  type Controls,
  type VehicleSpec,
} from '../physics/vehicle';
import { nearestPoint, traceRoute, type Route } from '../track/route';
import type { Track } from '../track/track';
import { nitroFits } from './bot';
import type { Ghost } from './ghost';
import { drivePace, lateralLimits, lineable, minCurvatureOffsets, offsetRoute, runJob, type Pilot } from './racingLine';
import { RaceSession, quantise } from './race';

/** Road length (m) each speed factor covers. */
export const SEG_M = 20;
/** Speed target where nothing limits it (as the pace pilot). */
const V_FREE = 200;
/** Overspeed (m/s) that asks for the full brake pedal; less brakes in proportion. */
const BRAKE_GAIN = 4;
/** Overspeed (m/s) held with a light throttle before the brakes come in. */
const HOLD_BAND = 1;

/** How a pro driver drives one track. JSON-safe: stored per track and class in proLaps.json. */
export interface ProParams {
  /** Share of the cornering limit (maxLatAccel) the speed plan corners at. */
  lat: number;
  /** Share of the full-brake deceleration the speed plan brakes at. */
  brake: number;
  /** Pursuit lookahead (m): at rest, and per m/s of speed. */
  look0: number;
  look1: number;
  /** Metres added to (or taken from) the class's line half-width (lineHalfWidth). */
  width: number;
  /** Vertical acceleration (m/s^2) crests are taken at, at most; 0 flies them. */
  crest: number;
  /** Steering (input or car) past which it lets go of the brakes; over 1 never lets go. */
  brakeSteer: number;
  nitro: boolean;
  /** Speed factor on the corner limit for each SEG_M metres of line. */
  seg: number[];
}

/** The pace pilot's car settings: where practice starts. */
export function baseParams(vehicle: VehicleClass, routeLength: number): ProParams {
  return {
    lat: 0.9,
    brake: vehicle === 'bike' ? 0.8 : 0.85,
    look0: 7,
    look1: 0.32,
    width: 0,
    crest: 0,
    brakeSteer: vehicle === 'car' ? DRIFT_STEER - 0.02 : 9,
    nitro: true,
    seg: new Array(Math.ceil(routeLength / SEG_M) + 1).fill(1),
  };
}

/** A track's minimum-curvature line `width` m wider than the class's usual one (null when it has none). */
export function proLine(track: Track, S: VehicleSpec, width: number): Route | null {
  const base = traceRoute(track);
  if (!lineable(track, base)) return null;
  const limits = lateralLimits(track, base, Math.max(1, lineHalfWidth(S) + width));
  return offsetRoute(base, runJob(minCurvatureOffsets(base.points, limits)));
}

/** The speed plan (m/s per line point) for a set of params. */
export function proPlan(line: Route, S: VehicleSpec, p: ProParams): Float64Array {
  const pts = line.points;
  const N = pts.length;
  const v = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const f = p.seg[Math.min(p.seg.length - 1, Math.floor(pts[n].s / SEG_M))] ?? 1;
    v[n] = cornerSpeedAt(pts[n].curv, p.lat, S, V_FREE) * f;
  }
  if (p.crest > 0) {
    for (let n = 1; n < N - 1; n++) {
      const ds = (pts[n + 1].s - pts[n - 1].s) / 2;
      if (ds <= 0 || pts[n].air || pts[n + 1].air || pts[n - 1].air) continue;
      const ypp = (pts[n + 1].y - 2 * pts[n].y + pts[n - 1].y) / (ds * ds);
      if (ypp < -1e-4) v[n] = Math.min(v[n], Math.sqrt(p.crest / -ypp));
    }
  }
  // Backward pass: able to brake down to every later limit (no brakes in the air).
  for (let n = N - 2; n >= 0; n--) {
    const ds = pts[n + 1].s - pts[n].s;
    const vn = v[n + 1];
    const a = pts[n].air || pts[n + 1].air ? 0 : p.brake * maxBrakeDecel(vn, S);
    v[n] = Math.min(v[n], Math.sqrt(Math.max(1, vn * vn + 2 * a * ds)));
  }
  return v;
}

/** Drives a line with a speed plan: pure pursuit, proportional brakes, the nitro where it fits. */
export class ProPilot implements Pilot {
  readonly vTarget: Float64Array;
  private idx = -1;

  constructor(
    readonly route: Route,
    readonly spec: VehicleSpec,
    readonly params: ProParams,
  ) {
    this.vTarget = proPlan(route, spec, params);
  }

  /** Forget where it was (a respawn, a restart). */
  reset(): void {
    this.idx = -1;
  }

  controls(race: RaceSession): Controls {
    const car = race.car;
    const pts = this.route.points;
    const p = this.params;
    if (pts.length < 2) return { steer: 0, gas: 1, brake: 0 };
    this.idx = nearestPoint(this.route, car.pos.x, car.pos.y, car.pos.z, this.idx);
    const speed = speedOf(car);
    const look = p.look0 + speed * p.look1;
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
    const delta = Math.atan(this.spec.wheelbase * ((2 * Math.sin(alpha)) / dist));
    // Target behind (after a spin): full lock towards it.
    const steer = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) : clamp(delta / maxSteerAngle(vdot(car.vel, fwd), this.spec), -1, 1);

    let ahead = this.idx;
    while (ahead < pts.length - 1 && pts[ahead].s - sNow < 6 + speed * 0.12) ahead++;
    const over = speed - this.vTarget[ahead];
    if (over <= 0) {
      if (p.nitro && nitroReady(car) && nitroFits(this.route, this.vTarget, this.idx, speed, car)) return { steer, gas: 1, brake: 0, nitro: true };
      return { steer, gas: 1, brake: 0 };
    }
    if (over < HOLD_BAND) return { steer, gas: 0.3, brake: 0 };
    if (Math.max(Math.abs(steer), Math.abs(car.steer)) > p.brakeSteer) return { steer, gas: 0, brake: 0 };
    return { steer, gas: 0, brake: clamp(over / BRAKE_GAIN, 0, 1) };
  }
}

/** One practice lap: its time (ms) when clean, else null. */
export interface ProLap {
  time: number | null;
  end: string;
}

/** Lines are the slow part of a pilot to build and depend only on the width: cache them per track. */
export class LineCache {
  private readonly lines = new Map<number, Route | null>();
  constructor(
    readonly track: Track,
    readonly spec: VehicleSpec,
  ) {}
  get(width: number): Route | null {
    const k = Math.round(width * 4) / 4;
    if (!this.lines.has(k)) this.lines.set(k, proLine(this.track, this.spec, k));
    return this.lines.get(k)!;
  }
}

/** A practice lap with these params. Clean means finished, no respawn, no barrier hit or near stop. */
export function proLap(lines: LineCache, p: ProParams): ProLap {
  const line = lines.get(p.width);
  if (!line) return { time: null, end: 'no line' };
  const r = runJob(drivePace(lines.track, new ProPilot(line, lines.spec, p)));
  if (r.end !== 'finished' || r.crashed || !r.trace) return { time: null, end: r.crashed ? 'crashed' : r.end };
  return { time: r.trace.time, end: 'finished' };
}

export interface PracticeResult {
  params: ProParams;
  time: number;
  /** Laps driven. */
  laps: number;
}

/**
 * Practice a track: find a clean starting lap, then hill-climb the global settings and the per-segment speed
 * factors, keeping every change that gives a faster clean lap, with shrinking steps, until a pass gains
 * nothing or `maxLaps` laps are driven. Deterministic. Null when no setting finishes the track cleanly.
 */
export interface PracticeOptions {
  /** Settings to start from as well (a stored lap: practice continues from it). */
  start?: ProParams;
  /** Nonzero: also start from a style drawn at random with this seed (independent sessions on many cores). */
  seed?: number;
  log?: (msg: string) => void;
}

/** A starting style drawn from `seed`: corner, brake, lookahead, width and crest settings spread around the pace pilot's. */
function seededStart(seed: number, base: ProParams): ProParams {
  let x = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  return {
    ...base,
    lat: 0.75 + rnd() * 0.4,
    brake: 0.65 + rnd() * 0.35,
    look0: 5 + rnd() * 6,
    look1: 0.22 + rnd() * 0.2,
    width: -2 + rnd() * 2.5,
    crest: rnd() < 0.5 ? 0 : 20 + rnd() * 30,
  };
}

export function practice(track: Track, vehicle: VehicleClass = 'car', maxLaps = 1500, opts: PracticeOptions = {}): PracticeResult | null {
  const log = opts.log;
  const S = vehicleSpec(vehicle);
  const lines = new LineCache(track, S);
  const line0 = lines.get(0);
  if (!line0) return null;
  let laps = 0;
  const lap = (p: ProParams) => {
    laps++;
    return proLap(lines, p).time;
  };

  // A clean start: the pace pilot's settings, then the fallbacks it uses (crests limited, no nitro), slower.
  const seeds: Partial<ProParams>[] = [{}, { crest: 36 }, { crest: 36, nitro: false }, { crest: 36, lat: 0.8 }, { crest: 30, lat: 0.7, brake: 0.7 }, { crest: 25, lat: 0.6, brake: 0.6, nitro: false }];
  let best: ProParams | null = null;
  let bestT = Infinity;
  const base = baseParams(vehicle, line0.length);
  const starts: ProParams[] = seeds.map((s) => ({ ...base, ...s }));
  if (opts.seed) starts.unshift(seededStart(opts.seed, base));
  if (opts.start) starts.unshift({ ...opts.start, seg: base.seg.map((_, i) => opts.start!.seg[i] ?? 1) });
  for (const p of starts) {
    const t = lap(p);
    if (t !== null && t < bestT) {
      best = p;
      bestT = t;
    }
  }
  if (!best) return null;
  log?.(`seed ${bestT}`);

  const tryP = (p: ProParams): boolean => {
    if (laps >= maxLaps) return false;
    const t = lap(p);
    if (t !== null && t < bestT) {
      best = p;
      bestT = t;
      return true;
    }
    return false;
  };

  type Knob = { key: 'lat' | 'brake' | 'look0' | 'look1' | 'width' | 'crest' | 'brakeSteer'; step: number; lo: number; hi: number };
  const knobs: Knob[] = [
    { key: 'lat', step: 0.03, lo: 0.5, hi: 1.3 },
    { key: 'brake', step: 0.04, lo: 0.4, hi: 1.2 },
    { key: 'look0', step: 1, lo: 3, hi: 14 },
    { key: 'look1', step: 0.03, lo: 0.12, hi: 0.6 },
    { key: 'width', step: 0.5, lo: -3, hi: 1.5 },
    { key: 'brakeSteer', step: 0.05, lo: 0.1, hi: 9 },
    { key: 'crest', step: 4, lo: 0, hi: 80 },
  ];

  const climb = (from: number) => {
    for (let scale = from; scale >= 0.24 && laps < maxLaps; scale /= 2) {
      let gained = true;
      while (gained && laps < maxLaps) {
        gained = false;
        // Global settings: step each knob up and down while it keeps paying.
        for (const k of knobs) {
          for (const dir of [1, -1]) {
            for (let n = 0; n < 6 && laps < maxLaps; n++) {
              const cur = best![k.key] as number;
              const next = clamp(cur + dir * k.step * scale, k.lo, k.hi);
              if (next === cur || !tryP({ ...best!, [k.key]: next })) break;
              gained = true;
            }
          }
        }
        if (best!.nitro === false && tryP({ ...best!, nitro: true })) gained = true;
        // Per-segment speed factors: only segments where a corner limit binds can matter.
        const plan = proPlan(lines.get(best!.width)!, S, { ...best!, seg: best!.seg.map(() => 1) });
        const binds = new Set<number>();
        const pts = lines.get(best!.width)!.points;
        for (let n = 0; n < pts.length; n++) if (plan[n] < 120) binds.add(Math.floor(pts[n].s / SEG_M));
        for (const i of [...binds].sort((a, b) => a - b)) {
          for (const dir of [1, -1]) {
            for (let n = 0; n < 5 && laps < maxLaps; n++) {
              const seg = best!.seg.slice();
              seg[i] = clamp(seg[i] + dir * 0.05 * scale, 0.6, 1.6);
              if (!tryP({ ...best!, seg })) break;
              gained = true;
            }
          }
        }
        log?.(`scale ${scale} pass: ${bestT} (${laps} laps)`);
      }
    }
  };
  climb(1);

  // Iterated local search: with laps left, kick a few settings off the best and climb again from there;
  // the kicked driver only replaces the best when its climb ends faster (tryP keeps the best throughout).
  let x = ((opts.seed ?? 0) * 40503 + 12345) >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296);
  while (laps < maxLaps) {
    const keep: ProParams = best!;
    const keepT = bestT;
    const kick: ProParams = { ...keep, seg: keep.seg.slice() };
    for (let n = 0; n < 4; n++) {
      const i = Math.floor(rnd() * kick.seg.length);
      kick.seg[i] = clamp(kick.seg[i] * (0.92 + rnd() * 0.16), 0.6, 1.6);
    }
    const k = knobs[Math.floor(rnd() * knobs.length)];
    (kick[k.key] as number) = clamp((kick[k.key] as number) + (rnd() - 0.5) * 2 * k.step, k.lo, k.hi);
    const t = lap(kick);
    if (t === null) continue;
    // Climb from the kicked driver as if it were the best, then keep whichever is faster.
    best = kick;
    bestT = t;
    climb(0.5);
    if (bestT >= keepT) {
      best = keep;
      bestT = keepT;
    }
  }
  return { params: best!, time: bestT, laps };
}

/** Drive a tuned lap and keep its ghost (null when the params no longer lap cleanly). */
export function proGhost(track: Track, vehicle: VehicleClass, p: ProParams): Ghost | null {
  const S = vehicleSpec(vehicle);
  const line = proLine(track, S, p.width);
  if (!line) return null;
  const pilot = new ProPilot(line, S, p);
  const race = new RaceSession(track, DEFAULT_ASSISTS, vehicle);
  const cap = Math.round(100 * (line.length / 8 + 10));
  for (let n = 0; n < cap + 200 && race.phase !== 'finished'; n++) {
    const ctl = race.phase === 'racing' ? quantise(pilot.controls(race)) : { steer: 0, gas: 0, brake: 0 };
    for (const e of race.step(ctl)) if (e.type === 'respawn' || e.type === 'missing') return null;
  }
  return race.phase === 'finished' ? race.ghost : null;
}
