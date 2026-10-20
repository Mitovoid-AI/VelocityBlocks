import { afterEach, describe, expect, it, vi } from 'vitest';
import { DT } from '../src/core/constants';
import {
  BRAKE_USE,
  cornerSpeed,
  decodeLine,
  drivePace,
  encodeLine,
  LAT_USE,
  lateralLimits,
  lineable,
  lineColors,
  LineJobs,
  lineDistanceAt,
  LINE_HALF_WIDTH,
  minCurvatureOffsets,
  nearestSample,
  NITRO_RGB,
  offsetRoute,
  PacePilot,
  paceLineJob,
  PAD_HALF_WIDTH,
  Phase,
  planSpeeds,
  runJob,
  sampleCount,
  sampleLine,
  smoothPhases,
  type PaceTrace,
  type Pilot,
  type RacingLineData,
} from '../src/game/racingLine';
import { CAR, DRIFT_STEER, maxBrakeDecel, maxLatAccel } from '../src/physics/vehicle';
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
import { traceRoute, type Route } from '../src/track/route';
import { Track } from '../src/track/track';

const trackOf = (code: string) => new Track(buildTrack('t', code));
const campaignTrack = (id: string) => {
  const [, , name, code] = CAMPAIGN_DEFS.find((d) => d[0] === id)!;
  return new Track(buildTrack(`${id} ${name}`, code));
};
const offsets = (track: Track, base: Route) => runJob(minCurvatureOffsets(base.points, lateralLimits(track, base)));
const { Throttle: T, Lift: L, Brake: B, Nitro: N } = Phase;
const ph = (...runs: [number, number][]) => Uint8Array.from(runs.flatMap(([p, n]) => Array(n).fill(p)));

describe('minimum-curvature line', () => {
  it('stays on the centre of a straight', () => {
    const track = trackOf('St Sx4 F');
    const e = offsets(track, traceRoute(track));
    for (const v of e) expect(Math.abs(v)).toBeLessThan(1e-9);
  });

  it('goes outside, apex, outside through a corner, mirrored for a left', () => {
    for (const [code, sign] of [['St Sx3 R Sx3 F', 1], ['St Sx3 L Sx3 F', -1]] as const) {
      const track = trackOf(code);
      const base = traceRoute(track);
      const e = offsets(track, base);
      const pts = base.points;
      const a0 = pts.findIndex((p) => p.curv > 0);
      let a1 = a0;
      while (pts[a1 + 1].curv > 0) a1++;
      const at = (s: number) => e[pts.findIndex((p) => p.s >= s)] * sign;
      // Positive offsets are to the right, the inside of a right-hander.
      expect(at(pts[a0].s - 20), code).toBeLessThan(-1.5);
      expect(e[Math.round((a0 + a1) / 2)] * sign, code).toBeGreaterThan(2.5);
      expect(at(pts[a1].s + 20), code).toBeLessThan(-1.5);
      // A wider, gentler arc than the R16 centre line.
      for (const p of offsetRoute(base, e).points) expect(p.curv).toBeLessThan(1 / 16);
    }
  });

  it('keeps every offset within its limit and pinned points on the centre', () => {
    const track = campaignTrack('A04');
    const base = traceRoute(track);
    const lim = lateralLimits(track, base);
    const e = runJob(minCurvatureOffsets(base.points, lim));
    let pinned = 0;
    for (let n = 0; n < e.length; n++) {
      expect(Math.abs(e[n])).toBeLessThanOrEqual(lim[n] + 1e-12);
      if (lim[n] === 0) {
        expect(e[n]).toBe(0);
        pinned++;
      }
    }
    expect(pinned).toBeGreaterThan(10);
  });

  it('pins the start, jump gaps and ramps with a margin, and narrows over pads', () => {
    // A04 First Flight: St S T Sx2 U S C S J G G Sx3 C S R2 S D Sx2 F
    const track = campaignTrack('A04');
    const base = traceRoute(track);
    const lim = lateralLimits(track, base);
    const pts = base.points;
    const onType = (n: number, type: string) =>
      track.blocksAt(pts[n].x, pts[n].z)?.some((b) => b.def.type === type && Math.abs(b.baseY - pts[n].y) < 2.5);
    let air = 0, ramp = 0, pad = 0;
    for (let n = 0; n < pts.length; n++) {
      const near = (f: (m: number) => boolean) => {
        for (let m = Math.max(0, n - 3); m <= Math.min(pts.length - 1, n + 3); m++) if (f(m)) return true;
        return false;
      };
      if (near((m) => pts[m].s < 12 || pts[m].air || !!onType(m, 'ramp'))) expect(lim[n], `point ${n}`).toBe(0);
      else expect(lim[n], `point ${n}`).toBeGreaterThan(0);
      if (pts[n].air) air++;
      if (onType(n, 'ramp')) ramp++;
      if (lim[n] === PAD_HALF_WIDTH) pad++;
    }
    expect(air).toBeGreaterThan(10);
    expect(ramp).toBeGreaterThan(10);
    expect(pad).toBeGreaterThan(8);
    expect(Math.max(...lim)).toBe(LINE_HALF_WIDTH);
  });

  it('offsetRoute recomputes distances, headings and curvature', () => {
    const track = campaignTrack('A04');
    const base = traceRoute(track);
    const line = offsetRoute(base, offsets(track, base));
    const flat = offsetRoute(base, new Float64Array(base.points.length));
    for (let n = 0; n < line.points.length; n++) {
      const p = line.points[n], q = base.points[n];
      if (n) expect(p.s).toBeGreaterThan(line.points[n - 1].s);
      expect(Math.hypot(p.hx, p.hz)).toBeCloseTo(1, 6);
      expect(p.air).toBe(q.air);
      expect(p.y).toBe(q.y);
      // With no offset, straights stay straight (away from the curve's ends).
      const near = base.points.slice(Math.max(0, n - 4), n + 5);
      if (near.every((q) => q.curv === 0)) expect(flat.points[n].curv).toBe(0);
    }
    expect(line.length).toBe(line.points[line.points.length - 1].s);
  });
});

