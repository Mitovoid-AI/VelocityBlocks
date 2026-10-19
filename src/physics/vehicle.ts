// Fixed-step vehicle simulation: a rigid body on four ray-cast suspension points, slip-angle
// tyres, aero downforce, rear-wheel drive with traction control, ABS brakes, drift state,
// boost pads and impulse-based contacts.
// Pure TypeScript with no rendering dependencies so it runs identically in tests.

import { DT, GRAVITY, MAX_SPEED } from '../core/constants';
import {
  clamp,
  lerp,
  qcopy,
  qfromYawDir,
  qintegrate,
  qrotate,
  qrotateInv,
  v3,
  vcopy,
  vcross,
  vdot,
  vlen,
  type Quat,
  type V3,
} from '../core/vec';
import type { Track } from '../track/track';

export interface Controls {
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 */
  gas: number;
  /** 0..1 */
  brake: number;
}

export const NO_CONTROLS: Controls = { steer: 0, gas: 0, brake: 0 };

export interface CarState {
  pos: V3;
  vel: V3;
  rot: Quat;
  angVel: V3;
  steer: number;
  boostTime: number;
  boostPower: number;
  drift: number;
  comp: number[];
  contact: boolean[];
  wheelSpin: number;
  grounded: number;
  slip: number;
  onGrass: boolean;
  /** Cumulative distance the wheels rolled (for skid/smoke emitters). */
  odometer: number;
  /** Seconds since any wheel last touched a surface. */
  airTime: number;
  /**
   * Drive torque traction control cut this step because of cornering, 0..1 (HUD lamp, engine note).
   * Straight-line launches and drifts read 0: only "too much power for this corner" counts.
   */
  tc: number;
  /** Rear wheelspin this step, 0..1 (smoke, tyre noise; peaks near 0.33); only on the low traction-control setting. */
  spin: number;
  /** Share of the brake pedal ABS held back this step, 0..1 (brake chatter); not part of slip. */
  abs: number;
  /** Downforce this step as a multiple of the car's weight (camera, HUD, wind). */
  aero: number;
}

// ---- Tuning -----------------------------------------------------------------

const WHEELS: V3[] = [
  { x: 0.95, y: -0.15, z: 1.45 }, // front left (local +x is the driver's left)
  { x: -0.95, y: -0.15, z: 1.45 }, // front right
  { x: 0.95, y: -0.15, z: -1.35 }, // rear left
  { x: -0.95, y: -0.15, z: -1.35 }, // rear right
];
export const WHEEL_ANCHORS = WHEELS;
export const WHEEL_RADIUS = 0.36;
const REST = 0.45;
const RAY = REST + WHEEL_RADIUS;
const K_SPRING = 32;
const C_DAMP = 3.4;
const K_BUMP = 260;
const K_ANTIROLL = 26;
/** Fraction of the real (vertical) lever arm used for tyre forces. */
const TYRE_LEVER = 0.18;
/** Offset of the chassis hard stop below each wheel anchor. */
const HARD = RAY - REST - 0.08;

/** Body corner points used for hull contacts. */
const HULL: V3[] = [];
for (const x of [1.0, -1.0]) for (const y of [-0.3, 0.55]) for (const z of [2.25, -2.15]) HULL.push({ x, y, z });

/** Inverse inertia around local x (pitch), y (yaw), z (roll) for unit mass. */
const INV_I = { x: 1 / 2.4, y: 1 / 2.6, z: 1 / 1.6 };

const ADHESION = 34;
const REVERSE_MAX = 16;

// Tyres. Peak friction on asphalt; the front axle grips a little harder so the car turns in.
const MU_ROAD = 2.1;
const MU_FRONT = 1.1;
/** Slip angle (rad) where a tyre's sideways force peaks; the stiffer rear keeps the car stable. */
const PEAK_SLIP_F = 0.085;
const PEAK_SLIP_R = 0.075;
/**
 * Share of peak grip a front tyre keeps when it slides far past its peak slip angle (it washes out:
 * understeer). A sliding rear keeps all of its grip, so a slide stays catchable.
 */
const SLIDE_GRIP = 0.85;
/** Slip angle (in peaks) beyond which a tyre counts as sliding for smoke and squeal. */
const SLIP_SHOW = 1.3;
/** Low-speed lateral limit: never more than removes this much sideways velocity per second (the old model). */
const LAT_DAMP = (0.55 * 0.25) / DT;
/** Rear grip (sideways and for drive) lost at full drift. */
const DRIFT_GRIP = 0.62;

// Aero. Downforce per unit mass per (m/s)^2 of forward speed: equals the car's weight at 214 km/h and
// 2.2x at 330 km/h. It acts at the axles, through the springs, so it reaches the tyres only once.
const AERO_CL = 0.0034;
/** Share of the downforce on the front axle (a rearward balance keeps fast corners stable). */
const AERO_FRONT = 0.44;
const DRAG = 0.00026;

