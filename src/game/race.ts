// A single time-attack run: countdown, timing at the fixed tick rate, checkpoints in any
// order, flying respawn at the last checkpoint (also automatic after 3 s flipped, or after a fall
// into water), the nitro's
// race rules (a press in the countdown fires at GO; a respawn never refills it), finish
// validation and ghost recording.

import { DT, TICK_HZ, WALL_OFF, WATER_SINK_Y } from '../core/constants';
import {
  cloneCar,
  createCar,
  forwardOf,
  NITRO_RECHARGE,
  speedOf,
  stepCar,
  triggerBoost,
  upOf,
  vehicleSpec,
  DEFAULT_ASSISTS,
  type Assists,
  type CarState,
  type Controls,
} from '../physics/vehicle';
import { qfromYawDir } from '../core/vec';
import type { VehicleClass } from '../core/vehicles';
import type { PlacedBlock, Track } from '../track/track';
import { GhostRecorder, type Ghost } from './ghost';

export const COUNTDOWN_TICKS = 150; // 1.5 s: "3", "2", "1" at 0.5 s steps
/** Ticks (3 s) the car may stay flipped before it is respawned automatically. */
export const FLIP_RESPAWN_TICKS = 3 * TICK_HZ; // 300
/** The HUD warning appears once the timer reaches this (1.5 s). Slow self-righting rolls can briefly pass it. */
export const FLIP_WARN_TICKS = 150;
/** World up.y below this: on the roof, side or nose. Wheels cannot touch flat ground below up.y 0.2. */
export const FLIP_UP_Y = 0.3;
/** up.y at or above this: back on its wheels, so the flip timer resets. */
export const UPRIGHT_UP_Y = 0.6;
/** Between FLIP_UP_Y and UPRIGHT_UP_Y the timer only advances when the car is nearly stopped (m/s). */
export const TILT_STUCK_SPEED = 2;

/** Pure, deterministic flip-timer update for one racing tick. */
export function nextFlipTicks(ticks: number, upY: number, speed: number): number {
  // No speed condition when inverted: roof slides take ~10 s to stop and airTime can't tell
  // flying from lying.
  if (upY < FLIP_UP_Y) return ticks + 1;
  if (upY >= UPRIGHT_UP_Y) return 0;
  // Leaning (against a barrier, on a block edge): only stuck if it has stopped.
  return speed < TILT_STUCK_SPEED ? ticks + 1 : ticks;
}
/**
 * Ticks (0.3 s) a car that fell into water sinks before it is respawned automatically: long enough to drop
 * out of sight under the surface, short enough not to feel like a hang. The clock keeps running, as for a flip.
 */
export const SINK_TICKS = 30;
const GATE_S = 16;
const FINISH_BRAKE: Controls = { steer: 0, gas: 0, brake: 1 };
/** Racing ticks a countdown nitro press waits for the brake to lift (0.5 s), and the pedal travel that counts as up (stepCar's). */
const NITRO_ARM_HOLD = 50;
const NITRO_BRAKE_EPS = 0.01;

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type RaceEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; time: number; index: number; taken: number; total: number }
  | { type: 'finish'; time: number }
  | { type: 'missing'; remaining: number }
  | { type: 'pad'; kind: 'boost' | 'turbo' }
  /** Automatic (`auto`: flipped for 3 s, or `water`: fell into water) or asked for. */
  | { type: 'respawn'; auto: boolean; water?: boolean }
  /** The car hit the water (a respawn follows SINK_TICKS later); where, for the splash. */
  | { type: 'splash'; x: number; y: number; z: number }
  | { type: 'impact'; speed: number }
  /** The nitro fired on this tick. */
  | { type: 'nitro' }
  /** The nitro has recharged and can fire again. */
  | { type: 'nitroReady' };

/** Numbers per racing tick in RaceSession.inputs: steer (-127..127), gas (0..255), brake (0..255), nitro (0/1). */
export const INPUT_STRIDE = 4;