describe('pace planner', () => {
  it("takes a curve at the share of the physics' cornering limit it plans with", () => {
    expect(cornerSpeed(0, CAR)).toBe(200);
    let last = Infinity;
    for (const k of [1 / 100, 1 / 48, 1 / 16]) {
      const v = cornerSpeed(k, CAR);
      expect(v).toBeLessThan(200);
      expect(Math.abs((v * v * k) / (LAT_USE * maxLatAccel(v, CAR)) - 1), `k = ${k}`).toBeLessThan(1e-3);
      expect(v).toBeLessThan(last);
      last = v;
    }
  });

  it('brakes back from every limit within the braking it plans with, and never in the air', () => {
    const line = traceRoute(trackOf('St Sx3 J G G Sx3 R Sx3 F'));
    const pts = line.points;
    const { vLimit, vTarget } = runJob(planSpeeds(line, false, CAR));
    let air = 0;
    for (let n = 0; n < pts.length; n++) {
      expect(vTarget[n]).toBeLessThanOrEqual(vLimit[n]);
      if (n === pts.length - 1) continue;
      const ds = pts[n + 1].s - pts[n].s;
      const next = vTarget[n + 1];
      expect(vTarget[n] ** 2).toBeLessThanOrEqual(next ** 2 + 2 * BRAKE_USE * maxBrakeDecel(next, CAR) * ds + 1e-6);
      if (pts[n].air || pts[n + 1].air) {
        expect(vTarget[n], `point ${n}`).toBeLessThanOrEqual(next + 1e-9);
        air++;
      }
    }
    expect(air).toBeGreaterThan(5);
    // The corner brakes the straight before it.
    expect(Math.min(...vLimit)).toBeLessThan(60);
    expect(vTarget.some((v, n) => v < vLimit[n] - 5)).toBe(true);
  });
});