// Brakes (ABS): the pedal asks for up to BRAKE_MAX, each tyre gives at most ABS_LIMIT of the grip
// cornering leaves it.
const BRAKE_MAX = 52;
const BRAKE_FRONT = 0.6;
const ABS_LIMIT = 0.97;
/** Brake pedal above this while steering hard at speed starts a drift (the brake bar sends 0.55..1). */
export const DRIFT_BRAKE = 0.5;
/** Steering (the smoothed input, 0..1) beyond which the brake starts a drift. */
export const DRIFT_STEER = 0.35;
/** Brake deceleration while a brake tap starts a drift: the pre-downforce brakes, so the tap does not kill the slide. */
const DRIFT_BRAKE_DECEL = 24;

// Drive: rear wheels, locked axle. Traction control keeps the drive inside the rear tyres' grip
// left over from cornering: 'normal' just under it, 'low' a little over it, so the tail slides
// but can be caught.
const TC_LIMIT = { normal: 0.95, low: 1.2 } as const;
/**
 * In a drift both settings let the drive use all the grip that is left: normal eases off so the slide
 * keeps its speed, low tightens up because more power than that in a slide spins the car.
 */
const TC_DRIFT = 1.0;
/** Wheelspin (only past the tyres' grip, so only on 'low') would reach 1 this far over it; 'low' peaks at 0.33. */
const SPIN_RANGE = 0.6;
/** Grass digs in for drive (cornering grip there is still the surface grip), so a car can drive off it. */
const GRASS_TRACTION = 0.75;
/** Rolling resistance plus engine braking when coasting (m/s^2 at rest, growth per m/s). */
const COAST = 0.5;
const COAST_V = 0.012;
/** Pedal travel below this counts as released (trigger noise, a 1/255 input-log step). */
const PEDAL_EPS = 0.01;

// Steering: full lock at parking speed; at speed, what reaches the grip limit (see maxSteerAngle).
const STEER_LOCK = 0.52;
const STEER_GEO = 0.7;
const STEER_SLIP = 1.0;
const WHEELBASE = 2.8;
/** Measured fits for maxLatAccel: the share of grip the tyres reach, and the lock-limited loss at low speed. */
const LAT_REACH = 0.985;
const LAT_LOCK = 42;

/** Traction control setting. There is no "off": with digital pedals it is close to undriveable. */
export type TcLevel = keyof typeof TC_LIMIT;
export const TC_LEVELS: readonly TcLevel[] = ['normal', 'low'];

/** Driver aids for a run. Not part of the input log: a replay must use the same values. */
export interface Assists {
  readonly tc: TcLevel;
}
export const DEFAULT_ASSISTS: Readonly<Assists> = Object.freeze({ tc: 'normal' });
const LOW_TC: Readonly<Assists> = Object.freeze({ tc: 'low' });

/**
 * Assists for a player's settings. Auto-accelerate always drives with normal traction control:
 * full throttle held through every corner needs it. Unknown values (old saves) are normal.
 */
export function assistsFor(tc: string | undefined, autoAccelerate: boolean): Readonly<Assists> {
  return tc === 'low' && !autoAccelerate ? LOW_TC : DEFAULT_ASSISTS;
}

/**
 * Lateral tyre force as a share of the available grip, by slip angle over peak slip angle. `slide` is
 * the share left far past the peak (SLIDE_GRIP: a front tyre).
 */
export function tyreCurve(x: number, slide = SLIDE_GRIP): number {
  if (x <= 1) return x * (1.5 - 0.5 * x * x);
  return 1 - (1 - slide) * Math.min(1, (x - 1) / 2);
}

/** Flat-road tyre grip (m/s^2) at forward speed v: friction on weight plus downforce. */
export function gripAccel(v: number): number {
  return MU_ROAD * (GRAVITY + AERO_CL * v * v);
}

/**
 * Grass drag as a body force: rolling (m/s^2) plus quadratic (1/m) deceleration with a cap, scaled by
 * the wheels on grass. Tops out near 96 km/h, so cutting across it does not pay.
 * The cap only binds above about 166 km/h: a car that runs onto the grass at road speed loses it within
 * a second or so (250 -> 164 km/h with gas held), so short corner cuts cost time too.
 */
const GRASS_ROLL = 3;
const GRASS_DRAG = 0.0127;
const GRASS_MAX_DECEL = 30;
/** Car footprint (half-width, front and rear reach) for gate-post and pillar contacts; matches HULL. */
const FOOT_W = 1.0;
const FOOT_F = 2.25;
const FOOT_R = 2.15;

/**
 * Engine acceleration (m/s^2) by forward speed (m/s). Below about 100 km/h it is more than the rear
 * tyres can take, so launches are traction-limited.
 */
