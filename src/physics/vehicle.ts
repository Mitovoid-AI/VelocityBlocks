// Fixed-step vehicle simulation: a rigid body on four ray-cast suspension points, slip-angle
// tyres, aero downforce, rear-wheel drive with traction control, ABS brakes, drift state,
// boost pads, nitro and impulse-based contacts. Every vehicle class (Car, Bike, Truck) runs the same
// model with its own VehicleSpec; the Car's numbers are the physics v6 car, bit for bit (v7 only added the nitro).
// Pure TypeScript with no rendering dependencies so it runs identically in tests.

import { DT, GRAVITY, MAX_SPEED, ROAD_HALF, TICK_HZ } from '../core/constants';
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
import { isVehicleClass, type VehicleClass } from '../core/vehicles';
import type { Track } from '../track/track';

export interface Controls {
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 */
  gas: number;
  /** 0..1 */
  brake: number;
  /**
   * Nitro asked for on this tick: it fires when it is ready (charged, nothing pushing, brake up) and is
   * ignored otherwise, so a held button fires again as soon as it has recharged. See NITRO_TIME.
   */
  nitro?: boolean;
}

export const NO_CONTROLS: Controls = { steer: 0, gas: 0, brake: 0 };

export interface CarState {
  /** Vehicle class: stepCar drives it with that class's VehicleSpec. */
  vehicle: VehicleClass;
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
  /** Seconds of nitro push left (0 = not boosting), in whole ticks. */
  nitroTime: number;
  /** Seconds until the nitro is ready again (0 = ready), in whole ticks; it starts counting when a boost ends. */
  nitroCooldown: number;
}

// ---- Vehicle classes ----------------------------------------------------------

/**
 * Everything that makes one vehicle class drive the way it does. Every class has four suspension rays
 * (the Bike too: its rays sit on an invisible car-length footprint, and its lean is drawn only), so the
 * race, ghost and render code treat all classes alike.
 */
export interface VehicleSpec {
  readonly vehicle: VehicleClass;
  /** Suspension ray anchors in the body frame, FL, FR, RL, RR (+x is the driver's left). */
  readonly wheels: readonly Readonly<V3>[];
  readonly wheelRadius: number;
  /** Suspension rest length. */
  readonly rest: number;
  /** Ray length: suspension rest length plus wheel radius. */
  readonly ray: number;
  /** Offset of the chassis hard stop below each wheel anchor. */
  readonly hard: number;
  /** Settled height of the body centre above a flat road (at rest, no downforce). */
  readonly rideHeight: number;
  readonly kSpring: number;
  readonly cDamp: number;
  readonly kBump: number;
  readonly kAntiroll: number;
  /** Fraction of the real (vertical) lever arm used for tyre forces (keeps load transfer arcade-like). */
  readonly tyreLever: number;
  /** Body corner points for hull contacts: x of [+x, -x], then y of [low, high], then z of [front, rear]. */
  readonly hull: readonly Readonly<V3>[];
  /** Inverse inertia around local x (pitch), y (yaw), z (roll) for unit mass. */
  readonly invI: Readonly<V3>;
  /** Peak tyre friction on asphalt, and the front axle's extra share (it turns in). */
  readonly muRoad: number;
  readonly muFront: number;
  /** Slip angle (rad) where a tyre's sideways force peaks. */
  readonly peakSlipF: number;
  readonly peakSlipR: number;
  /** Share of peak grip a front tyre keeps sliding far past its peak (understeer). */
  readonly slideGrip: number;
  /** Rear grip (sideways and for drive) lost at full drift. */
  readonly driftGrip: number;
  /** A brake tap while steering hard at speed starts a drift (the Bike and the Truck grip instead). */
  readonly brakeDrift: boolean;
  /**
   * Landing assist: with every wheel off the ground the front wheels straighten whatever the input, so a
   * steering button held through a jump does not land the vehicle at full lock.
   */
  readonly airStraighten: boolean;
  /** Downforce per unit mass per (m/s)^2 of forward speed, its front share, and drag. */
  readonly aeroCl: number;
  readonly aeroFront: number;
  readonly drag: number;
  /** Brakes: deceleration the pedal asks for, front share, and the pre-downforce brakes of a drift tap. */
  readonly brakeMax: number;
  readonly brakeFront: number;
  readonly driftBrakeDecel: number;
  /** Engine acceleration (m/s^2) by forward speed (m/s), before traction control and drag. */
  readonly engine: readonly (readonly [number, number])[];
  readonly reverseMax: number;
  /** Steering: full lock at parking speed; at speed, what reaches the grip limit (see maxSteerAngle). */
  readonly steerLock: number;
  readonly steerGeo: number;
  readonly steerSlip: number;
  readonly wheelbase: number;
  /**
   * maxLatAccel's model: the share of grip the tyres reach (latReach) less the lock-limited loss at low
   * speed (latLock / v^2), fitted to the skidpad; or, when set, latTable: the measured share every
   * LAT_TABLE_STEP m/s from 0 (scripts/handling-bench.ts fit), interpolated.
   */
  readonly latReach: number;
  readonly latLock: number;
  readonly latTable?: readonly number[];
  /** Steering input rates (1/s): towards a bigger lock, and back towards straight (or across). */
  readonly steerApply: number;
  readonly steerRelease: number;
  /** The same with the analog steering assist (tilt and the on-screen wheel). */
  readonly steerApplyAnalog: number;
  readonly steerReleaseAnalog: number;
  /** Footprint (half-width, front and rear reach) for gate-post and pillar contacts; matches the hull. */
  readonly foot: { readonly w: number; readonly f: number; readonly r: number };
  /** Drift yaw assist, and the airborne roll levelling and nose alignment. */
  readonly driftYaw: number;
  readonly airRoll: number;
  readonly airPitch: number;
  /** Barrier probes sit this far above the low hull points (about 0.87 m above the deck at rest for every class). */
  readonly wallProbe: number;
  /** Height of the body centre above a checkpoint's deck when respawned there. */
  readonly respawnY: number;
}

