// Shared runs: a personal best (or any finished run) as a link anyone can open. The link carries the run's
// input log, not a video: the receiving game drives the same inputs on the same track with the same physics
// and gets the same lap, tick for tick, then shows it as a replay (and can race against it). The time is
// checked on arrival: a run from another physics version, or edited by hand, does not finish at its time.
// The payload is JSON, deflated and base64url'd into the link's fragment (never sent to a server):
//   https://velocityblocks.vercel.app/play/#run=<payload>
// The Android app opens these links itself (AndroidManifest.xml), the browser game reads its own address.
//
// The same run also saves as a .vbst file (Velocity Blocks run), for a PC with no share sheet: readable JSON
// with what it is (track, driver, time, vehicle, date, game version, whether the game that saved it drove it
// to that time) and the run itself. Opening one checks it again here, whatever the file says.

import { PHYSICS_VERSION } from '../core/constants';
import { isVehicleClass, type VehicleClass } from '../core/vehicles';
import { DEFAULT_ASSISTS, NO_CONTROLS, type Assists } from '../physics/vehicle';
import { campaign } from '../track/campaign';
import { Track, type TrackData } from '../track/track';
import type { Ghost } from './ghost';
import { decodeInputLog, encodeInputLog, INPUT_STRIDE } from './inputLog';
import { formatTime, loggedControls, RaceSession } from './race';

/** Where shared links point: the browser game, which the app also opens. */
export const RUN_LINK_BASE = 'https://velocityblocks.vercel.app/play/';
/** The same run for the installed apps (the browser game's "Open in the app"): velocityblocks://run#run=... */
export const APP_LINK_BASE = 'velocityblocks://run';

export interface SharedRun {
  v: 1;
  physics: number;
  /** The track's key ('c:A01' for a campaign track; anything else carries `data`). */
  base: string;
  label: string;
  /** The layout of a track that is not in the campaign. */
  data?: TrackData;
  vehicle: VehicleClass;
  walls: boolean;
  assists: Assists;
  /** Finish time (ms) as driven. */
  time: number;
  /** Driver name from the profile ('' when none). */
  driver: string;
  /** encodeInputLog of the run's inputs. */
  inputs: string;
}

/** What a run is on: the RaceEntry fields that matter. */
export interface RunTrack {
  base: string;
  label: string;
  data: TrackData;
  vehicle: VehicleClass;
  walls: boolean;
}

/** A shareable run from a ghost that kept its inputs (null for older ghosts). */
export function runOf(t: RunTrack, g: Ghost, driver: string): SharedRun | null {
  if (!g.inputs?.length) return null;
  return {
    v: 1,
    physics: g.physics,
    base: t.base,
    label: t.label,
    ...(t.base.startsWith('c:') ? {} : { data: t.data }),
    vehicle: t.vehicle,
    walls: t.walls,
    assists: g.assists ?? DEFAULT_ASSISTS,
    time: g.time,
    driver,
    inputs: encodeInputLog(g.inputs),
  };
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const toB64url = (b: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
};

/** The link that opens a run. */
export async function runLink(run: SharedRun): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(run)), new CompressionStream('deflate-raw'));
  return `${RUN_LINK_BASE}#run=${toB64url(packed)}`;
}