const ENGINE: [number, number][] = [
  [0, 22],
  [15, 20],
  [30, 16],
  [45, 11.5],
  [60, 8],
  [75, 5.2],
  [90, 2.6],
  [100, 1.4],
  [120, 0],
];

export const BOOST = { boost: { time: 1.0, power: 16 }, turbo: { time: 1.6, power: 26 } } as const;

/** Engine acceleration at forward speed v, before traction control and drag. */
export function engineAccel(v: number): number {
  if (v <= 0) return ENGINE[0][1];
  for (let n = 1; n < ENGINE.length; n++) {
    const [v1, a1] = ENGINE[n];
    if (v < v1) {
      const [v0, a0] = ENGINE[n - 1];
      return lerp(a0, a1, (v - v0) / (v1 - v0));
    }
  }
  return 0;
}

/**
 * Full-lock front wheel angle (rad) at forward speed v. At speed the lock shrinks to what puts the
 * front tyres just past their peak slip angle on the tightest grip-limited circle, so a digital
 * (touch, keyboard) full steer rides the grip limit instead of scrubbing far beyond it.
 */
export function maxSteerAngle(speed: number): number {
  const v = Math.abs(speed);
  const geo = (WHEELBASE * STEER_GEO * gripAccel(v)) / Math.max(1, v * v);
  return Math.min(STEER_LOCK, geo + STEER_SLIP * PEAK_SLIP_F);
}

/**
 * Steady cornering limit (m/s^2) on a flat road at speed v, as a skidpad measures it (best steering
 * input, speed held), within a few percent. Below about 100 km/h the steering lock, not the tyres,
 * sets it. For speed planners (the racing line); they keep their own safety margin.
 */
export function maxLatAccel(v: number): number {
  return gripAccel(v) * clamp(LAT_REACH - LAT_LOCK / Math.max(1, v * v), 0.25, 1);
}

/**
 * Straight-line full-brake deceleration (m/s^2) on a flat road at speed v, ABS and drag included.
 * Without a speed it is the low-speed (smallest) value.
 */
export function maxBrakeDecel(v = 0): number {
  const df = AERO_CL * v * v;
  // Each axle gives its share of the pedal, or what ABS lets its grip give (braking moves about 2% of
  // the weight forward, so each axle carries half of it).
  const front = Math.min(BRAKE_MAX * BRAKE_FRONT, ABS_LIMIT * MU_ROAD * MU_FRONT * (GRAVITY / 2 + df * AERO_FRONT));
  const rear = Math.min(BRAKE_MAX * (1 - BRAKE_FRONT), ABS_LIMIT * MU_ROAD * (GRAVITY / 2 + df * (1 - AERO_FRONT)));
  return front + rear + DRAG * v * v;
}

// ---- State helpers ------------------------------------------------------------

export function createCar(track: Track): CarState {
  const sp = track.spawn();
  // Settled ride height: CoM sits so each spring carries a quarter of the weight.
  const settle = (GRAVITY / 4) / K_SPRING;
  const y = sp.y + RAY - settle + 0.15;
  return {
    pos: v3(sp.x, y, sp.z),
    vel: v3(),
    rot: qfromYawDir(sp.hx, sp.hz),
    angVel: v3(),
    steer: 0,
    boostTime: 0,
    boostPower: 0,
    drift: 0,
    comp: [settle, settle, settle, settle],
    contact: [true, true, true, true],
    wheelSpin: 0,
    grounded: 4,
    slip: 0,
    onGrass: false,
    odometer: 0,
    airTime: 0,
    tc: 0,
    spin: 0,
    abs: 0,
    aero: 0,
  };
}

export function cloneCar(c: CarState): CarState {
  return {
    ...c,
    pos: vcopy(c.pos),
    vel: vcopy(c.vel),
    rot: qcopy(c.rot),
    angVel: vcopy(c.angVel),
    comp: c.comp.slice(),
    contact: c.contact.slice(),
  };
}

export function speedOf(c: CarState): number {
  return vlen(c.vel);
}

export function forwardOf(c: CarState): V3 {
  return qrotate(c.rot, { x: 0, y: 0, z: 1 });
}

export function upOf(c: CarState): V3 {
  return qrotate(c.rot, { x: 0, y: 1, z: 0 });
}

export function triggerBoost(c: CarState, kind: keyof typeof BOOST): void {
  const b = BOOST[kind];
  c.boostTime = b.time;
  c.boostPower = b.power;
}

// ---- Simulation step ------------------------------------------------------------

/** Apply world-space inverse inertia to a world-space torque/impulse. */
function invInertia(rot: Quat, t: V3): V3 {
  const l = qrotateInv(rot, t);
  return qrotate(rot, { x: l.x * INV_I.x, y: l.y * INV_I.y, z: l.z * INV_I.z });
}