describe('phase smoothing', () => {
  it('joins and drops short runs', () => {
    expect(smoothPhases(ph([B, 3], [L, 1], [B, 3]))).toEqual(ph([B, 7]));
    expect(smoothPhases(ph([T, 10], [B, 1], [T, 10]))).toEqual(ph([T, 21]));
    expect(smoothPhases(ph([T, 10], [L, 2], [B, 10]))).toEqual(ph([T, 12], [B, 10]));
    // A lift between two brake runs is one brake zone, unless it is long; throttle always splits them.
    expect(smoothPhases(ph([T, 5], [B, 10], [L, 30], [B, 10], [T, 5]))).toEqual(ph([T, 5], [B, 50], [T, 5]));
    for (const gap of [ph([L, 60]), ph([T, 20])]) {
      const kept = Uint8Array.from([...ph([T, 5], [B, 10]), ...gap, ...ph([B, 10], [T, 5])]);
      expect(smoothPhases(kept)).toEqual(kept);
    }
  });

  it('never paints brake on a sample marked no-brake', () => {
    // The lift between two brakes is joined but for its marked samples; a short marked run after a
    // brake keeps its phase.
    const raw = ph([T, 5], [B, 10], [L, 8], [B, 10], [L, 2], [T, 10]);
    const no = new Uint8Array(raw.length);
    no.fill(1, 18, 20);
    no.fill(1, 33, 35);
    const out = smoothPhases(raw, no);
    expect(out).toEqual(ph([T, 5], [B, 13], [L, 2], [B, 13], [L, 2], [T, 10]));
    for (let i = 0; i < out.length; i++) if (no[i]) expect(out[i]).not.toBe(B);
    expect(smoothPhases(out, no)).toEqual(out);
    expect(smoothPhases(raw)).toEqual(ph([T, 5], [B, 30], [T, 10]));
  });

  it('keeps the length and is idempotent', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 50; k++) {
      const raw = Uint8Array.from({ length: 120 }, () => Math.floor(rnd() * 3));
      const once = smoothPhases(raw);
      expect(once.length).toBe(raw.length);
      expect(smoothPhases(once)).toEqual(once);
    }
  });
});

/** A synthetic pace trace along the centre line of a straight track from the spawn (s = 9). */
function straightTrace(
  track: Track,
  ticks: number,
  v0: number,
  accel: number,
  gas: number,
  brake: number,
  offRoad: [number, number] = [-1, -1],
): PaceTrace {
  const sp = track.spawn();
  const t: PaceTrace = { x: [], y: [], z: [], v: [], gas: [], brake: [], steer: [], onRoad: [], lat: [], time: ticks * 10 };
  let d = 0, v = v0;
  for (let k = 0; k <= ticks; k++) {
    t.x.push(sp.x + sp.hx * d);
    t.y.push(sp.y + 0.6);
    t.z.push(sp.z + sp.hz * d);
    t.v.push(v);
    t.gas.push(gas);
    t.brake.push(brake);
    t.steer.push(0);
    t.onRoad.push(k >= offRoad[0] && k <= offRoad[1] ? 0 : 1);
    t.lat.push(0);
    d += v * DT;
    v = Math.max(0, v + accel * DT);
  }
  return t;
}