/** Sample spacing (m/s) of VehicleSpec.latTable. */
export const LAT_TABLE_STEP = 5;

type SpecInput = Omit<VehicleSpec, 'ray' | 'hard' | 'rideHeight' | 'wheelbase' | 'respawnY'> & { respawnY?: number };

/** Builds a spec: ray, hard stop, wheelbase and settled ride height follow from the geometry. */
function spec(s: SpecInput): VehicleSpec {
  const ray = s.rest + s.wheelRadius;
  const rideHeight = ray - GRAVITY / 4 / s.kSpring - s.wheels[0].y;
  return Object.freeze({
    ...s,
    ray,
    hard: ray - s.rest - 0.08,
    rideHeight,
    wheelbase: s.wheels[0].z - s.wheels[2].z,
    respawnY: s.respawnY ?? rideHeight + 0.035,
  });
}

/** Ray anchors FL, FR, RL, RR at half-track x, height y, axles at zf and zr. */
function wheelsOf(x: number, y: number, zf: number, zr: number): V3[] {
  return [
    { x, y, z: zf }, // front left (local +x is the driver's left)
    { x: -x, y, z: zf }, // front right
    { x, y, z: zr }, // rear left
    { x: -x, y, z: zr }, // rear right
  ];
}

/** The 8 hull corners in the order impacts and push-outs depend on: x of [+x, -x], y of [y0, y1], z of [zf, zr]. */
function hullOf(x: number, y0: number, y1: number, zf: number, zr: number): V3[] {
  const out: V3[] = [];
  for (const xx of [x, -x]) for (const y of [y0, y1]) for (const z of [zf, zr]) out.push({ x: xx, y, z });
  return out;
}