function applyImpulse(c: CarState, r: V3, j: V3): void {
  c.vel.x += j.x;
  c.vel.y += j.y;
  c.vel.z += j.z;
  const dw = invInertia(c.rot, vcross(r, j));
  c.angVel.x += dw.x;
  c.angVel.y += dw.y;
  c.angVel.z += dw.z;
}

function pointVel(c: CarState, r: V3): V3 {
  const w = vcross(c.angVel, r);
  return { x: c.vel.x + w.x, y: c.vel.y + w.y, z: c.vel.z + w.z };
}

/** Resolve a contact at offset r (from CoM) with normal n; returns the applied normal impulse. */
function resolveContact(c: CarState, r: V3, n: V3, restitution: number, friction: number): number {
  const vp = pointVel(c, r);
  const vn = vdot(vp, n);
  if (vn >= 0) return 0;
  const rn = vcross(r, n);
  const k = 1 + vdot(n, vcross(invInertia(c.rot, rn), r));
  const jn = (-(1 + restitution) * vn) / k;
  applyImpulse(c, r, { x: n.x * jn, y: n.y * jn, z: n.z * jn });
  // Coulomb friction on the tangential part.
  const vp2 = pointVel(c, r);
  const vn2 = vdot(vp2, n);
  const vt = { x: vp2.x - n.x * vn2, y: vp2.y - n.y * vn2, z: vp2.z - n.z * vn2 };
  const vtl = vlen(vt);
  if (vtl > 1e-6 && friction > 0) {
    const t = { x: vt.x / vtl, y: vt.y / vtl, z: vt.z / vtl };
    const rt = vcross(r, t);
    const kt = 1 + vdot(t, vcross(invInertia(c.rot, rt), r));
    const jt = Math.min(vtl / kt, friction * jn);
    applyImpulse(c, r, { x: -t.x * jt, y: -t.y * jt, z: -t.z * jt });
  }
  return jn;
}

/** One grounded wheel between the passes of stepCar. */
interface Tyre {
  front: boolean;
  /** Spring force: the tyre load (downforce reaches it through the springs). */
  fs: number;
  r: V3;
  wf: V3;
  ws: V3;
  vLong: number;
  fLat: number;
  fLong: number;
  /** Sideways grip. */
  maxF: number;
  /** Drive traction (grass digs in, so it is nearly road-like there). */
  tract: number;
  /** Friction circle radius used for the final clamp. */
  circle: number;
}

export interface StepEvents {
  /** Strongest hull/wall impact speed this step (for sound/camera shake). */
  impact: number;
}