describe('sampling', () => {
  const track = trackOf('St Sx4 F');
  const base = traceRoute(track);

  it('puts one sample per metre of centre line on the road, visible where driven on the road', () => {
    // 200 ticks at 20 m/s: 40 m from the spawn at 9 m; ticks 100-110 (29-31 m) off the road.
    const d = runJob(sampleLine(straightTrace(track, 200, 20, 0, 1, 0, [100, 110]), track, base));
    expect(d.x.length).toBe(sampleCount(base.length));
    const shown: number[] = [];
    for (let i = 0; i < d.x.length; i++) {
      if (d.visible[i]) shown.push(i);
      expect(d.y[i]).toBeCloseTo(track.surfaceAt(d.x[i], d.y[i] + 1, d.z[i]).y, 5);
      if (i) expect(d.s[i] - d.s[i - 1]).toBeCloseTo(1, 4);
    }
    const [first, last] = [shown[0], shown[shown.length - 1]];
    expect(Math.abs(first - 9)).toBeLessThanOrEqual(1);
    expect(Math.abs(last - 49)).toBeLessThanOrEqual(1);
    for (const i of [29, 30, 31]) expect(d.visible[i]).toBe(0);
    expect(shown.length).toBe(last - first + 1 - 3);
    for (const i of shown) expect(d.phase[i]).toBe(Phase.Throttle);
    expect(Math.max(...d.e.map(Math.abs))).toBeLessThan(0.05);
  });

  it('reads braking from the deceleration and a part throttle as a lift', () => {
    const braking = runJob(sampleLine(straightTrace(track, 150, 60, -25, 0, 1), track, base));
    const lifting = runJob(sampleLine(straightTrace(track, 200, 30, 0, 0.3, 0), track, base));
    const coasting = runJob(sampleLine(straightTrace(track, 200, 30, -4, 0, 0), track, base));
    for (let i = 12; i < 60; i++) {
      expect(braking.phase[i], `${i}`).toBe(Phase.Brake);
      expect(braking.brake[i]).toBeGreaterThan(0.3);
      expect(lifting.phase[i]).toBe(Phase.Lift);
      expect(coasting.phase[i]).toBe(Phase.Lift);
    }
    expect(Math.max(...braking.brake)).toBeLessThanOrEqual(1);
    // The same braking while steering in the drift range is a lift: a full pedal there would drift.
    const steered = straightTrace(track, 150, 60, -25, 0, 1);
    steered.steer = steered.steer.map(() => DRIFT_STEER + 0.05);
    const hard = runJob(sampleLine(steered, track, base));
    for (let i = 12; i < 60; i++) expect(hard.phase[i], `${i}`).toBe(Phase.Lift);
  });

  it('encodes two bytes a sample and decodes to the same line', () => {
    const d = runJob(sampleLine(straightTrace(track, 400, 20, 0, 1, 0, [100, 110]), track, base));
    const st = encodeLine(d, base.length);
    expect(atob(st.data).length).toBe(2 * d.x.length);
    const back = runJob(decodeLine(track, st))!;
    expect(back).toEqual(d);
    // A different layout does not take it.
    expect(runJob(decodeLine(trackOf('St Sx5 F'), st))).toBeNull();
  });

  it("marks where the pace car's nitro pushed, and stores it next to full brakes", () => {
    // 20 m/s from the spawn at 9 m: the nitro on for ticks 50-150 (19-39 m).
    const t = straightTrace(track, 250, 20, 0, 1, 0);
    t.nitro = t.x.map((_, k) => (k >= 50 && k <= 150 ? 1 : 0));
    const d = runJob(sampleLine(t, track, base));
    for (let i = 21; i <= 37; i++) expect(d.phase[i], `${i}`).toBe(Phase.Nitro);
    for (const i of [12, 16, 42, 50]) expect(d.phase[i], `${i}`).toBe(Phase.Throttle);
    // Every phase and the strongest brake round-trip (the brake bits sit next to the phase bits).
    for (let i = 52; i < 58; i++) {
      d.phase[i] = Phase.Brake;
      d.brake[i] = 1;
    }
    const back = runJob(decodeLine(track, encodeLine(d, base.length)))!;
    expect(back.phase).toEqual(d.phase);
    expect(back.brake).toEqual(d.brake);
    expect(new Set(back.phase)).toEqual(new Set([Phase.Throttle, Phase.Nitro, Phase.Brake]));
  });
});

describe('pace drive', () => {
  // One checkpoint off the traced chain, beside the first straight: the route is complete, but the
  // finish never counts.
  const offChain = new Track({
    ...buildTrack('off', 'St Sx3 R Sx3 F'),
    blocks: [...buildTrack('off', 'St Sx3 R Sx3 F').blocks, { type: 'checkpoint', i: 20, j: 20, k: 0, dir: 0 }],
  });

  it('refuses a track with a checkpoint off the route before driving', () => {
    const base = traceRoute(offChain);
    expect(base.complete).toBe(true);
    expect(lineable(offChain, base)).toBe(false);
    const job = paceLineJob(offChain);
    expect(job.next()).toEqual({ done: true, value: null });
  });

  it('stops at the first missing-checkpoint finish', () => {
    const base = traceRoute(offChain);
    const run = runJob(drivePace(offChain, new PacePilot(offsetRoute(base, offsets(offChain, base)))));
    expect(run.end).toBe('missing');
    expect(run.trace).toBeNull();
    expect(run.ticks).toBeLessThan(2000);
  });

  it('gives up when the car makes no progress or falls', () => {
    const track = trackOf('St Sx6 F');
    const route = traceRoute(track);
    const reverse: Pilot = { route, controls: () => ({ steer: 0, gas: 0, brake: 1 }) };
    const stuck = runJob(drivePace(track, reverse));
    expect(stuck.end).toBe('stuck');
    expect(stuck.ticks).toBeLessThan(600);

    // Too slow for the jump on a high deck: it drops into the gap.
    const high = trackOf('@2 St S J G G Sx2 F');
    const crawl: Pilot = { route: traceRoute(high), controls: () => ({ steer: 0, gas: 0.25, brake: 0 }) };
    const fell = runJob(drivePace(high, crawl));
    expect(fell.end).toBe('fell');
    expect(fell.ticks).toBeLessThan(2000);
  });

  it('has no line without a finish', () => {
    expect(runJob(paceLineJob(trackOf('St Sx3')))).toBeNull();
  });
});