/** The controls of racing tick `tick` in an input log (RaceSession.inputs), as the race applied them. */
export function loggedControls(inputs: readonly number[], tick: number): Controls {
  const k = tick * INPUT_STRIDE;
  const c: Controls = { steer: inputs[k] / 127, gas: inputs[k + 1] / 255, brake: inputs[k + 2] / 255 };
  if (inputs[k + 3] === 1) c.nitro = true;
  return c;
}

export class RaceSession {
  car!: CarState;
  phase: RacePhase = 'countdown';
  /** Ticks since the countdown started. */
  private clock = 0;
  /** Ticks since GO. */
  ticks = 0;
  readonly taken = new Set<number>();
  cpTimes: number[] = [];
  finishTime: number | null = null;
  respawns = 0;
  /** Consecutive racing ticks spent flipped (nextFlipTicks); the HUD reads it for the warning. */
  flipTicks = 0;
  /** Racing ticks the car has been under water (a respawn at SINK_TICKS). */
  sinkTicks = 0;
  private checkpointState: CarState | null = null;
  private lastPad: PlacedBlock | null = null;
  private readonly recorder = new GhostRecorder();
  /** A nitro press during the countdown: it fires on the first racing tick with the brake up (NITRO_ARM_HOLD). */
  private nitroArmed = false;
  /** Nitros fired this run. */
  nitroUses = 0;
  /** Packed per-tick inputs since GO, INPUT_STRIDE numbers each (read them with loggedControls). */
  inputs: number[] = [];
  ghost: Ghost | null = null;

  /**
   * `assists` are the driver aids (see assistsFor in physics/vehicle). They are not in the input log,
   * so a replay needs the same value: change them between runs, before restart().
   */
  constructor(
    readonly track: Track,
    public assists: Readonly<Assists> = DEFAULT_ASSISTS,
    /** Vehicle class for this session (its own handling, records and author times). */
    readonly vehicle: VehicleClass = 'car',
  ) {
    this.restart();
  }

  restart(): void {
    this.car = createCar(this.track, this.vehicle);
    this.phase = 'countdown';
    this.clock = 0;
    this.ticks = 0;
    this.taken.clear();
    this.cpTimes = [];
    this.finishTime = null;
    this.respawns = 0;
    this.flipTicks = 0;
    this.sinkTicks = 0;
    this.checkpointState = null;
    this.lastPad = null;
    this.nitroArmed = false;
    this.nitroUses = 0;
    this.inputs = [];
    this.ghost = null;
    this.recorder.reset();
  }

  /** Race time in milliseconds (10 ms resolution, like the tick). */
  get timeMs(): number {
    return Math.round((this.ticks * 1000) / TICK_HZ);
  }

  get countdownLeft(): number {
    return Math.max(0, COUNTDOWN_TICKS - this.clock) * DT;
  }

  /** True once a checkpoint has been taken, so a respawn flies back to it instead of restarting. */
  get hasRespawnPoint(): boolean {
    return this.checkpointState !== null;
  }

  /**
   * Back to the last checkpoint, or a full restart if none was taken. `auto` marks an automatic respawn (a
   * flip, or with `water` a fall into water).
   */
  respawn(auto = false, water = false): RaceEvent[] {
    if (this.phase === 'finished') return [];
    this.flipTicks = 0;
    this.sinkTicks = 0;
    const ev: RaceEvent = water ? { type: 'respawn', auto, water } : { type: 'respawn', auto };
    if (!this.checkpointState) {
      this.restart();
      return [ev];
    }
    const was = this.car;
    this.car = cloneCar(this.checkpointState);
    // The nitro is not restored with the checkpoint: a running push stops and recharges from now, and a
    // recharge in progress carries on, so a respawn never refills it.
    this.car.nitroTime = 0;
    this.car.nitroCooldown = was.nitroTime > 0 ? NITRO_RECHARGE : was.nitroCooldown;
    this.lastPad = null;
    this.respawns++;
    return [ev];
  }