/** The Car: physics v6, unchanged under v7 without the nitro (records, ghosts, author times and racing lines depend on every digit). */
export const CAR: VehicleSpec = spec({
  vehicle: 'car',
  wheels: wheelsOf(0.95, -0.15, 1.45, -1.35),
  wheelRadius: 0.36,
  rest: 0.45,
  kSpring: 32,
  cDamp: 3.4,
  kBump: 260,
  kAntiroll: 26,
  tyreLever: 0.18,
  hull: hullOf(1.0, -0.3, 0.55, 2.25, -2.15),
  invI: { x: 1 / 2.4, y: 1 / 2.6, z: 1 / 1.6 },
  // Tyres. Peak friction on asphalt; the front axle grips a little harder so the car turns in.
  muRoad: 2.1,
  muFront: 1.1,
  // The stiffer rear keeps the car stable.
  peakSlipF: 0.085,
  peakSlipR: 0.075,
  // A sliding front washes out (understeer); a sliding rear keeps all of its grip, so a slide stays catchable.
  slideGrip: 0.85,
  driftGrip: 0.62,
  brakeDrift: true,
  airStraighten: false,
  // Aero: downforce equals the car's weight at 214 km/h and 2.2x at 330 km/h. It acts at the axles,
  // through the springs, so it reaches the tyres only once. A rearward balance keeps fast corners stable.
  aeroCl: 0.0034,
  aeroFront: 0.44,
  drag: 0.00026,
  brakeMax: 52,
  brakeFront: 0.6,
  // A brake tap that starts a drift gets the pre-downforce brakes, so the tap does not kill the slide.
  driftBrakeDecel: 24,
  // Below about 100 km/h the engine is more than the rear tyres can take, so launches are traction-limited.
  engine: [
    [0, 22],
    [15, 20],
    [30, 16],
    [45, 11.5],
    [60, 8],
    [75, 5.2],
    [90, 2.6],
    [100, 1.4],
    [120, 0],
  ],
  reverseMax: 16,
  steerLock: 0.52,
  steerGeo: 0.7,
  steerSlip: 1.0,
  latReach: 0.985,
  latLock: 42,
  steerApply: 5,
  steerRelease: 9,
  steerApplyAnalog: 10,
  steerReleaseAnalog: 14,
  foot: { w: 1.0, f: 2.25, r: 2.15 },
  driftYaw: 3.2,
  airRoll: 3.0,
  airPitch: 1.2,
  wallProbe: 0.3,
  respawnY: 0.9,
});

/**
 * The Bike: four rays on an invisible car-length footprint (2.7 m wheelbase, 0.55 m half-track; a real
 * bike's 1.5 m wheelbase bounced and tumbled on jump landings and barrier hits), a narrow hull, light
 * downforce and the quickest steering. It never brake-drifts: a brake tap with the steering held just
 * brakes, so phone players cannot spin it, and its stiff rear tyres keep the tail planted over crests.
 */
export const BIKE: VehicleSpec = spec({
  vehicle: 'bike',
  wheels: wheelsOf(0.55, -0.15, 1.4, -1.3),
  wheelRadius: 0.33,
  rest: 0.4,
  kSpring: 34,
  cDamp: 3.6,
  kBump: 260,
  kAntiroll: 30,
  tyreLever: 0.09,
  // The hull reaches the ray anchors: no front ray finds a low deck over an added barrier before the hull meets
  // it, and a nose-first landing (A11's second jump) meets the deck over the rays, not behind them.
  hull: hullOf(0.45, -0.3, 0.9, 1.45, -1.35),
  // The car's pitch and yaw inertia: a lighter yaw weaved itself into the barriers at 180 km/h downhill.
  invI: { x: 1 / 2.4, y: 1 / 2.6, z: 1 / 0.9 },
  muRoad: 1.95,
  muFront: 1.1,
  peakSlipF: 0.085,
  peakSlipR: 0.065,
  slideGrip: 0.85,
  driftGrip: 0.62,
  brakeDrift: false,
  airStraighten: false,
  aeroCl: 0.001,
  aeroFront: 0.5,
  drag: 0.0003,
  brakeMax: 44,
  brakeFront: 0.7,
  driftBrakeDecel: 22,
  engine: [
    [0, 24],
    [15, 22],
    [30, 17],
    [45, 12],
    [60, 8],
    [75, 4.6],
    [85, 2.0],
    [95, 0],
  ],
  reverseMax: 8,
  steerLock: 0.6,
  steerGeo: 0.7,
  steerSlip: 1.0,
  // The two-number fit; the measured table (scripts/handling-bench.ts table bike) is what planners use.
  latReach: 1.01,
  latLock: 33,
  latTable: [0.226, 0.226, 0.665, 0.811, 0.881, 0.921, 0.948, 0.969, 0.983, 0.995, 1.006, 1.015, 1.022, 1.028, 1.031, 1.026, 1.02, 1.017, 1.013, 1.009],
  steerApply: 6,
  steerRelease: 11.5,
  steerApplyAnalog: 12,
  steerReleaseAnalog: 18,
  foot: { w: 0.45, f: 1.45, r: 1.35 },
  driftYaw: 2.0,
  airRoll: 3.0,
  airPitch: 1.2,
  wallProbe: 0.3,
});