describe('lookups and colours', () => {
  it('tracks the upper deck where the line crosses over itself', () => {
    // Climbs, turns back and crosses over its own first straight.
    const d = runJob(paceLineJob(trackOf('St Sx4 U S R R Sx6 R Sx3 D F')))!;
    let pair: [number, number] | null = null;
    for (let i = 0; i < d.x.length && !pair; i++) {
      if (!d.visible[i]) continue;
      for (let j = 0; j < d.x.length; j++) {
        if (d.visible[j] && d.y[i] - d.y[j] > 6 && Math.hypot(d.x[i] - d.x[j], d.z[i] - d.z[j]) < 1.5) {
          pair = [i, j];
          break;
        }
      }
    }
    expect(pair).not.toBeNull();
    const [up] = pair!;
    const [x, y, z] = [d.x[up], d.y[up] + 0.6, d.z[up]];
    // After a teleport the hint is far off: everything in its window is over 40 m away.
    const far = d.x.findIndex((_, h) => {
      for (let i = Math.max(0, h - 30); i < Math.min(d.x.length, h + 120); i++) {
        if (Math.hypot(d.x[i] - x, (d.y[i] - y) * 2, d.z[i] - z) < 45) return false;
      }
      return true;
    });
    expect(far).toBeGreaterThanOrEqual(0);
    for (const hint of [-1, up - 5, far]) {
      const i = nearestSample(d, x, y, z, hint);
      expect(Math.abs(d.y[i] - d.y[up]), `hint ${hint}`).toBeLessThan(1.5);
      expect(Math.abs(i - up)).toBeLessThan(3);
    }
    // Between samples the distance along the line is interpolated.
    const mx = (d.x[up] + d.x[up + 1]) / 2, mz = (d.z[up] + d.z[up + 1]) / 2;
    expect(lineDistanceAt(d, up, mx, mz)).toBeCloseTo((d.s[up] + d.s[up + 1]) / 2, 3);
  });

  it('colours throttle green, lift yellow and brake orange to red', () => {
    const n = 40;
    const d = {
      phase: ph([T, 10], [L, 10], [B, 10], [B, 10]),
      brake: Float32Array.from({ length: n }, (_, i) => (i >= 30 ? 1 : i >= 20 ? 0.3 : 0)),
    } as unknown as RacingLineData;
    const c = lineColors(d);
    const rgb = (i: number) => Array.from(c.subarray(i * 3, i * 3 + 3));
    for (const v of c) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const [tr, tg] = rgb(5), [lr, lg, lb] = rgb(15), [br, bg] = rgb(25), [hr, hg] = rgb(35);
    expect(tg).toBeGreaterThan(tr);
    expect(lr).toBeGreaterThan(0.9);
    expect(lg).toBeGreaterThan(0.6);
    expect(lb).toBeLessThan(0.2);
    expect(br).toBeGreaterThan(0.9);
    // Harder braking is redder.
    expect(hg).toBeLessThan(bg);
    expect(hr).toBeGreaterThan(0.9);
    // Auto-accelerate cannot lift: lifts are painted as throttle.
    expect(rgb(15)).not.toEqual(rgb(5));
    const auto = lineColors(d, true);
    expect(Array.from(auto.subarray(45, 48))).toEqual(rgb(5));
  });

  it('colours the nitro violet, with lifts as throttle or not', () => {
    const d = { phase: ph([T, 10], [N, 10], [T, 10]), brake: new Float32Array(30) } as unknown as RacingLineData;
    for (const auto of [false, true]) {
      const c = lineColors(d, auto);
      expect(Array.from(c.subarray(15 * 3, 15 * 3 + 3)).map((v) => +v.toFixed(5))).toEqual(NITRO_RGB.map((v) => +v.toFixed(5)));
      expect(c[15 * 3 + 2]).toBeGreaterThan(c[15 * 3 + 1]);
      expect(c[3 * 3 + 1]).toBeGreaterThan(c[3 * 3 + 2]);
    }
  });
});