  step(input: Controls): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.phase === 'countdown') {
      if (input.nitro) this.nitroArmed = true;
      if (this.clock % 50 === 0) events.push({ type: 'countdown', n: 3 - this.clock / 50 });
      this.clock++;
      if (this.clock >= COUNTDOWN_TICKS) {
        this.phase = 'racing';
        events.push({ type: 'go' });
        this.recorder.record(0, this.car);
      }
      return events;
    }

    // After the finish line the car brakes to a stop on its own (which also ends a nitro push).
    let ctl = this.phase === 'racing' ? input : FINISH_BRAKE;
    if (this.phase === 'racing') {
      if (this.nitroArmed) {
        // The press waits while the brake is down (it cannot fire then: a thumb resting on the brake bar at
        // GO, a trigger held), for up to NITRO_ARM_HOLD ticks, so the armed nitro is not lost quietly.
        ctl = { ...ctl, nitro: true };
        if (quantise(ctl).brake < NITRO_BRAKE_EPS || this.ticks >= NITRO_ARM_HOLD) this.nitroArmed = false;
      }
      this.inputs.push(
        Math.round(ctl.steer * 127),
        Math.round(ctl.gas * 255),
        Math.round(ctl.brake * 255),
        ctl.nitro ? 1 : 0,
      );
    }
    const prev = { x: this.car.pos.x, y: this.car.pos.y, z: this.car.pos.z };
    const busy = this.car.nitroTime > 0 || this.car.nitroCooldown > 0;
    const ev = stepCar(this.car, quantise(ctl), this.track, this.assists);
    if (ev.impact > 6) events.push({ type: 'impact', speed: ev.impact });
    if (this.phase !== 'racing') return events;
    if (!busy && this.car.nitroTime > 0) {
      this.nitroUses++;
      events.push({ type: 'nitro' });
    } else if (busy && this.car.nitroTime === 0 && this.car.nitroCooldown === 0) events.push({ type: 'nitroReady' });

    this.ticks++;
    this.recorder.record(this.ticks, this.car);
    this.checkGates(prev, events);
    this.checkPads(events);
    // After the gates, so a checkpoint crossed on this tick is the respawn point and a finish stops it.
    this.checkFlip(events);
    this.checkWater(events);
    return events;
  }

  /** A car whose centre sank below WATER_SINK_Y over water fell in: a splash, then a respawn SINK_TICKS later. */
  private checkWater(events: RaceEvent[]): void {
    const p = this.car.pos;
    if (this.phase !== 'racing' || !this.track.hasWater || p.y >= WATER_SINK_Y || !this.track.waterAt(p.x, p.z)) {
      this.sinkTicks = 0;
      return;
    }
    if (this.sinkTicks === 0) events.push({ type: 'splash', x: p.x, y: 0, z: p.z });
    if (++this.sinkTicks >= SINK_TICKS) events.push(...this.respawn(true, true));
  }

  private checkGates(prev: { x: number; y: number; z: number }, events: RaceEvent[]): void {
    const cur = this.car.pos;
    const cands = new Set<PlacedBlock>();
    for (const list of [this.track.blocksAt(prev.x, prev.z), this.track.blocksAt(cur.x, cur.z)]) {
      if (list) for (const b of list) if (b.def.gate && b.def.gate !== 'start') cands.add(b);
    }
    for (const b of cands) {
      const l0 = b.toLocal(prev.x, prev.z);
      const l1 = b.toLocal(cur.x, cur.z);
      if (!(l0.b < GATE_S && l1.b >= GATE_S)) continue;
      if (Math.abs(l1.a) > WALL_OFF + 1.5) continue;
      if (cur.y < b.baseY - 3 || cur.y > b.baseY + 14) continue;
      const gate = this.track.gates.find((g) => g.block === b)!;
      if (gate.kind === 'checkpoint') {
        if (this.taken.has(gate.id)) {
          // Re-crossing a taken checkpoint refreshes the respawn point only.
          this.checkpointState = respawnState(this.car, b);
          continue;
        }
        this.taken.add(gate.id);
        this.cpTimes.push(this.timeMs);
        this.checkpointState = respawnState(this.car, b);
        events.push({
          type: 'checkpoint',
          time: this.timeMs,
          index: gate.id,
          taken: this.taken.size,
          total: this.track.checkpointCount,
        });
      } else if (gate.kind === 'finish') {
        const remaining = this.track.checkpointCount - this.taken.size;
        if (remaining > 0) {
          events.push({ type: 'missing', remaining });
          continue;
        }
        this.phase = 'finished';
        this.finishTime = this.timeMs;
        this.ghost = this.recorder.finish(this.finishTime, this.cpTimes, this.vehicle);
        events.push({ type: 'finish', time: this.finishTime });
        return;
      }
    }
  }

  // A separate method: inside step() this.phase is narrowed to 'racing', but checkGates may finish the run.
  private checkFlip(events: RaceEvent[]): void {
    if (this.phase !== 'racing') {
      this.flipTicks = 0;
      return;
    }
    this.flipTicks = nextFlipTicks(this.flipTicks, upOf(this.car).y, speedOf(this.car));
    if (this.flipTicks >= FLIP_RESPAWN_TICKS) events.push(...this.respawn(true));
  }

  private checkPads(events: RaceEvent[]): void {
    const c = this.car.pos;
    let on: PlacedBlock | null = null;
    const list = this.track.blocksAt(c.x, c.z);
    if (list) {
      for (const b of list) {
        if (!b.def.pad) continue;
        const l = b.toLocal(c.x, c.z);
        if (l.b < 4 || l.b > 28 || Math.abs(l.a) > 7.5) continue;
        if (c.y < b.baseY - 0.5 || c.y > b.baseY + 3) continue;
        on = b;
      }
    }
    if (on && on !== this.lastPad) {
      triggerBoost(this.car, on.def.pad!);
      events.push({ type: 'pad', kind: on.def.pad! });
    }
    this.lastPad = on;
  }
}

