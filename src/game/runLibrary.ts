// Runs: the shared runs a player has imported (a .vbst file) or opened (a link), kept on the device to watch or
// race again (App.runsScreen). Each keeps the run itself and what the list shows: track, driver, time, vehicle,
// and whether this game drove it to that time. Newest first, at most MAX_RUNS; the same run opened twice is
// kept once. Stored in localStorage under its own key, apart from records and ghosts (storage.ts).

import type { VehicleClass } from '../core/vehicles';
import { parseRun, type SharedRun } from './runShare';

export const RUNS_KEY = 'vb.runs';
export const MAX_RUNS = 100;

export interface SavedRun {
  /** Identity: the same run (track, vehicle, driver, inputs) is kept once. */
  id: string;
  track: string;
  driver: string;
  time: number;
  vehicle: VehicleClass;
  verified: boolean;
  /** When it was added (ms since 1970). */
  addedAt: number;
  run: SharedRun;
}

/** Where the list is kept (localStorage in the game; a stand-in in tests). */
export interface RunsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A short hash of the run's identity, so the same run opened twice is one entry. */
export function runId(r: SharedRun): string {
  const s = `${r.base}|${r.vehicle}|${r.walls}|${r.driver}|${r.time}|${r.inputs}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + s.length.toString(36);
}

export class RunLibrary {
  constructor(private readonly store: RunsStore | null = typeof localStorage !== 'undefined' ? localStorage : null) {}

  /** The kept runs, newest first (entries that no longer read as runs are dropped). */
  list(): SavedRun[] {
    try {
      const raw = this.store?.getItem(RUNS_KEY);
      const a = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(a) ? (a as SavedRun[]).filter((r) => r && typeof r.id === 'string' && r.run && typeof r.run.inputs === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Keep a run (moved to the top when it is already there). False when storage is full or missing. */
  add(run: SharedRun, verified: boolean, now = Date.now()): boolean {
    const id = runId(run);
    const entry: SavedRun = { id, track: run.label, driver: run.driver, time: run.time, vehicle: run.vehicle, verified, addedAt: now, run };
    return this.write([entry, ...this.list().filter((r) => r.id !== id)].slice(0, MAX_RUNS));
  }

  remove(id: string): void {
    this.write(this.list().filter((r) => r.id !== id));
  }

  private write(runs: SavedRun[]): boolean {
    try {
      if (!this.store) return false;
      this.store.setItem(RUNS_KEY, JSON.stringify(runs));
      return true;
    } catch {
      return false;
    }
  }
}

/** Check a stored run's shape again on the way out (it went through parseRun on the way in). */
export async function storedRun(r: SavedRun): Promise<SharedRun | null> {
  return parseRun(JSON.stringify({ format: 'velocity-blocks-run', run: r.run }));
}