describe('line jobs', () => {
  afterEach(() => vi.restoreAllMocks());

  const line = (tag: number) => ({ time: tag }) as unknown as RacingLineData;
  /** A fake clock that advances 1 ms per job slice, and jobs that take `steps` slices. */
  function setup(steps: Record<string, number | 'fail' | 'throw'>, max = 8) {
    let clock = 0;
    const made: string[] = [];
    const advanced: string[] = [];
    function* job(key: string): Generator<void, RacingLineData | null> {
      const n = steps[key] ?? 1;
      for (let i = 0; i < (typeof n === 'number' ? n : 2); i++) {
        clock++;
        advanced.push(key);
        yield;
      }
      clock++;
      if (n === 'throw') throw new Error('boom');
      return n === 'fail' ? null : line(key.length);
    }
    const jobs = new LineJobs(
      (key) => {
        made.push(key);
        return job(key);
      },
      max,
      () => clock,
    );
    return { jobs, made, advanced, now: () => clock };
  }
  const track = {} as Track;

  it('computes on pump, then serves from the cache without a job', () => {
    const { jobs, made } = setup({ a: 3 });
    expect(jobs.peek('a')).toBeUndefined();
    const got: (RacingLineData | null)[] = [];
    jobs.request('a', track, (d) => got.push(d));
    jobs.pump(100);
    expect(got).toEqual([line(1)]);
    expect(jobs.peek('a')).toEqual(line(1));
    jobs.request('a', track, (d) => got.push(d));
    expect(got.length).toBe(2);
    expect(made).toEqual(['a']);
    expect(jobs.busy).toBe(false);
  });

  it('caches a failure and does not retry it', () => {
    const { jobs, made } = setup({ a: 'fail' });
    const got: (RacingLineData | null)[] = [];
    jobs.request('a', track, (d) => got.push(d));
    jobs.pump(100);
    jobs.request('a', track, (d) => got.push(d));
    expect(got).toEqual([null, null]);
    expect(jobs.peek('a')).toBeNull();
    expect(made).toEqual(['a']);
  });

  it('stores null when a job throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { jobs } = setup({ a: 'throw' });
    let got: RacingLineData | null | undefined;
    jobs.request('a', track, (d) => (got = d));
    jobs.pump(100);
    expect(got).toBeNull();
    expect(jobs.peek('a')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('runs a request before a prefetch, and reuses a prefetched job', () => {
    const { jobs, made, advanced } = setup({ next: 5, cur: 5 });
    jobs.prefetch('next', track);
    jobs.request('cur', track, () => {});
    jobs.pump(2.5);
    expect(advanced).toEqual(['cur', 'cur', 'cur']);
    let got: RacingLineData | null = null;
    jobs.request('next', track, (d) => (got = d));
    jobs.pump(1000);
    expect(made).toEqual(['next', 'cur']);
    expect(advanced.indexOf('next')).toBe(3);
    expect(got).toEqual(line(4));
    expect(jobs.peek('cur')).toEqual(line(3));
  });

  it('stops within one slice of the budget', () => {
    const { jobs, now } = setup({ a: 50 });
    jobs.request('a', track, () => {});
    jobs.pump(3.5);
    expect(now()).toBe(4);
    jobs.pump(0);
    expect(now()).toBe(5);
  });

  it('drops a cancelled job unless it was prefetched', () => {
    const { jobs, advanced } = setup({ a: 5, b: 5 });
    const cancelA = jobs.request('a', track, () => {});
    jobs.pump(1.5);
    cancelA();
    expect(jobs.busy).toBe(false);
    jobs.pump(10);
    expect(advanced).toEqual(['a', 'a']);
    expect(jobs.peek('a')).toBeUndefined();

    jobs.prefetch('b', track);
    const cancelB = jobs.request('b', track, () => {});
    cancelB();
    expect(jobs.busy).toBe(true);
    jobs.pump(100);
    expect(jobs.peek('b')).toEqual(line(1));
  });

  it('keeps the most recently used lines', () => {
    const { jobs } = setup({}, 2);
    for (const k of ['a', 'b']) jobs.request(k, track, () => {});
    jobs.pump(100);
    jobs.peek('a');
    jobs.request('c', track, () => {});
    jobs.pump(100);
    expect(jobs.peek('b')).toBeUndefined();
    expect(jobs.peek('a')).toBeDefined();
    expect(jobs.peek('c')).toBeDefined();
  });

  it('works a little every frame while racing, and not after a slow frame', () => {
    const { jobs, now } = setup({ a: 100 });
    jobs.request('a', track, () => {});
    jobs.pumpFrame(0.02, true);
    expect(now()).toBe(0);
    jobs.pumpFrame(0.016, true);
    expect(now()).toBe(2);
    jobs.pumpFrame(0.05, false);
    expect(now()).toBe(8);
  });
});