/**
 * Flying respawn state saved at a checkpoint: same place and speed, but always upright
 * and pointing down the road so a messy crossing can't trap the player. The body sits a
 * little above its settled ride height (VehicleSpec.respawnY: 0.9 m for the car).
 */
function respawnState(car: CarState, gate: PlacedBlock): CarState {
  const c = cloneCar(car);
  const f = forwardOf(car);
  const along = f.x * gate.fx + f.z * gate.fz;
  const speed = Math.max(0, car.vel.x * gate.fx + car.vel.z * gate.fz);
  const l = gate.toLocal(car.pos.x, car.pos.z);
  const a = Math.max(-WALL_OFF + 2, Math.min(WALL_OFF - 2, l.a));
  const p = gate.toWorld(a, l.b);
  c.pos = { x: p.x, y: gate.baseY + vehicleSpec(car.vehicle).respawnY, z: p.z };
  // Keep the car's own heading if it is roughly aligned with the road, otherwise use the road's.
  c.rot = along > 0.7 && Math.abs(f.y) < 0.5 ? qfromYawDir(f.x, f.z) : qfromYawDir(gate.fx, gate.fz);
  const nf = forwardOf(c);
  c.vel = { x: nf.x * speed, y: 0, z: nf.z * speed };
  c.angVel = { x: 0, y: 0, z: 0 };
  c.drift = 0;
  c.airTime = 0;
  c.tc = 0;
  c.spin = 0;
  c.abs = 0;
  return c;
}

/** Inputs are quantised to what the input log can store so replays re-simulate exactly. */
export function quantise(c: Controls): Controls {
  const q: Controls = {
    steer: Math.round(c.steer * 127) / 127,
    gas: Math.round(c.gas * 255) / 255,
    brake: Math.round(c.brake * 255) / 255,
  };
  if (c.nitro) q.nitro = true;
  return q;
}

export function formatTime(ms: number | null | undefined, signed = false): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return '-:--.--';
  const neg = ms < 0;
  const a = Math.round(Math.abs(ms) / 10);
  const cs = a % 100;
  const sTot = Math.floor(a / 100);
  const s = sTot % 60;
  const m = Math.floor(sTot / 60);
  const body = `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  if (signed) return (neg ? '-' : '+') + (m === 0 ? `${s}.${String(cs).padStart(2, '0')}` : body);
  return body;
}
