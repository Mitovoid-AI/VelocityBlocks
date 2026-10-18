// A single time-attack run: countdown, timing at the fixed tick rate, checkpoints in any
// order, flying respawn at the last checkpoint (also automatic after 3 s flipped), finish
// validation and ghost recording.

import { DT, TICK_HZ, WALL_OFF } from '../core/constants';
import {
  cloneCar,
  createCar,
  forwardOf,
  speedOf,
  stepCar,
  triggerBoost,
  upOf,
  type CarState,
  type Controls,
} from '../physics/vehicle';
import { qfromYawDir } from '../core/vec';
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
const GATE_S = 16;
const FINISH_BRAKE: Controls = { steer: 0, gas: 0, brake: 1 };

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type RaceEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; time: number; index: number; taken: number; total: number }
  | { type: 'finish'; time: number }
  | { type: 'missing'; remaining: number }
  | { type: 'pad'; kind: 'boost' | 'turbo' }
  | { type: 'respawn'; auto: boolean }
  | { type: 'impact'; speed: number };

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
  private checkpointState: CarState | null = null;
  private lastPad: PlacedBlock | null = null;
  private readonly recorder = new GhostRecorder();
  /** Packed per-tick inputs since GO: steer (-127..127), gas (0..255), brake (0..255). */
  inputs: number[] = [];
  ghost: Ghost | null = null;

  constructor(readonly track: Track) {
    this.restart();
  }

  restart(): void {
    this.car = createCar(this.track);
    this.phase = 'countdown';
    this.clock = 0;
    this.ticks = 0;
    this.taken.clear();
    this.cpTimes = [];
    this.finishTime = null;
    this.respawns = 0;
    this.flipTicks = 0;
    this.checkpointState = null;
    this.lastPad = null;
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

  /** Back to the last checkpoint, or a full restart if none was taken. `auto` marks a flip respawn. */
  respawn(auto = false): RaceEvent[] {
    if (this.phase === 'finished') return [];
    this.flipTicks = 0;
    if (!this.checkpointState) {
      this.restart();
      return [{ type: 'respawn', auto }];
    }
    this.car = cloneCar(this.checkpointState);
    this.lastPad = null;
    this.respawns++;
    return [{ type: 'respawn', auto }];
  }

  step(input: Controls): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.phase === 'countdown') {
      if (this.clock % 50 === 0) events.push({ type: 'countdown', n: 3 - this.clock / 50 });
      this.clock++;
      if (this.clock >= COUNTDOWN_TICKS) {
        this.phase = 'racing';
        events.push({ type: 'go' });
        this.recorder.record(0, this.car);
      }
      return events;
    }

    // After the finish line the car brakes to a stop on its own.
    const ctl = this.phase === 'racing' ? input : FINISH_BRAKE;
    if (this.phase === 'racing') {
      this.inputs.push(
        Math.round(ctl.steer * 127),
        Math.round(ctl.gas * 255),
        Math.round(ctl.brake * 255),
      );
    }
    const prev = { x: this.car.pos.x, y: this.car.pos.y, z: this.car.pos.z };
    const ev = stepCar(this.car, quantise(ctl), this.track);
    if (ev.impact > 6) events.push({ type: 'impact', speed: ev.impact });
    if (this.phase !== 'racing') return events;

    this.ticks++;
    this.recorder.record(this.ticks, this.car);
    this.checkGates(prev, events);
    this.checkPads(events);
    // After the gates, so a checkpoint crossed on this tick is the respawn point and a finish stops it.
    this.checkFlip(events);
    return events;
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
        this.ghost = this.recorder.finish(this.finishTime, this.cpTimes);
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
 * and pointing down the road so a messy crossing can't trap the player.
 */
function respawnState(car: CarState, gate: PlacedBlock): CarState {
  const c = cloneCar(car);
  const f = forwardOf(car);
  const along = f.x * gate.fx + f.z * gate.fz;
  const speed = Math.max(0, car.vel.x * gate.fx + car.vel.z * gate.fz);
  const l = gate.toLocal(car.pos.x, car.pos.z);
  const a = Math.max(-WALL_OFF + 2, Math.min(WALL_OFF - 2, l.a));
  const p = gate.toWorld(a, l.b);
  c.pos = { x: p.x, y: gate.baseY + 0.9, z: p.z };
  // Keep the car's own heading if it is roughly aligned with the road, otherwise use the road's.
  c.rot = along > 0.7 && Math.abs(f.y) < 0.5 ? qfromYawDir(f.x, f.z) : qfromYawDir(gate.fx, gate.fz);
  const nf = forwardOf(c);
  c.vel = { x: nf.x * speed, y: 0, z: nf.z * speed };
  c.angVel = { x: 0, y: 0, z: 0 };
  c.drift = 0;
  c.airTime = 0;
  return c;
}

/** Inputs are quantised to what the input log can store so replays re-simulate exactly. */
export function quantise(c: Controls): Controls {
  return {
    steer: Math.round(c.steer * 127) / 127,
    gas: Math.round(c.gas * 255) / 255,
    brake: Math.round(c.brake * 255) / 255,
  };
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