/** A run from a link, an address, or the bare payload; null when it is not one. */
export async function parseRun(text: string): Promise<SharedRun | null> {
  const t = text.trim();
  // A .vbst file: JSON with the run in it.
  if (t.startsWith('{')) {
    try {
      const f = JSON.parse(t) as Partial<RunFile>;
      return f.format === RUN_FILE_FORMAT ? checkedRun(f.run) : null;
    } catch {
      return null;
    }
  }
  const m = /(?:[#&?]run=)?([A-Za-z0-9_-]{16,})\s*$/.exec(t);
  if (!m) return null;
  try {
    const json = new TextDecoder().decode(await pipe(fromB64url(m[1]), new DecompressionStream('deflate-raw')));
    return checkedRun(JSON.parse(json));
  } catch {
    return null;
  }
}

/** A run from untrusted JSON (a link or a file): its shape checked and its fields normalised, or null. */
function checkedRun(x: unknown): SharedRun | null {
  const o = x as SharedRun | null;
  if (!o || typeof o !== 'object') return null;
  if (o.v !== 1 || typeof o.base !== 'string' || typeof o.inputs !== 'string' || !isVehicleClass(o.vehicle)) return null;
  if (!o.base.startsWith('c:') && !o.data) return null;
  return {
    ...o,
    walls: o.walls === true,
    assists: { tc: o.assists?.tc === 'low' ? 'low' : 'normal', ...(o.assists?.analogSteer === true ? { analogSteer: true } : {}) },
    label: String(o.label ?? ''),
    driver: String(o.driver ?? '').slice(0, 40),
  };
}

/** The .vbst file's "format" value. */
export const RUN_FILE_FORMAT = 'velocity-blocks-run';
/** The file extension of saved runs. */
export const RUN_FILE_EXT = '.vbst';

/** A saved run (.vbst): readable details first, then the run itself (what the game reads back). */
export interface RunFile {
  format: typeof RUN_FILE_FORMAT;
  /** The track's name ("A01 Warm-Up"). */
  track: string;
  /** Who drove it ('' when the profile has no name). */
  driver: string;
  /** Finish time as text ("0:10.60") and in ms. */
  time: string;
  timeMs: number;
  vehicle: VehicleClass;
  walls: boolean;
  /** The game that saved it drove the inputs and finished at this time. The opening game checks again. */
  verified: boolean;
  /** When it was saved (ISO 8601) and by which game version and physics. */
  savedAt: string;
  game: string;
  physics: number;
  run: SharedRun;
}

/** The .vbst text of a run: drives it first, so `verified` says whether it finishes at its time here. */
export function runFile(run: SharedRun, gameVersion: string, now = new Date()): string {
  const driven = driveRun(run);
  const f: RunFile = {
    format: RUN_FILE_FORMAT,
    track: run.label,
    driver: run.driver,
    time: formatTime(run.time),
    timeMs: run.time,
    vehicle: run.vehicle,
    walls: run.walls,
    verified: driven?.verified === true,
    savedAt: now.toISOString(),
    game: `Velocity Blocks ${gameVersion}`,
    physics: run.physics,
    run,
  };
  return JSON.stringify(f, null, 2);
}

/** "VelocityBlocks-A01-Warm-Up-Shaurya-0-10-60.vbst" */
export function runFileName(run: SharedRun): string {
  const part = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ['VelocityBlocks', part(run.label), part(run.driver), part(formatTime(run.time))].filter(Boolean).join('-') + RUN_FILE_EXT;
}

/** The track data of a run (a campaign track by id), or null when this game does not have it. */
export function runTrackData(run: SharedRun): TrackData | null {
  if (run.base.startsWith('c:')) return campaign().find((c) => `c:${c.id}` === run.base)?.data ?? null;
  return run.data ?? null;
}

export interface DrivenRun {
  track: Track;
  /** The lap as this game drives it (poses, splits, inputs): replay it, race against it. */
  ghost: Ghost;
  /** It finished at the time it was shared with: the same lap. */
  verified: boolean;
}

/** Drive a shared run's inputs (headless, a few hundred ms for a long lap); null when they never finish. */
export function driveRun(run: SharedRun): DrivenRun | null {
  const data = runTrackData(run);
  const inputs = decodeInputLog(run.inputs);
  if (!data || !inputs) return null;
  const track = new Track(data, { walls: run.walls });
  const race = new RaceSession(track, run.assists, run.vehicle);
  while (race.phase === 'countdown') race.step(NO_CONTROLS);
  const n = inputs.length / INPUT_STRIDE;
  // A little past the inputs (coasting on the brakes): a lap whose log ends at the line still crosses it.
  for (let t = 0; race.phase === 'racing' && t < n + 50; t++) {
    race.step(t < n ? loggedControls(inputs as unknown as number[], t) : { steer: 0, gas: 0, brake: 1 });
  }
  if (race.phase !== 'finished' || !race.ghost) return null;
  return { track, ghost: race.ghost, verified: run.physics === PHYSICS_VERSION && race.finishTime === run.time };
}