/**
 * The Truck: an arcade race truck (cab-over tractor). Long and tall, slower steering and yaw response,
 * weaker brakes and cornering, little downforce, and a lower top speed; its launch stays strong because
 * the campaign's jumps need about 180 km/h at the lip after a wide curve. It grips rather than drifts,
 * and its lock at speed stops short of the grip limit (steerSlip), so on/off steering cannot set its
 * heavy body swinging. Its barrier probes sit as high above the deck as the car's, so its tall body
 * cannot hop over a 1.4 m barrier.
 */
export const TRUCK: VehicleSpec = spec({
  vehicle: 'truck',
  wheels: wheelsOf(1.15, -0.25, 2.05, -1.85),
  wheelRadius: 0.55,
  rest: 0.5,
  kSpring: 26,
  cDamp: 3.0,
  kBump: 220,
  kAntiroll: 28,
  tyreLever: 0.25,
  hull: hullOf(1.25, -0.35, 1.6, 3.0, -2.9),
  invI: { x: 1 / 8, y: 1 / 6.75, z: 1 / 3.5 },
  muRoad: 1.9,
  muFront: 1.1,
  peakSlipF: 0.1,
  peakSlipR: 0.09,
  slideGrip: 0.8,
  driftGrip: 0.5,
  brakeDrift: false,
  airStraighten: true,
  aeroCl: 0.0017,
  aeroFront: 0.45,
  drag: 0.00038,
  brakeMax: 33,
  brakeFront: 0.55,
  driftBrakeDecel: 18,
  // Big mid-range pull (traction-limited off the line): the campaign's jumps after a wide curve need it.
  engine: [
    [0, 15],
    [15, 15.5],
    [30, 16.5],
    [45, 15.5],
    [60, 10],
    [70, 5.2],
    [80, 1.6],
    [88, 0],
  ],
  reverseMax: 10,
  steerLock: 0.55,
  steerGeo: 0.7,
  steerSlip: 0.8,
  // The two-number fit was 15% low at 36 km/h and 9% at 340 km/h: planners use the measured table
  // (scripts/handling-bench.ts table truck).
  latReach: 0.8925,
  latLock: 47,
  latTable: [0.14, 0.14, 0.498, 0.673, 0.76, 0.816, 0.853, 0.88, 0.9, 0.915, 0.927, 0.937, 0.946, 0.952, 0.958, 0.963, 0.966, 0.971, 0.974, 0.976],
  steerApply: 4.3,
  steerRelease: 7.25,
  steerApplyAnalog: 8.6,
  steerReleaseAnalog: 11.3,
  foot: { w: 1.25, f: 3.0, r: 2.9 },
  driftYaw: 3.2,
  airRoll: 3.0,
  airPitch: 1.2,
  wallProbe: 0.03,
});

const SPECS: Record<VehicleClass, VehicleSpec> = { car: CAR, bike: BIKE, truck: TRUCK };

/** The spec of a vehicle class (an unknown value is the car, prototype keys such as 'constructor' too). */
export function vehicleSpec(vehicle: VehicleClass): VehicleSpec {
  return isVehicleClass(vehicle) ? SPECS[vehicle] : CAR;
}

/** The car's anchors and wheel radius (car-only code and tests); other classes read vehicleSpec(cls). */
export const WHEEL_ANCHORS = CAR.wheels;
export const WHEEL_RADIUS = CAR.wheelRadius;

/** The widest racing-line offset that keeps a vehicle's hull 1 m inside the road edge. */
export function lineHalfWidth(S: VehicleSpec): number {
  return ROAD_HALF - S.foot.w - 1;
}

// ---- Shared tuning ----------------------------------------------------------------

const ADHESION = 34;
/**
 * A barrier that can be met from both sides (Walls on all roads) is judged from where the car centre was
 * this long ago (s), so a fast slide into it cannot carry the centre past the barrier's midline in a tick.
 */
const WALL_LOOKBACK = 0.05;

/** Slip angle (in peaks) beyond which a tyre counts as sliding for smoke and squeal. */
const SLIP_SHOW = 1.3;
/** Low-speed lateral limit: never more than removes this much sideways velocity per second (the old model). */
const LAT_DAMP = (0.55 * 0.25) / DT;

// Brakes (ABS): the pedal asks for up to brakeMax, each tyre gives at most ABS_LIMIT of the grip
// cornering leaves it.
const ABS_LIMIT = 0.97;
/** Brake pedal above this while steering hard at speed starts a drift (the brake bar sends 0.55..1). */
export const DRIFT_BRAKE = 0.5;
/** Steering (the smoothed input, 0..1) beyond which the brake starts a drift. */
export const DRIFT_STEER = 0.35;

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

