// The pro driver's tuned laps (src/track/proLaps.json, scripts/pro-laps.ts) in the game: its settings per
// campaign track and class, its ghost lap (driven again on the device: the physics is deterministic, so it
// matches the stored time), that ghost stretched in time to any medal time, and the pilot for autoplay.
// Its lap times are the campaign's author times (medals.ts campaignAuthorTime).

import { PHYSICS_VERSION, VEHICLE_REV } from '../core/constants';
import type { VehicleClass } from '../core/vehicles';
import { DEFAULT_ASSISTS, NO_CONTROLS, vehicleSpec } from '../physics/vehicle';
import proLapsJson from '../track/proLaps.json';
import type { Track } from '../track/track';
import type { Ghost } from './ghost';
import { baseParams, proLine, ProPilot, type ProParams } from './proDriver';
import { quantise, RaceSession } from './race';

export interface ProLap {
  time: number;
  params: ProParams;
}

export interface ProLapsTable {
  physics: number;
  classes: Partial<Record<VehicleClass, { rev: number; laps: Record<string, ProLap> }>>;
}

// Bundled with the game (unlike the racing lines): the medals read the author times from it at once.
const table = proLapsJson as unknown as ProLapsTable;

/** The pro laps (bundled: resolves at once; kept async for callers written for a lazy load). */
export function loadProLaps(): Promise<ProLapsTable | null> {
  return Promise.resolve(table);
}

/** The stored lap for a race's track key ('c:A01') and class, or null (not a campaign track, not loaded, stale). */
export function proLapFor(base: string, vehicle: VehicleClass): ProLap | null {
  if (table.physics !== PHYSICS_VERSION || !base.startsWith('c:')) return null;
  const sec = table.classes[vehicle];
  return sec && sec.rev === VEHICLE_REV[vehicle] ? (sec.laps[base.slice(2)] ?? null) : null;
}

/** A pro driver for a track: tuned settings when given, else the untuned starting ones. Null when the track has no line. */
export function proPilot(track: Track, vehicle: VehicleClass, params: ProParams | null): ProPilot | null {
  const S = vehicleSpec(vehicle);
  const p = params ?? baseParams(vehicle, 0);
  const line = proLine(track, S, p.width);
  if (!line) return null;
  return new ProPilot(line, S, params ?? baseParams(vehicle, line.length));
}

/** Racing ticks a ghost job drives per slice (a slice is well under a millisecond on a PC). */
const SLICE_TICKS = 40;

/**
 * Drive a pro lap headless and keep its ghost (time-sliced: one slice per yield), or null when it does not
 * finish cleanly. `track` should be the open-road track the lap was tuned on.
 */
export function* proGhostJob(track: Track, vehicle: VehicleClass, params: ProParams | null): Generator<void, Ghost | null> {
  const pilot = proPilot(track, vehicle, params);
  if (!pilot) return null;
  const race = new RaceSession(track, DEFAULT_ASSISTS, vehicle);
  const cap = Math.round(100 * (pilot.route.length / 8 + 10)) + 200;
  for (let n = 0; n < cap && race.phase !== 'finished'; n++) {
    const ctl = race.phase === 'racing' ? quantise(pilot.controls(race)) : NO_CONTROLS;
    for (const e of race.step(ctl)) if (e.type === 'respawn' || e.type === 'missing') return null;
    if (n % SLICE_TICKS === SLICE_TICKS - 1) yield;
  }
  return race.phase === 'finished' ? race.ghost : null;
}

/** A ghost that drives the same line, uniformly slower or faster, so it finishes at `time` (ms). */
export function stretchGhost(g: Ghost, time: number): Ghost {
  const k = time / g.time;
  return {
    ...g,
    time,
    interval: g.interval * k,
    cpTimes: g.cpTimes.map((t) => Math.round(t * k)),
    nitro: (g.nitro ?? []).map((t) => t * k),
  };
}
