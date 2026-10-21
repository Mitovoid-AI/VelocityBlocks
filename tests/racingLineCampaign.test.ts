import { beforeAll, describe, expect, it } from 'vitest';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { entryKey, VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { classAuthorTimes, type AuthorTable } from '../src/game/medals';
import {
  classLines,
  cornerSpeed,
  encodeLine,
  LAT_USE,
  lateralLimits,
  lineJob,
  loadStoredLines,
  LINE_STEP,
  minCurvatureOffsets,
  offsetRoute,
  paceHit,
  paceRun,
  Phase,
  runJob,
  sampleLine,
  traceOnCentre,
  type PaceDrive,
  type PacePilot,
  type RacingLineData,
  type StoredLines,
} from '../src/game/racingLine';
import { CAR, DRIFT_STEER, lineHalfWidth, maxLatAccel, vehicleSpec } from '../src/physics/vehicle';
import authorTimes_ from '../src/track/authorTimes.json';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import racingLines from '../src/track/racingLines.json';
import { nearestPoint, traceRoute, type Route } from '../src/track/route';
import { Track } from '../src/track/track';

// The precomputed lines load on first use (the game's bundle leaves them out): campaign line jobs need them.
beforeAll(() => loadStoredLines());

const author = authorTimes_ as { physics: number; times: Record<string, number> };
const stored = racingLines as StoredLines;

interface Paced {
  track: Track;
  base: Route;
  pilot: PacePilot;
  run: PaceDrive;
  d: RacingLineData;
}

const cache = new Map<string, Paced>();
/**
 * A campaign line computed step by step as paceLineJob does (with its retries), keeping the pieces.
 */
function paced(id: string, name: string, code: string, cls: VehicleClass = 'car'): Paced {
  let p = cache.get(`${cls}:${id}`);
  if (!p) {
    const S = vehicleSpec(cls);
    const track = new Track(buildTrack(`${id} ${name}`, code));
    const base = traceRoute(track);
    const e = runJob(minCurvatureOffsets(base.points, lateralLimits(track, base, lineHalfWidth(S))));
    const { pilot, run } = runJob(paceRun(track, offsetRoute(base, e), S));
    const d = run.trace ? runJob(sampleLine(run.trace, track, base)) : (null as unknown as RacingLineData);
    cache.set(`${cls}:${id}`, (p = { track, base, pilot, run, d }));
  }
  return p;
}

/** Curves of the centre line (one per run of arc points turning the same way), as distance ranges. */
function corners(base: Route): { s0: number; s1: number }[] {
  const pts = base.points;
  const out: { s0: number; s1: number; sg: number; last: number }[] = [];
  let sg = 0;
  for (let n = 0; n < pts.length - 1; n++) {
    if (!(pts[n].curv > 0)) continue;
    const a = pts[Math.max(0, n - 1)], b = pts[n + 1];
    const cross = a.hx * b.hz - a.hz * b.hx;
    if (Math.abs(cross) > 1e-4) sg = Math.sign(cross);
    const c = out[out.length - 1];
    if (c && c.sg === sg && c.last === n - 1) {
      c.s1 = pts[n].s;
      c.last = n;
    } else out.push({ s0: pts[n].s, s1: pts[n].s, sg, last: n });
  }
  return out;
}

/**
 * Crests the plan slows for (only the crest-limited retry has any), as the centre-line distance of
 * each one's slowest point.
 */
function crests(base: Route, pilot: PacePilot): number[] {
  const pts = pilot.route.points;
  const out: number[] = [];
  let hint = -1, last = -10, slowest = Infinity;
  for (let n = 0; n < pts.length; n++) {
    if (!(pilot.vLimit[n] < cornerSpeed(pts[n].curv, CAR))) continue;
    hint = nearestPoint(base, pts[n].x, pts[n].y, pts[n].z, hint);
    if (n - last > 2) {
      out.push(base.points[hint].s);
      slowest = Infinity;
    }
    if (pilot.vLimit[n] < slowest) {
      slowest = pilot.vLimit[n];
      out[out.length - 1] = base.points[hint].s;
    }
    last = n;
  }
  return out;
}

/** Start sample of each brake zone. */
function brakeZones(d: RacingLineData): number[] {
  const out: number[] = [];
  for (let i = 0; i < d.phase.length; i++) {
    if (d.phase[i] === Phase.Brake && (!i || d.phase[i - 1] !== Phase.Brake)) out.push(i);
  }
  return out;
}

const brakeShare = (d: RacingLineData) => d.phase.filter((p) => p === Phase.Brake).length / d.phase.length;

describe('campaign racing lines', () => {
  for (const [id, , name, code] of CAMPAIGN_DEFS) {
    it(`${id} ${name}: the pace car laps it cleanly, faster than the author time`, () => {
      const { base, run, d } = paced(id, name, code);
      expect(run.end).toBe('finished');
      if (author.physics === PHYSICS_VERSION) expect(d.time).toBeLessThan(author.times[id]);
      expect(d.x.length).toBe(Math.floor(base.length) + 1);
      for (let i = 1; i < d.s.length; i++) {
        expect(d.s[i] - d.s[i - 1]).toBeGreaterThan(0.3);
        expect(d.s[i] - d.s[i - 1]).toBeLessThan(2.5);
      }
      const shown = d.visible.reduce((a, v) => a + v, 0) / d.visible.length;
      expect(shown, 'drawn share').toBeGreaterThan(0.7);
    });

    it(`${id} ${name}: brakes at most once for each corner (or crest it slows for), and only for those`, () => {
      const { base, pilot, d } = paced(id, name, code);
      // A zone belongs to the first corner whose apex (middle) it starts before, or crest whose
      // slowest point it starts before.
      const fs = [
        ...corners(base).map((c) => ({ at: (c.s0 + c.s1) / 2, what: `corner at ${c.s0.toFixed(0)} m` })),
        ...crests(base, pilot).map((s) => ({ at: s, what: `crest at ${s.toFixed(0)} m` })),
      ].sort((a, b) => a.at - b.at);
      const per = fs.map(() => 0);
      for (const z of brakeZones(d)) {
        const f = fs.findIndex((f) => f.at >= z);
        expect(f, `brake zone at ${z} m is before no corner or crest`).toBeGreaterThanOrEqual(0);
        per[f]++;
      }
      for (let f = 0; f < fs.length; f++) expect(per[f], fs[f].what).toBeLessThanOrEqual(1);
    });

    it(`${id} ${name}: shows no brake where the pace car steered in the drift range`, () => {
      // Touch and keys brake at 1 (the brake bar at 0.55 or more): a player who brakes on red while
      // steering that hard at speed starts a drift the line never planned for.
      const { base, run, d } = paced(id, name, code);
      const t = run.trace!;
      const { s } = runJob(traceOnCentre(t, base));
      let red = 0;
      for (let k = 0; k < t.x.length; k++) {
        if (d.phase[Math.round(s[k] / LINE_STEP)] !== Phase.Brake) continue;
        red++;
        expect(Math.abs(t.steer[k]), `tick ${k} at ${s[k].toFixed(0)} m`).toBeLessThanOrEqual(DRIFT_STEER);
      }
      expect(red).toBeGreaterThan(0);
      // Nor does the pace car brake there.
      for (let k = 0; k < t.x.length; k++) if (t.brake[k] > 0) expect(Math.abs(t.steer[k])).toBeLessThanOrEqual(DRIFT_STEER);
    });

    it(`${id} ${name}: the pace car fires its nitro, shown violet, and never brakes while it pushes`, () => {
      const { base, run, d } = paced(id, name, code);
      const t = run.trace!;
      expect(t.nitro!.some((on) => on === 1)).toBe(true);
      // drivePace counts them (paceRun skips a no-nitro retry of a lap that never fired one).
      expect(run.nitros).toBeGreaterThan(0);
      // A push runs from one tick to the next with the brake up (braking would end it).
      for (let k = 1; k < t.x.length; k++) if (t.nitro![k - 1] && t.nitro![k]) expect(t.brake[k], `tick ${k}`).toBe(0);
      const violet = d.phase.reduce((n, p) => n + (p === Phase.Nitro ? 1 : 0), 0);
      expect(violet).toBeGreaterThan(20);
      // Where the line is violet, the pace car's nitro was on (at speed some samples get no tick of their own).
      const { s } = runJob(traceOnCentre(t, base));
      const on = new Uint8Array(d.phase.length + 1);
      for (let k = 0; k < t.x.length; k++) if (t.nitro![k]) on[Math.round(s[k] / LINE_STEP)] = 1;
      for (let i = 0; i < d.phase.length; i++) if (d.phase[i] === Phase.Nitro) expect(on[i] || on[i - 1] || on[i + 1], `sample ${i}`).toBe(1);
    });

    it(`${id} ${name}: the precomputed line is current`, () => {
      const { track, base, d } = paced(id, name, code);
      // A stale table makes every campaign race compute its line on the phone (scripts/racing-lines.ts).
      expect(stored.physics, 'racingLines.json is for this PHYSICS_VERSION').toBe(PHYSICS_VERSION);
      expect(stored.lines[id]).toEqual(encodeLine(d, base.length));
      expect(runJob(lineJob(`c:${id}`, track))).toEqual(d);
    });
  }

  it('brakes on less than a fifth of the lap on A01 and A05', () => {
    for (const id of ['A01', 'A05']) {
      const [, , name, code] = CAMPAIGN_DEFS.find((c) => c[0] === id)!;
      expect(brakeShare(paced(id, name, code).d), id).toBeLessThan(0.2);
    }
  });

  it("reaches the cornering the planner assumes from the physics' limits", () => {
    // Where the plan is at a corner limit and the car at the planned speed, the lateral acceleration
    // driven must be within 15% of LAT_USE * maxLatAccel(v): a physics change that leaves the planner's
    // limits stale fails here.
    const ratios: number[] = [];
    for (const [id, , name, code] of CAMPAIGN_DEFS) {
      const { pilot, run } = paced(id, name, code);
      const t = run.trace!;
      let hint = -1;
      for (let k = 5; k < t.x.length - 5; k++) {
        hint = nearestPoint(pilot.route, t.x[k], t.y[k], t.z[k], hint);
        const lim = pilot.vLimit[hint];
        const atLimit = lim < 199 && pilot.vTarget[hint] >= 0.98 * lim && Math.abs(t.v[k] - lim) <= 0.05 * lim;
        if (!atLimit || !t.onRoad[k]) continue;
        let lat = 0;
        for (let j = k - 5; j <= k + 5; j++) lat += t.lat[j] / 11;
        ratios.push(lat / (LAT_USE * maxLatAccel(t.v[k], CAR)));
      }
    }
    ratios.sort((a, b) => a - b);
    expect(ratios.length).toBeGreaterThan(500);
    const median = ratios[ratios.length >> 1];
    expect(median).toBeGreaterThan(0.85);
    expect(median).toBeLessThan(1.15);
  });
});

// The Bike and the Truck have their own lines (their own limits, trail-braking pace laps), stored per class.
describe.each(['bike', 'truck'] as const)('campaign racing lines: %s', (cls) => {
  const authorTimes = classAuthorTimes(authorTimes_ as AuthorTable, cls)!;

  it('has a current section', () => {
    expect(stored.physics).toBe(PHYSICS_VERSION);
    expect(stored[cls]?.rev, `racingLines.json ${cls} section is for VEHICLE_REV ${VEHICLE_REV[cls]}`).toBe(VEHICLE_REV[cls]);
  });

  for (const [id, , name, code] of CAMPAIGN_DEFS) {
    it(`${id} ${name}: the precomputed line is current, drawn, and beats the author time`, () => {
      const { track, base, d } = paced(id, name, code, cls);
      expect(d, 'the pace lap finishes cleanly').not.toBeNull();
      expect(classLines(stored, cls)![id]).toEqual(encodeLine(d, base.length));
      expect(runJob(lineJob(entryKey(`c:${id}`, cls, false), track))).toEqual(d);
      expect(d.time).toBeLessThan(authorTimes[id]);
      const shown = d.visible.reduce((a, v) => a + v, 0) / d.visible.length;
      expect(shown, 'drawn share').toBeGreaterThan(0.7);
    });
  }
});

// A line teaches braking points, so its pace lap must not have run into anything: drivePace treats a stop
// (checked every 10 ticks) or a barrier hit as a crash and paceRun retries more cautiously, and a lap that
// crashed every time is no line at all. The A10 hairpin at the top of a climb after a turbo pad caught every
// class before (the bike's stored line crashed twice).
describe.each(VEHICLE_CLASSES)('campaign racing lines: the %s pace laps are clean', (cls) => {
  for (const [id, , name, code] of CAMPAIGN_DEFS) {
    it(`${id} ${name}`, () => {
      const { run } = paced(id, name, code, cls);
      expect(run.end).toBe('finished');
      expect(run.trace, 'a clean try').not.toBeNull();
      expect(run.crashed, 'crashed on the way').not.toBe(true);
      expect(paceHit(run.trace!), 'tick of a barrier hit (40 km/h lost in 0.05 s on the road)').toBe(-1);
    });
  }
});

describe('racing lines and walls on all roads', () => {
  it('a walled track gets the open-road line, for every class', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const id of ['A03', 'A05']) {
        const [, , name, code] = CAMPAIGN_DEFS.find((c) => c[0] === id)!;
        const data = buildTrack(`${id} ${name}`, code);
        const open = runJob(lineJob(entryKey(`c:${id}`, cls, false), new Track(data)));
        const walled = runJob(lineJob(entryKey(`c:${id}`, cls, true), new Track(data, { walls: true })));
        expect(walled, `${cls} ${id}`).toEqual(open);
      }
    }
    // A custom track computes its line on the open road too.
    const data = buildTrack('custom', 'St Sx2 R Sx2 C Sx2 L2 Sx2 F');
    expect(runJob(lineJob('u:x|w', new Track(data, { walls: true })))).toEqual(runJob(lineJob('u:x', new Track(data))));
  });
});