/** Traction control setting. There is no "off": with digital pedals it is close to undriveable. */
export type TcLevel = keyof typeof TC_LIMIT;
export const TC_LEVELS: readonly TcLevel[] = ['normal', 'low'];

/** Driver aids for a run. Not part of the input log: a replay must use the same values. */
export interface Assists {
  readonly tc: TcLevel;
  /** Faster steering response for analog steering (tilt, the on-screen wheel); off for keys and buttons. */
  readonly analogSteer?: boolean;
}
export const DEFAULT_ASSISTS: Readonly<Assists> = Object.freeze({ tc: 'normal' });
const LOW_TC: Readonly<Assists> = Object.freeze({ tc: 'low' });

/**
 * Assists for a player's settings. Auto-accelerate always drives with normal traction control:
 * full throttle held through every corner needs it. Unknown values (old saves) are normal.
 * `analogSteer` is on only for runs steered with tilt or the wheel (settings.analogSteer).
 */
export function assistsFor(tc: string | undefined, autoAccelerate: boolean, analogSteer = false): Readonly<Assists> {
  const base = tc === 'low' && !autoAccelerate ? LOW_TC : DEFAULT_ASSISTS;
  return analogSteer ? Object.freeze({ ...base, analogSteer: true }) : base;
}

/**
 * Nitro: seconds of push per use, and seconds after a boost ends (or braking cuts it) until it is ready
 * again, so a cycle is 7.5 s. Charged at the start (createCar). The push is NITRO_POWER m/s^2 along the
 * nose at the press, fading to NITRO_FADE of it like the boost pads (about +66 km/h on the flat), and
 * only with wheels on the road: the timer runs on in the air and on the grass, so a nitro fired off a
 * ramp cannot stretch a jump past its landing. Every class gets the same push.
 */
export const NITRO_TIME = 1.5;
export const NITRO_RECHARGE = 6;
export const NITRO_POWER = 18;
export const NITRO_FADE = 0.35;

/** Nitro push (m/s^2) with `left` seconds of it to go. */
export function nitroAccel(left: number): number {
  return NITRO_POWER * (NITRO_FADE + (1 - NITRO_FADE) * (left / NITRO_TIME));
}

/** Speed (m/s) a whole push adds on the flat before drag and grip: the planning bound for the autopilots. */
export function nitroDeltaV(): number {
  let v = 0;
  for (let k = Math.round(NITRO_TIME * TICK_HZ); k > 0; k--) v += nitroAccel(k / TICK_HZ) * DT;
  return v;
}

/** True when a nitro press would fire now (brake permitting): charged and nothing pushing. */
export function nitroReady(c: Pick<CarState, 'nitroTime' | 'nitroCooldown'>): boolean {
  return c.nitroTime === 0 && c.nitroCooldown === 0;
}

/** What the nitro button and HUD show: its state, a 0..1 ring and the whole seconds left to recharge. */
export interface NitroGauge {
  state: 'ready' | 'boosting' | 'recharging';
  /** Ready 1; boosting: the push left, 1 -> 0; recharging: the charge, 0 -> 1 over NITRO_RECHARGE. */
  p: number;
  /** Recharging: NITRO_RECHARGE..1 (rounded up); else 0. */
  seconds: number;
}

/** The nitro's state for the button and HUD, from the car's timers (a replay's ghostNitro reads as nitroTime). */
export function nitroGauge(c: Pick<CarState, 'nitroTime' | 'nitroCooldown'>): NitroGauge {
  if (c.nitroTime > 0) return { state: 'boosting', p: c.nitroTime / NITRO_TIME, seconds: 0 };
  if (c.nitroCooldown > 0) return { state: 'recharging', p: 1 - c.nitroCooldown / NITRO_RECHARGE, seconds: Math.ceil(c.nitroCooldown - 1e-9) };
  return { state: 'ready', p: 1, seconds: 0 };
}

/** A nitro timer one tick on: whole ticks, so it reaches exactly 0 and replays bit for bit. */
function nitroTick(t: number): number {
  return Math.max(0, Math.round((t - DT) * TICK_HZ) / TICK_HZ);
}

