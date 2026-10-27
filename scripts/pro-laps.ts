// Practises every campaign track with the pro driver (src/game/proDriver.ts) on every CPU core and writes
// src/track/proLaps.json: per class, each track's tuned driver settings and its lap time. Each track gets
// several independent practice sessions (one continuing from the stored lap, the others from seeded
// starting styles); the fastest clean lap is kept, and a stored lap is only replaced by a faster one.
// Run from the project root, like the other helper scripts:
//   npx esbuild scripts/pro-laps.ts --bundle --platform=node --format=esm --outfile=<tmp>/pro-laps.mjs && node <tmp>/pro-laps.mjs [car|bike|truck] [--laps N] [--seeds K] [--threads T] [ids...]
// Defaults: every class, 3000 laps a session, 3 seeded sessions plus the warm start, half the logical cores.
// It runs at the lowest OS priority (the machine stays usable; it only takes idle CPU) and records finished
// sessions in <tmp>/pro-laps.progress.json beside the bundle, so a stopped run carries on where it was
// (delete that file to start over). Rerun after any physics change: its times are the campaign's author times.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants as osConstants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { isVehicleClass, VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { practice, proGhost, type ProParams } from '../src/game/proDriver';
import type { ProLap, ProLapsTable } from '../src/game/proLaps';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

interface Task {
  cls: VehicleClass;
  id: string;
  seed: number;
  laps: number;
  start?: ProParams;
}
interface Done {
  task: Task;
  lap: ProLap | null;
  practised: number;
  ms: number;
}

/** Stored settings are rounded; the time is the rounded settings' own lap, so the game replays it exactly. */
function round(p: ProParams): ProParams {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { ...p, lat: r(p.lat), brake: r(p.brake), look0: r(p.look0), look1: r(p.look1), width: r(p.width), crest: r(p.crest), brakeSteer: r(p.brakeSteer), seg: p.seg.map(r) };
}

function work(t: Task): Done {
  const t0 = Date.now();
  const ct = campaign().find((c) => c.id === t.id)!;
  const r = practice(new Track(ct.data), t.cls, t.laps, { seed: t.seed, start: t.start });
  let lap: ProLap | null = null;
  if (r) {
    const params = round(r.params);
    const g = proGhost(new Track(ct.data), t.cls, params);
    if (g) lap = { time: g.time, params };
  }
  return { task: t, lap, practised: r?.laps ?? 0, ms: Date.now() - t0 };
}

/** The lowest priority for this process (all its threads): practice only takes CPU nothing else wants. */
function lowPriority(): void {
  try {
    setPriority(0, osConstants.priority.PRIORITY_LOW);
  } catch {
    // Not allowed here: run at normal priority.
  }
}

const taskKey = (t: Pick<Task, 'cls' | 'id' | 'seed'>) => `${t.cls} ${t.id} ${t.seed}`;

if (!isMainThread) {
  parentPort!.on('message', (t: Task) => parentPort!.postMessage(work(t)));
} else {
  lowPriority();
  const file = resolve(process.cwd(), 'src/track/proLaps.json');
  const args = process.argv.slice(2);
  const opt = (name: string, def: number) => {
    const i = args.indexOf(name);
    if (i < 0) return def;
    const v = Number(args[i + 1]);
    args.splice(i, 2);
    return v;
  };
  const laps = opt('--laps', 3000);
  const seeds = opt('--seeds', 3);
  const threadsWanted = opt('--threads', Math.max(1, Math.floor(availableParallelism() / 2)));
  const progressFile = fileURLToPath(new URL('./pro-laps.progress.json', import.meta.url));
  const finished = new Set<string>(existsSync(progressFile) ? (JSON.parse(readFileSync(progressFile, 'utf8')) as string[]) : []);
  const only = isVehicleClass(args[0]) ? (args.shift() as VehicleClass) : null;
  const ids = new Set(args);
  const classes: readonly VehicleClass[] = only ? [only] : VEHICLE_CLASSES;
  const old = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ProLapsTable) : null;
  const out: ProLapsTable = old && old.physics === PHYSICS_VERSION ? old : { physics: PHYSICS_VERSION, classes: {} };
  for (const cls of classes) if (out.classes[cls]?.rev !== VEHICLE_REV[cls]) out.classes[cls] = { rev: VEHICLE_REV[cls], laps: {} };

  const tasks: Task[] = [];
  for (const ct of campaign()) {
    if (ids.size && !ids.has(ct.id)) continue;
    for (const cls of classes) {
      const stored = out.classes[cls]!.laps[ct.id];
      const add = (t: Task) => {
        if (!finished.has(taskKey(t))) tasks.push(t);
      };
      if (stored) add({ cls, id: ct.id, seed: 0, laps, start: stored.params });
      for (let s = 1; s <= seeds; s++) add({ cls, id: ct.id, seed: s, laps });
    }
  }
  // Long tracks first, so the last sessions to finish are short ones.
  const len = new Map(campaign().map((c) => [c.id, c.data.blocks.length]));
  tasks.sort((a, b) => (len.get(b.id) ?? 0) - (len.get(a.id) ?? 0));

  const threads = Math.max(1, Math.min(tasks.length, threadsWanted));
  console.log(`${tasks.length} practice sessions of ${laps} laps on ${threads} threads (${finished.size} done before)`);
  if (!tasks.length) process.exit(0);
  let next = 0, done = 0;
  const t0 = Date.now();
  await new Promise<void>((finish) => {
    for (let w = 0; w < threads; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      const feed = () => {
        if (next < tasks.length) worker.postMessage(tasks[next++]);
        else void worker.terminate();
      };
      worker.on('message', (d: Done) => {
        done++;
        const { cls, id, seed } = d.task;
        const sec = out.classes[cls]!;
        const prev = sec.laps[id];
        const better = d.lap && (!prev || d.lap.time < prev.time);
        if (better) sec.laps[id] = d.lap!;
        const mins = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(
          `[${done}/${tasks.length} ${mins} min] ${cls} ${id} seed ${seed}: ${d.lap ? (d.lap.time / 1000).toFixed(2) + 's' : 'no clean lap'}` +
            `${better ? ' NEW BEST' : ` (best ${prev ? (prev.time / 1000).toFixed(2) : '-'}s)`}, ${d.practised} laps, ${(d.ms / 1000).toFixed(0)} s`,
        );
        if (better) writeFileSync(file, JSON.stringify(out) + '\n');
        finished.add(taskKey(d.task));
        writeFileSync(progressFile, JSON.stringify([...finished]));
        if (done === tasks.length) finish();
        else feed();
      });
      worker.on('error', (e) => {
        console.error(e);
        process.exit(1);
      });
      feed();
    }
  });
  writeFileSync(file, JSON.stringify(out) + '\n');
  // Workers still waiting for a task would keep the process alive.
  process.exit(0);
}