export function stepCar(c: CarState, ctl: Controls, track: Track, assists: Readonly<Assists> = DEFAULT_ASSISTS): StepEvents {
  const dt = DT;
  const events: StepEvents = { impact: 0 };

  // Steering input smoothing (keyboard friendly, also smooths touch).
  const target = clamp(ctl.steer, -1, 1);
  const rate = Math.abs(target) < Math.abs(c.steer) || Math.sign(target) !== Math.sign(c.steer) ? 9 : 5;
  c.steer += clamp(target - c.steer, -rate * dt, rate * dt);

  // Analog pedals; a hair of travel is released, so trigger noise never stops the car coasting.
  const gas = ctl.gas >= PEDAL_EPS ? Math.min(1, ctl.gas) : 0;
  const brake = ctl.brake >= PEDAL_EPS ? Math.min(1, ctl.brake) : 0;

  const fwd = qrotate(c.rot, { x: 0, y: 0, z: 1 });
  const up = qrotate(c.rot, { x: 0, y: 1, z: 0 });
  const right = vcross(fwd, up);
  const speedF = vdot(c.vel, fwd);
  const speed = vlen(c.vel);

  const force: V3 = { x: 0, y: -GRAVITY, z: 0 };
  const torque: V3 = { x: 0, y: 0, z: 0 };

  // Drift: brake while steering hard at speed breaks rear traction.
  const wantsDrift = brake > DRIFT_BRAKE && Math.abs(c.steer) > DRIFT_STEER && speedF > 18 && c.grounded >= 2;
  if (wantsDrift) c.drift = Math.min(1, c.drift + dt * 6);
  else if (Math.abs(c.steer) < 0.2 || speedF < 12) c.drift = Math.max(0, c.drift - dt * 2.5);
  else c.drift = Math.max(0, c.drift - dt * 0.35);

  const delta = c.steer * maxSteerAngle(speedF);
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);

  let grounded = 0;
  let grassWheels = 0;
  let slipSum = 0;
  let tcCut = 0;
  let spin = 0;
  const vAero = Math.max(0, speedF);
  const downforce = AERO_CL * vAero * vAero;
  const engine = engineAccel(speedF);
  const braking = brake > 0 && speedF > 0.8;
  const reversing = brake > 0 && !braking && speedF > -REVERSE_MAX;
  const driving = gas > 0 && !(brake > 0 && speedF <= 0.8);
  const coasting = gas === 0 && brake === 0;

  // Pass 1: suspension, contact frame and the tyres' sideways force for every wheel.
  const tyres: (Tyre | null)[] = [null, null, null, null];
  for (let w = 0; w < 4; w++) {
    const r0 = qrotate(c.rot, WHEELS[w]);
    const ax = c.pos.x + r0.x, ay = c.pos.y + r0.y, az = c.pos.z + r0.z;
    let comp = 0;
    let hit = null;
    if (up.y > 0.15) {
      hit = track.surfaceAt(ax, ay, az, 1.0);
      const n = { x: hit.nx, y: hit.ny, z: hit.nz };
      const den = vdot(up, n);
      if (den > 0.2) {
        // Distance along -up from the anchor to the surface plane.
        // The surface plane passes through (ax, hit.y, az).
        const dist = ((ay - hit.y) * n.y) / den;
        comp = RAY - dist;
      }
    }
    if (!hit || comp <= 0) {
      c.comp[w] = Math.max(0, c.comp[w] - dt * 3);
      c.contact[w] = false;
      continue;
    }
    comp = Math.min(comp, RAY);
    const compVel = (comp - c.comp[w]) / dt;
    c.comp[w] = comp;
    c.contact[w] = true;
    grounded++;
    if (!hit.road) grassWheels++;

    let fs = K_SPRING * comp + C_DAMP * compVel;
    if (comp > REST) fs += K_BUMP * (comp - REST);
    // Anti-roll bar: resist compression differences across the axle.
    const other = w ^ 1;
    fs += K_ANTIROLL * (comp - c.comp[other]);
    fs = Math.max(0, fs);
    const n = { x: hit.nx, y: hit.ny, z: hit.nz };
    const dist = RAY - comp;
    const r = { x: r0.x - up.x * dist, y: r0.y - up.y * dist, z: r0.z - up.z * dist };

    // Tyre frame on the contact plane.
    const front = w < 2;
    let wf = front
      ? { x: fwd.x * cosD + right.x * sinD, y: fwd.y * cosD + right.y * sinD, z: fwd.z * cosD + right.z * sinD }
      : fwd;
    const wfn = vdot(wf, n);
    wf = { x: wf.x - n.x * wfn, y: wf.y - n.y * wfn, z: wf.z - n.z * wfn };
    const wfl = vlen(wf) || 1;
    wf = { x: wf.x / wfl, y: wf.y / wfl, z: wf.z / wfl };
    const ws = vcross(wf, n);

    const vp = pointVel(c, r);
    const vLong = vdot(vp, wf);
    const vLat = vdot(vp, ws);

    // Tyre load is the spring force alone: downforce reaches it through the springs (no double count).
    const maxF = MU_ROAD * hit.grip * (front ? MU_FRONT : 1 - DRIFT_GRIP * c.drift) * fs;
    // Lateral: slip-angle tyre (progressive at speed), never more than removes the sideways velocity
    // this step (the old model), which keeps parking speeds stable.
    const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), 1));
    const peak = front ? PEAK_SLIP_F : PEAK_SLIP_R;
    const fLat = -Math.sign(vLat) * Math.min(Math.abs(vLat) * LAT_DAMP, maxF * tyreCurve(alpha / peak, front ? SLIDE_GRIP : 1));
    // Past the peak the tyre is sliding: smoke and squeal.
    if (alpha > peak * SLIP_SHOW && maxF > 0.5) slipSum += Math.min(1, (alpha / peak - SLIP_SHOW) / 1.5);
    const tract = MU_ROAD * Math.max(hit.grip, GRASS_TRACTION) * (front ? MU_FRONT : 1 - DRIFT_GRIP * c.drift) * fs;
    tyres[w] = { front, fs, r, wf, ws, vLong, fLat, fLong: 0, maxF, tract, circle: maxF };
  }

  // Pass 2: drive on the rear axle (both wheels share it, like a locked differential).
  if (driving) {
    const want = engine * gas;
    let cap = 0;
    let room = 0;
    for (const t of tyres) {
      if (!t || t.front) continue;
      cap += t.tract;
      room += Math.sqrt(Math.max(0, t.tract * t.tract - t.fLat * t.fLat));
    }
    if (cap > 0) {
      // Traction control: no more drive than the grip cornering leaves ('low' allows a little over it).
      const base = TC_LIMIT[assists.tc] ?? TC_LIMIT.normal;
      const level = lerp(base, TC_DRIFT, clamp((c.drift - 0.2) / 0.3, 0, 1));
      const lim = level * room;
      const drive = Math.min(want, lim);
      // The lamp reads the cut cornering causes; a launch is limited by straight-line grip anyway,
      // and a drift is meant to slide.
      if (want > lim && c.drift <= 0.2) tcCut = 1 - lim / Math.min(want, level * cap);
      // Wheelspin past the tyres' grip ('low' only).
      const s = room > 0 ? clamp((drive / room - 1) / SPIN_RANGE, 0, 1) : 0;
      spin = s;
      for (const t of tyres) {
        if (!t || t.front) continue;
        t.fLong = (drive * t.tract) / cap;
        t.circle = Math.max(t.maxF, t.tract);
        if (s > 0) {
          // A spinning tyre's friction circle trims its sideways force along with the drive: the
          // tail steps out by as much as the throttle is over the grip (power oversteer).
          const over = Math.hypot(t.fLat, t.fLong) / t.tract;
          if (over > 1) {
            t.fLat /= over;
            t.fLong /= over;
          }
        }
      }
    }
  }

  // Pass 3: brakes, coasting, the friction circle, and the forces on the body.
  // A brake tap that starts a drift gets the old pre-downforce brakes, so the slide keeps its speed.
  // From the tick steer + brake go down (the raw input), not ~70 ms later when the smoothed steering
  // passes DRIFT_STEER: keys and touch buttons press both at once.
  const tapping =
    brake > DRIFT_BRAKE && Math.max(Math.abs(c.steer), Math.abs(target)) > DRIFT_STEER && speedF > 18 && c.grounded >= 2;
  const brakeMax = tapping ? DRIFT_BRAKE_DECEL : BRAKE_MAX;
  let absWant = 0;
  let absHeld = 0;
  for (const t of tyres) {
    if (!t) continue;
    const { front, fs, r, wf, ws, vLong, maxF, circle } = t;
    let { fLat, fLong } = t;
    if (braking) {
      // ABS: the pedal asks for its share of brakeMax; the tyre gives what its grip has left after
      // cornering, so the car still steers under braking.
      const want = brakeMax * (front ? BRAKE_FRONT : 1 - BRAKE_FRONT) * 0.5 * brake;
      const lim = ABS_LIMIT * Math.sqrt(Math.max(0, maxF * maxF - fLat * fLat));
      absWant += want;
      if (want > lim) absHeld += want - lim;
      fLong -= Math.min(want, lim) * Math.sign(vLong || 1);
    } else if (reversing) {
      fLong -= 9 * 0.25 * brake;
    }
    if (coasting) {
      // Rolling resistance and engine braking (on the driven rear axle); holds the car still at very low speed.
      const coast = (COAST + COAST_V * Math.abs(vLong)) * 0.25 * (front ? 0.5 : 1.5);
      fLong += Math.abs(vLong) < 0.6 ? -vLong * (0.25 / dt) * 0.3 : -Math.sign(vLong) * coast;
    }

    const tot = Math.sqrt(fLat * fLat + fLong * fLong);
    if (tot > circle) {
      const s = circle / tot;
      slipSum += Math.min(1, (tot - circle) / (circle + 1));
      fLat *= s;
      fLong *= s;
    }
    if (c.drift > 0.2 && !front) slipSum += c.drift * 0.5;

    // Suspension force along the car's up axis.
    const fx = up.x * fs, fy = up.y * fs, fz = up.z * fs;
    const tx = wf.x * fLong + ws.x * fLat;
    const ty = wf.y * fLong + ws.y * fLat;
    const tz = wf.z * fLong + ws.z * fLat;
    force.x += fx + tx;
    force.y += fy + ty;
    force.z += fz + tz;
    // Suspension acts at the contact point; tyre forces act close to CoM height,
    // which keeps load transfer (and roll-overs) arcade-friendly.
    const ts = vcross(r, { x: fx, y: fy, z: fz });
    const ru = vdot(r, up) * TYRE_LEVER;
    const rt = { x: r.x - up.x * vdot(r, up) + up.x * ru, y: r.y - up.y * vdot(r, up) + up.y * ru, z: r.z - up.z * vdot(r, up) + up.z * ru };
    const tt = vcross(rt, { x: tx, y: ty, z: tz });
    torque.x += ts.x + tt.x;
    torque.y += ts.y + tt.y;
    torque.z += ts.z + tt.z;
  }

  c.grounded = grounded;
  c.onGrass = grassWheels >= 2;
  // Sliding tyres and wheelspin only: ABS and traction control have their own signals.
  c.slip = grounded ? clamp((slipSum + spin) / 2, 0, 1) : 0;
  c.tc = tcCut;
  c.spin = spin;
  c.abs = absWant > 0 ? absHeld / absWant : 0;

  c.airTime = grounded > 0 ? 0 : c.airTime + dt;

  // Road adhesion: over crests the car hugs the deck as long as road continues below it.
  // Jump lips end the road, so ramps still launch the car.
  if (grounded < 4 && c.airTime < 0.25 && up.y > 0.5) {
    const under = track.surfaceAt(c.pos.x, c.pos.y, c.pos.z, 0.5);
    const gap = c.pos.y - under.y;
    if (under.road && gap < 2.2) {
      const a = ADHESION * (1 - c.airTime / 0.25);
      force.x -= under.nx * a;
      force.y -= under.ny * a;
      force.z -= under.nz * a;
    }
  }

  if (grounded > 0) {
    // Downforce pushes the car into the track at the axles (aero balance), through the springs into the tyres.
    const df = downforce * (grounded / 4);
    c.aero = df / GRAVITY;
    for (const [z, share] of [[1.45, AERO_FRONT], [-1.35, 1 - AERO_FRONT]] as const) {
      const f = df * share;
      const ra = qrotate(c.rot, { x: 0, y: -0.15, z });
      const fa = { x: -up.x * f, y: -up.y * f, z: -up.z * f };
      force.x += fa.x;
      force.y += fa.y;
      force.z += fa.z;
      const ta = vcross(ra, fa);
      torque.x += ta.x;
      torque.y += ta.y;
      torque.z += ta.z;
    }
    // Drift yaw assist: keeps a committed slide rotating with the steering.
    if (c.drift > 0) {
      const yaw = c.steer * c.drift * 3.2;
      torque.x -= up.x * yaw;
      torque.y -= up.y * yaw;
      torque.z -= up.z * yaw;
    }
  } else {
    // Airborne: gentle roll levelling and nose alignment with the flight path (and no downforce,
    // so jumps keep their length).
    c.aero = 0;
    const worldUp = { x: 0, y: 1, z: 0 };
    const rollErr = vdot(vcross(up, worldUp), fwd);
    const rollT = rollErr * 3.0;
    torque.x += fwd.x * rollT;
    torque.y += fwd.y * rollT;
    torque.z += fwd.z * rollT;
    if (speed > 5) {
      const vd = { x: c.vel.x / speed, y: c.vel.y / speed, z: c.vel.z / speed };
      const pitchErr = vdot(vcross(fwd, vd), right);
      const pT = pitchErr * 1.2;
      torque.x += right.x * pT;
      torque.y += right.y * pT;
      torque.z += right.z * pT;
    }
  }

  // Grass drag: a body force, so it slows the car without using up steering grip.
  if (grassWheels > 0) {
    const vh = Math.hypot(c.vel.x, c.vel.z);
    if (vh > 0.05) {
      const decel = Math.min(GRASS_MAX_DECEL, GRASS_ROLL + GRASS_DRAG * vh * vh) * (grassWheels / 4);
      // Never more than stops the car this tick, so it cannot push it backwards.
      const k = Math.min(decel, vh / dt) / vh;
      force.x -= c.vel.x * k;
      force.z -= c.vel.z * k;
    }
  }

  // Boost pads.
  if (c.boostTime > 0) {
    const frac = c.boostTime / (c.boostPower > 20 ? BOOST.turbo.time : BOOST.boost.time);
    const a = c.boostPower * (0.35 + 0.65 * frac);
    force.x += fwd.x * a;
    force.y += fwd.y * a;
    force.z += fwd.z * a;
    c.boostTime = Math.max(0, c.boostTime - dt);
  }

  // Aerodynamic drag.
  force.x -= c.vel.x * speed * DRAG;
  force.y -= c.vel.y * speed * DRAG;
  force.z -= c.vel.z * speed * DRAG;

  // Integrate velocities.
  c.vel.x += force.x * dt;
  c.vel.y += force.y * dt;
  c.vel.z += force.z * dt;
  const dw = invInertia(c.rot, torque);
  c.angVel.x += dw.x * dt;
  c.angVel.y += dw.y * dt;
  c.angVel.z += dw.z * dt;
  const angDamp = grounded > 0 ? 1 - 2.2 * dt : 1 - 0.6 * dt;
  c.angVel.x *= angDamp;
  c.angVel.y *= angDamp;
  c.angVel.z *= angDamp;

  // Hull contacts with the ground/road surface.
  let maxPen = 0;
  for (const h of HULL) {
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const s = track.surfaceAt(px, py, pz, 1.6);
    const pen = s.y - py;
    if (pen > 0) {
      const n = { x: s.nx, y: s.ny, z: s.nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.05, 0.45);
      events.impact = Math.max(events.impact, -before);
      maxPen = Math.max(maxPen, pen);
    }
  }
  // Wheel hard points stop the chassis sinking through the deck on big landings.
  for (let w = 0; w < 4; w++) {
    const r0 = qrotate(c.rot, WHEELS[w]);
    const r = { x: r0.x - up.x * HARD, y: r0.y - up.y * HARD, z: r0.z - up.z * HARD };
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const s = track.surfaceAt(px, py, pz, 1.6);
    const pen = s.y - py;
    if (pen > 0) {
      const n = { x: s.nx, y: s.ny, z: s.nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.0, 0.0);
      events.impact = Math.max(events.impact, -before);
      maxPen = Math.max(maxPen, pen);
    }
  }

  // Barrier contacts.
  let pushX = 0, pushZ = 0;
  for (const h of HULL) {
    if (h.y > 0) continue;
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y + 0.3, pz = c.pos.z + r.z;
    const wh = track.wallAt(px, py, pz);
    if (!wh) continue;
    const n = { x: wh.nx, y: 0, z: wh.nz };
    const before = vdot(pointVel(c, r), n);
    resolveContact(c, r, n, 0.12, 0.12);
    events.impact = Math.max(events.impact, -before);
    if (Math.abs(pushX) < Math.abs(wh.nx * wh.depth)) pushX = wh.nx * wh.depth;
    if (Math.abs(pushZ) < Math.abs(wh.nz * wh.depth)) pushZ = wh.nz * wh.depth;
  }

  // Embankment faces: slopes and ramps rising from the floor are solid from the side and the high end.
  for (const h of HULL) {
    if (h.y > 0) continue;
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const wh = track.sideAt(px, py, pz);
    if (!wh) continue;
    const n = { x: wh.nx, y: 0, z: wh.nz };
    const before = vdot(pointVel(c, r), n);
    resolveContact(c, r, n, 0.1, 0.2);
    events.impact = Math.max(events.impact, -before);
    if (Math.abs(pushX) < Math.abs(wh.nx * wh.depth)) pushX = wh.nx * wh.depth;
    if (Math.abs(pushZ) < Math.abs(wh.nz * wh.depth)) pushZ = wh.nz * wh.depth;
  }

  // Gate posts and pillars: vertical cylinders against the car's footprint rectangle.
  const cols = track.columnsNear(c.pos.x, c.pos.z);
  const fh = Math.hypot(fwd.x, fwd.z);
  if (cols && fh > 0.3) {
    const fx = fwd.x / fh, fz = fwd.z / fh;
    const rx = -fz, rz = fx;
    for (const col of cols) {
      if (c.pos.y + 0.8 < col.y0 || c.pos.y - 0.6 > col.y1) continue;
      const dx = col.x - c.pos.x, dz = col.z - c.pos.z;
      const lf = dx * fx + dz * fz, lr = dx * rx + dz * rz;
      // Closest point of the footprint to the column centre.
      const cf = clamp(lf, -FOOT_R, FOOT_F), cr = clamp(lr, -FOOT_W, FOOT_W);
      const ef = lf - cf, er = lr - cr;
      const d = Math.hypot(ef, er);
      let nx: number, nz: number, depth: number;
      if (d > 1e-6) {
        if (d >= col.r) continue;
        nx = -(ef * fx + er * rx) / d;
        nz = -(ef * fz + er * rz) / d;
        depth = col.r - d;
      } else {
        // Centre inside the footprint: push out along the shallower axis.
        const pf = lf >= 0 ? FOOT_F - lf : lf + FOOT_R;
        const pr = FOOT_W - Math.abs(lr);
        if (pr < pf) {
          const sg = lr >= 0 ? -1 : 1;
          nx = rx * sg;
          nz = rz * sg;
          depth = pr + col.r;
        } else {
          const sg = lf >= 0 ? -1 : 1;
          nx = fx * sg;
          nz = fz * sg;
          depth = pf + col.r;
        }
      }
      const r = { x: cf * fx + cr * rx, y: 0, z: cf * fz + cr * rz };
      const n = { x: nx, y: 0, z: nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.15, 0.2);
      events.impact = Math.max(events.impact, -before);
      if (Math.abs(pushX) < Math.abs(nx * depth)) pushX = nx * depth;
      if (Math.abs(pushZ) < Math.abs(nz * depth)) pushZ = nz * depth;
    }
  }

  // Speed cap.
  const sp = vlen(c.vel);
  if (sp > MAX_SPEED) {
    const k = MAX_SPEED / sp;
    c.vel.x *= k;
    c.vel.y *= k;
    c.vel.z *= k;
  }

  // Integrate positions.
  c.pos.x += c.vel.x * dt + pushX;
  c.pos.y += c.vel.y * dt + maxPen * 0.8;
  c.pos.z += c.vel.z * dt + pushZ;
  c.rot = qintegrate(c.rot, c.angVel, dt);

  const fwdSpeed = vdot(c.vel, fwd);
  c.wheelSpin += (fwdSpeed * dt) / WHEEL_RADIUS;
  c.odometer += Math.abs(fwdSpeed) * dt;
  return events;
}