/**
 * Lateral tyre force as a share of the available grip, by slip angle over peak slip angle. `slide` is
 * the share left far past the peak (VehicleSpec.slideGrip: a front tyre).
 */
export function tyreCurve(x: number, slide = CAR.slideGrip): number {
  if (x <= 1) return x * (1.5 - 0.5 * x * x);
  return 1 - (1 - slide) * Math.min(1, (x - 1) / 2);
}

/** Flat-road tyre grip (m/s^2) at forward speed v: friction on weight plus downforce. */
export function gripAccel(v: number, S: VehicleSpec): number {
  return S.muRoad * (GRAVITY + S.aeroCl * v * v);
}

/**
 * Grass drag as a body force: rolling (m/s^2) plus quadratic (1/m) deceleration with a cap, scaled by
 * the wheels on grass. Tops out near 96 km/h for the car, so cutting across it does not pay.
 * The cap only binds above about 166 km/h: a car that runs onto the grass at road speed loses it within
 * a second or so (250 -> 164 km/h with gas held), so short corner cuts cost time too.
 */
const GRASS_ROLL = 3;
const GRASS_DRAG = 0.0127;
const GRASS_MAX_DECEL = 30;

export const BOOST = { boost: { time: 1.0, power: 16 }, turbo: { time: 1.6, power: 26 } } as const;

/** Engine acceleration at forward speed v, before traction control and drag. */
export function engineAccel(v: number, S: VehicleSpec): number {
  const ENGINE = S.engine;
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
export function maxSteerAngle(speed: number, S: VehicleSpec = CAR): number {
  const v = Math.abs(speed);
  const geo = (S.wheelbase * S.steerGeo * gripAccel(v, S)) / Math.max(1, v * v);
  return Math.min(S.steerLock, geo + S.steerSlip * S.peakSlipF);
}

/**
 * Steady cornering limit (m/s^2) on a flat road at speed v, as a skidpad measures it (best steering
 * input, speed held), within a few percent. At low speed the steering lock, not the tyres, sets it.
 * For speed planners (the autopilot, the racing line); they keep their own safety margin.
 */
export function maxLatAccel(v: number, S: VehicleSpec): number {
  const t = S.latTable;
  if (!t) return gripAccel(v, S) * clamp(S.latReach - S.latLock / Math.max(1, v * v), 0.25, 1);
  const x = Math.abs(v) / LAT_TABLE_STEP;
  const i = Math.min(t.length - 2, Math.floor(x));
  return gripAccel(v, S) * lerp(t[i], t[i + 1], Math.min(1, x - i));
}

/**
 * Fastest speed (m/s, at most vFree) a planner takes a curve of curvature k (1/m) at, using `use` of the
 * cornering limit: v^2 k = use * maxLatAccel(v).
 */
export function cornerSpeedAt(k: number, use: number, S: VehicleSpec, vFree = 200): number {
  if (k <= 0 || vFree * vFree * k <= use * maxLatAccel(vFree, S)) return vFree;
  let lo = 0, hi = vFree;
  for (let n = 0; n < 40; n++) {
    const m = (lo + hi) / 2;
    if (m * m * k <= use * maxLatAccel(m, S)) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * Straight-line full-brake deceleration (m/s^2) on a flat road at speed v, ABS and drag included.
 * At speed 0 it is the low-speed (smallest) value.
 */
export function maxBrakeDecel(v: number, S: VehicleSpec): number {
  const df = S.aeroCl * v * v;
  // Each axle gives its share of the pedal, or what ABS lets its grip give (braking moves about 2% of
  // the weight forward, so each axle carries half of it).
  const front = Math.min(S.brakeMax * S.brakeFront, ABS_LIMIT * S.muRoad * S.muFront * (GRAVITY / 2 + df * S.aeroFront));
  const rear = Math.min(S.brakeMax * (1 - S.brakeFront), ABS_LIMIT * S.muRoad * (GRAVITY / 2 + df * (1 - S.aeroFront)));
  return front + rear + S.drag * v * v;
}

// ---- State helpers ------------------------------------------------------------

export function createCar(track: Track, vehicle: VehicleClass = 'car'): CarState {
  const S = vehicleSpec(vehicle);
  const sp = track.spawn();
  // Settled ride height: CoM sits so each spring carries a quarter of the weight.
  const settle = (GRAVITY / 4) / S.kSpring;
  const y = sp.y + S.ray - settle + -S.wheels[0].y;
  return {
    vehicle: S.vehicle,
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
    nitroTime: 0,
    nitroCooldown: 0,
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
function invInertia(rot: Quat, t: V3, I: Readonly<V3>): V3 {
  const l = qrotateInv(rot, t);
  return qrotate(rot, { x: l.x * I.x, y: l.y * I.y, z: l.z * I.z });
}

function applyImpulse(c: CarState, r: V3, j: V3, I: Readonly<V3>): void {
  c.vel.x += j.x;
  c.vel.y += j.y;
  c.vel.z += j.z;
  const dw = invInertia(c.rot, vcross(r, j), I);
  c.angVel.x += dw.x;
  c.angVel.y += dw.y;
  c.angVel.z += dw.z;
}

function pointVel(c: CarState, r: V3): V3 {
  const w = vcross(c.angVel, r);
  return { x: c.vel.x + w.x, y: c.vel.y + w.y, z: c.vel.z + w.z };
}

/** Resolve a contact at offset r (from CoM) with normal n; returns the applied normal impulse. */
function resolveContact(c: CarState, r: V3, n: V3, restitution: number, friction: number, I: Readonly<V3>): number {
  const vp = pointVel(c, r);
  const vn = vdot(vp, n);
  if (vn >= 0) return 0;
  const rn = vcross(r, n);
  const k = 1 + vdot(n, vcross(invInertia(c.rot, rn, I), r));
  const jn = (-(1 + restitution) * vn) / k;
  applyImpulse(c, r, { x: n.x * jn, y: n.y * jn, z: n.z * jn }, I);
  // Coulomb friction on the tangential part.
  const vp2 = pointVel(c, r);
  const vn2 = vdot(vp2, n);
  const vt = { x: vp2.x - n.x * vn2, y: vp2.y - n.y * vn2, z: vp2.z - n.z * vn2 };
  const vtl = vlen(vt);
  if (vtl > 1e-6 && friction > 0) {
    const t = { x: vt.x / vtl, y: vt.y / vtl, z: vt.z / vtl };
    const rt = vcross(r, t);
    const kt = 1 + vdot(t, vcross(invInertia(c.rot, rt, I), r));
    const jt = Math.min(vtl / kt, friction * jn);
    applyImpulse(c, r, { x: -t.x * jt, y: -t.y * jt, z: -t.z * jt }, I);
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
  const S = vehicleSpec(c.vehicle);
  const {
    wheels: WHEELS,
    rest: REST,
    ray: RAY,
    hard: HARD,
    kSpring: K_SPRING,
    cDamp: C_DAMP,
    kBump: K_BUMP,
    kAntiroll: K_ANTIROLL,
    tyreLever: TYRE_LEVER,
    hull: HULL,
    invI: INV_I,
    muRoad: MU_ROAD,
    muFront: MU_FRONT,
    peakSlipF: PEAK_SLIP_F,
    peakSlipR: PEAK_SLIP_R,
    slideGrip: SLIDE_GRIP,
    driftGrip: DRIFT_GRIP,
    aeroCl: AERO_CL,
    aeroFront: AERO_FRONT,
    drag: DRAG,
    brakeMax: BRAKE_MAX,
    brakeFront: BRAKE_FRONT,
    driftBrakeDecel: DRIFT_BRAKE_DECEL,
    reverseMax: REVERSE_MAX,
  } = S;
  const { w: FOOT_W, f: FOOT_F, r: FOOT_R } = S.foot;

  // Steering input smoothing (keyboard friendly, also smooths touch). Analog steering (tilt, the wheel)
  // may follow the hand faster.
  const target = S.airStraighten && c.grounded === 0 ? 0 : clamp(ctl.steer, -1, 1);
  const analog = assists.analogSteer === true;
  const rate =
    Math.abs(target) < Math.abs(c.steer) || Math.sign(target) !== Math.sign(c.steer)
      ? analog ? S.steerReleaseAnalog : S.steerRelease
      : analog ? S.steerApplyAnalog : S.steerApply;
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

  // Drift: brake while steering hard at speed breaks rear traction (not on a bike).
  const wantsDrift = S.brakeDrift && brake > DRIFT_BRAKE && Math.abs(c.steer) > DRIFT_STEER && speedF > 18 && c.grounded >= 2;
  if (wantsDrift) c.drift = Math.min(1, c.drift + dt * 6);
  else if (Math.abs(c.steer) < 0.2 || speedF < 12) c.drift = Math.max(0, c.drift - dt * 2.5);
  else c.drift = Math.max(0, c.drift - dt * 0.35);

  const delta = c.steer * maxSteerAngle(speedF, S);
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);

  let grounded = 0;
  let grassWheels = 0;
  let slipSum = 0;
  let tcCut = 0;
  let spin = 0;
  const vAero = Math.max(0, speedF);
  const downforce = AERO_CL * vAero * vAero;
  const engine = engineAccel(speedF, S);
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
    S.brakeDrift && brake > DRIFT_BRAKE && Math.max(Math.abs(c.steer), Math.abs(target)) > DRIFT_STEER && speedF > 18 && c.grounded >= 2;
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
    const ay = WHEELS[0].y;
    for (const [z, share] of [[WHEELS[0].z, AERO_FRONT], [WHEELS[2].z, 1 - AERO_FRONT]] as const) {
      const f = df * share;
      const ra = qrotate(c.rot, { x: 0, y: ay, z });
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
      const yaw = c.steer * c.drift * S.driftYaw;
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
    const rollT = rollErr * S.airRoll;
    torque.x += fwd.x * rollT;
    torque.y += fwd.y * rollT;
    torque.z += fwd.z * rollT;
    if (speed > 5) {
      const vd = { x: c.vel.x / speed, y: c.vel.y / speed, z: c.vel.z / speed };
      const pitchErr = vdot(vcross(fwd, vd), right);
      const pT = pitchErr * S.airPitch;
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

  // Nitro: its own channel next to the pads (both push at once). A press fires it when it is ready and the
  // brake is up; braking ends a running push; the recharge counts from the end of the push. Nothing here
  // runs while it is charged and not pressed, so a run that never fires it is bit for bit the same.
  if (ctl.nitro === true && brake === 0 && c.nitroTime === 0 && c.nitroCooldown === 0) c.nitroTime = NITRO_TIME;
  if (c.nitroTime > 0) {
    if (brake > 0) {
      c.nitroTime = 0;
      c.nitroCooldown = NITRO_RECHARGE;
    } else {
      if (grounded > 0 && grassWheels < 2) {
        const a = nitroAccel(c.nitroTime);
        force.x += fwd.x * a;
        force.y += fwd.y * a;
        force.z += fwd.z * a;
      }
      c.nitroTime = nitroTick(c.nitroTime);
      if (c.nitroTime === 0) c.nitroCooldown = NITRO_RECHARGE;
    }
  } else if (c.nitroCooldown > 0) c.nitroCooldown = nitroTick(c.nitroCooldown);

  // Aerodynamic drag.
  force.x -= c.vel.x * speed * DRAG;
  force.y -= c.vel.y * speed * DRAG;
  force.z -= c.vel.z * speed * DRAG;

  // Integrate velocities.
  c.vel.x += force.x * dt;
  c.vel.y += force.y * dt;
  c.vel.z += force.z * dt;
  const dw = invInertia(c.rot, torque, INV_I);
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
      resolveContact(c, r, n, 0.05, 0.45, INV_I);
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
      resolveContact(c, r, n, 0.0, 0.0, INV_I);
      events.impact = Math.max(events.impact, -before);
      maxPen = Math.max(maxPen, pen);
    }
  }

  // Barrier contacts. The probes sit wallProbe above the low hull points; the car centre a moment ago
  // picks the face of a barrier that can be met from the grass too (Walls on all roads).
  let pushX = 0, pushZ = 0;
  const cx = c.pos.x - c.vel.x * WALL_LOOKBACK, cz = c.pos.z - c.vel.z * WALL_LOOKBACK;
  for (const h of HULL) {
    if (h.y > 0) continue;
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y + S.wallProbe, pz = c.pos.z + r.z;
    const wh = track.wallAt(px, py, pz, cx, cz, S.wallProbe);
    if (!wh) continue;
    const n = { x: wh.nx, y: 0, z: wh.nz };
    const before = vdot(pointVel(c, r), n);
    resolveContact(c, r, n, 0.12, 0.12, INV_I);
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
    resolveContact(c, r, n, 0.1, 0.2, INV_I);
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
      resolveContact(c, r, n, 0.15, 0.2, INV_I);
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
  c.wheelSpin += (fwdSpeed * dt) / S.wheelRadius;
  c.odometer += Math.abs(fwdSpeed) * dt;
  return events;
}
