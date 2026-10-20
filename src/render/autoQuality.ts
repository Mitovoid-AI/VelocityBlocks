// Auto graphics quality: measures frame times while driving and (1) scales the pixel ratio within the
// tier at once, which is cheap (a canvas resize between two frames), and (2) when the lowest pixel ratio
// still cannot hold the frame rate, asks for the next tier down, which App applies at a quiet moment
// (pause, 3-2-1, the results once the card has played, the menus): a tier change rebuilds the stadium
// and recompiles shaders, a stall nobody should feel in the middle of a corner.
// Pure (no DOM, no three), so the decisions are unit-tested (tests/autoQuality.test.ts).

import type { Quality } from './quality';

export const TIERS: readonly Quality[] = ['low', 'medium', 'high'];

export const isQuality = (v: unknown): v is Quality => v === 'low' || v === 'medium' || v === 'high';

/** -1, 0 or 1 as a is below, equal to or above b. */
export const tierCmp = (a: Quality, b: Quality): number => Math.sign(TIERS.indexOf(a) - TIERS.indexOf(b));

/**
 * Pixel-ratio steps of the in-race scaler per tier, sharpest first. Each tier's first step is its
 * QUALITY maxDpr; the last ones bridge to the tier below until it can be applied.
 */
export const DPR_STEPS: Readonly<Record<Quality, readonly number[]>> = {
  high: [2, 1.75, 1.5, 1.25],
  medium: [1.5, 1.25, 1],
  low: [1, 0.85, 0.75],
};

/** The tier's steps on a device: none above the device's own ratio, no repeats. */
export function dprSteps(q: Quality, deviceDpr: number): number[] {
  const d = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  const out: number[] = [];
  for (const s of DPR_STEPS[q]) {
    const v = Math.min(d, s);
    if (!out.length || v < out[out.length - 1] - 1e-6) out.push(v);
  }
  return out;
}

export const AUTO = {
  /** Driving time per verdict (ms). */
  windowMs: 2500,
  /** Driving time skipped after GO, a resume or a tier change (first nitro, first ghost, compiles). */
  warmupMs: 1500,
  /** Driving time skipped after a pixel-ratio change (the canvas resize itself). */
  settleMs: 500,
  /** The slowest share of a window's frames left out of its average (stray GC or texture uploads). */
  trim: 0.05,
  /** A gap this long is a hitch (load, ad, compile), not a frame rate: never counted. */
  hitchMs: 150,
  /** Below this the device is not holding about 55 fps: one step down. */
  slowFps: 54,
  /** Below this: two steps down at once. */
  verySlowFps: 42,
  /** Below this with the tier's top pixel ratio: the tier itself is too heavy, step down without waiting. */
  hopelessFps: 30,
  /** Holding the display's 60 Hz with the JS work per frame under okWorkMs counts as a good window. */
  goodFps: 58,
  okWorkMs: 6,
  /** Good windows in a row before the pixel ratio goes back up a step. */
  raiseWindows: 4,
  /**
   * Average frame rate that proves room for the next tier (only a 90/120 Hz display can show it: at
   * 60 Hz the frame rate cannot tell 30% from 95% GPU load), held for tierUpWindows windows.
   */
  tierUpFps: 100,
  tierUpWindows: 3,
  /**
   * A step down (pixel ratio or tier) that did not lift the frame rate by this factor gained nothing: the
   * frame rate is not bound by what it cut (a 30 fps cap, or load it does not touch). It is undone or
   * held, never banned, and a tier it left is not marked failed.
   */
  gainMin: 1.05,
  /**
   * A frame rate this near capFps with the JS work per frame under capWorkMs is a cap (battery saver,
   * Chrome's Energy Saver), not load: Auto never lowers the tier for it.
   */
  capFps: 30,
  capBelow: 3,
  capAbove: 2,
  capWorkMs: 8,
} as const;

export interface WindowStats {
  /** Average frames per second of the kept frames (the slowest `trim` share left out). */
  fps: number;
  /** 90th percentile of the JS work per frame (update + render calls), ms. */
  workMs: number;
  frames: number;
}

/** True when a slow window looks like a frame-rate cap (about 30 fps with little JS work), not load. */
export function looksCapped(s: WindowStats): boolean {
  return s.fps >= AUTO.capFps - AUTO.capBelow && s.fps <= AUTO.capFps + AUTO.capAbove && s.workMs < AUTO.capWorkMs;
}

/**
 * Stats of one window. `dts` and `works` are frame gaps and work times (ms); the first `n` entries
 * are used. `scratch` (at least n long) is sorted in place, so nothing is allocated per window.
 */
export function windowStats(dts: Float32Array, works: Float32Array, n: number, scratch: Float32Array, trim: number = AUTO.trim): WindowStats {
  if (n <= 0) return { fps: 0, workMs: 0, frames: 0 };
  const a = scratch.subarray(0, n);
  a.set(dts.subarray(0, n));
  a.sort();
  const keep = Math.max(1, n - Math.floor(n * trim));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += a[i];
  const fps = sum > 0 ? (keep * 1000) / sum : 0;
  a.set(works.subarray(0, n));
  a.sort();
  const workMs = a[Math.min(n - 1, Math.floor(n * 0.9))];
  return { fps, workMs, frames: n };
}

export interface GovernorOptions {
  tier: Quality;
  /** Auto quality: tier changes allowed. Off (a tier the player chose): only the pixel-ratio scaler. */
  auto: boolean;
  /** The lowest tier this device has been too slow for (never stepped up into again), or null. */
  failed: Quality | null;
  deviceDpr: number;
}

/** What the last window decided, for the ?fps overlay and the console. */
export type Verdict = 'none' | 'good' | 'hold' | 'slow' | 'raise' | 'tier-down' | 'tier-up';

const MAX_SAMPLES = 1024;

/**
 * The frame-rate governor. Feed it every frame (frame()); read pixelRatio after it returns true, and
 * pendingTier when a quiet moment comes (take the tier, apply it, then call setTier).
 */
export class FrameGovernor {
  tier: Quality;
  auto: boolean;
  failed: Quality | null;
  /** A tier change waiting for a quiet moment, or null. */
  pendingTier: Quality | null = null;
  last: Verdict = 'none';
  lastStats: WindowStats = { fps: 0, workMs: 0, frames: 0 };
  private deviceDpr: number;
  private steps: number[];
  private level = 0;
  /** Pixel-ratio levels measured too slow, per tier: never raised to again this session. */
  private readonly banned = new Set<string>();
  /** The level before the last raise while its first window is out; -1 when none. */
  private raisedFrom = -1;
  /** The last pixel-ratio cut while its first window is out: the level it left and the fps that made it. */
  private cut: { level: number; fps: number } | null = null;
  /**
   * A frame rate cutting was shown not to lift (the cut was undone): slow windows near it are held,
   * not cut again. Cleared by a window that is not slow, or one clearly slower than it.
   */
  private flat: number | null = null;
  /** Auto's last tier step down while its first window on the new tier is out: the fps that made it and the failed mark before it. */
  private tierStep: { fps: number; failedBefore: Quality | null } | null = null;
  /** The same for the step down asked for (pendingTier), until setTier applies it. */
  private tierAsked: { fps: number; failedBefore: Quality | null } | null = null;
  private good = 0;
  private fast = 0;
  private wait: number = AUTO.warmupMs;
  private wasDriving = false;
  private n = 0;
  private span = 0;
  private readonly dts = new Float32Array(MAX_SAMPLES);
  private readonly works = new Float32Array(MAX_SAMPLES);
  private readonly scratch = new Float32Array(MAX_SAMPLES);

  constructor(o: GovernorOptions) {
    this.tier = o.tier;
    this.auto = o.auto;
    this.failed = o.failed;
    this.deviceDpr = o.deviceDpr;
    this.steps = dprSteps(o.tier, o.deviceDpr);
  }

  /** The pixel ratio to render at now. */
  get pixelRatio(): number {
    return this.steps[Math.min(this.level, this.steps.length - 1)];
  }

  /** Index into the tier's pixel-ratio steps (0 = sharpest). */
  get dprLevel(): number {
    return this.level;
  }

  /**
   * One frame: `dtMs` since the previous one, `workMs` the JS time it took, `driving` true only while
   * the race clock runs (not the 3-2-1, pause, results, menus or an ad). Returns true when pixelRatio
   * changed.
   */
  frame(dtMs: number, workMs: number, driving: boolean): boolean {
    if (!driving) {
      if (this.wasDriving) this.restartWindow(AUTO.warmupMs);
      this.wasDriving = false;
      return false;
    }
    this.wasDriving = true;
    if (!(dtMs > 0) || dtMs >= AUTO.hitchMs) return false;
    if (this.wait > 0) {
      this.wait -= dtMs;
      return false;
    }
    this.dts[this.n] = dtMs;
    this.works[this.n] = Number.isFinite(workMs) && workMs > 0 ? workMs : 0;
    this.n++;
    this.span += dtMs;
    if (this.span < AUTO.windowMs && this.n < MAX_SAMPLES) return false;
    const s = windowStats(this.dts, this.works, this.n, this.scratch);
    this.n = 0;
    this.span = 0;
    return this.decide(s);
  }

  /** A window's verdict. Returns true when the pixel ratio changed. */
  decide(s: WindowStats): boolean {
    this.lastStats = s;
    const before = this.level;
    const top = this.steps.length - 1;
    const gain = AUTO.gainMin;
    // The first window on a tier Auto stepped down to: did the step lift the frame rate?
    const step = this.tierStep;
    this.tierStep = null;
    if (s.fps < AUTO.slowFps) {
      this.good = 0;
      this.fast = 0;
      this.last = 'slow';
      const cut = this.cut;
      this.cut = null;
      if (step && s.fps < step.fps * gain) {
        // The tier step gained nothing: the tier was not what held the frame rate back. Not failed after
        // all; hold here (no further tier), and do not cut pixels for this frame rate either.
        this.failed = step.failedBefore;
        this.flat = s.fps;
        this.last = 'hold';
      } else if (this.raisedFrom >= 0) {
        // The raise did not hold: back down, and never to that level again this session.
        this.banned.add(this.key(this.level));
        this.level = this.raisedFrom;
        this.raisedFrom = -1;
      } else if (cut && s.fps < cut.fps * gain) {
        // The cut gained nothing (a 30 fps cap, or load the pixel ratio does not touch): undo it and hold,
        // the sharper level not banned. A lower tier may still help, unless this looks like a cap.
        this.banned.delete(this.key(cut.level));
        this.level = cut.level;
        this.flat = Math.max(s.fps, cut.fps);
        this.last = 'hold';
        this.tierDown(s);
      } else if (this.flat !== null && s.fps * gain >= this.flat) {
        // Still the frame rate cutting could not lift: hold.
        this.last = 'hold';
      } else if (this.level < top) {
        this.flat = null;
        // A level measured too slow is not raised to again this session at this tier, so the scaler
        // never see-saws; a level skipped by a double step was never measured and may be tried.
        this.banned.add(this.key(this.level));
        this.level = Math.min(top, this.level + (s.fps < AUTO.verySlowFps ? 2 : 1));
        this.cut = { level: before, fps: s.fps };
        // Far too slow even at the tier's sharpest: the tier itself is the problem.
        if (before === 0 && s.fps < AUTO.hopelessFps) this.tierDown(s);
      } else {
        this.flat = null;
        this.tierDown(s);
      }
    } else {
      // The last raise (or cut) held.
      this.raisedFrom = -1;
      this.cut = null;
      this.flat = null;
      if (s.fps >= AUTO.goodFps && s.workMs <= AUTO.okWorkMs) {
        this.good++;
        this.fast = s.fps >= AUTO.tierUpFps ? this.fast + 1 : 0;
        this.last = 'good';
        if (this.good >= AUTO.raiseWindows && this.level > 0 && !this.banned.has(this.key(this.level - 1))) {
          this.raisedFrom = this.level;
          this.level--;
          this.good = 0;
          this.last = 'raise';
        } else if (this.level === 0 && this.fast >= AUTO.tierUpWindows) {
          this.fast = 0;
          this.stepTier(1);
        }
      } else {
        this.good = 0;
        this.fast = 0;
        this.last = 'hold';
      }
    }
    if (this.level === before) return false;
    this.wait = AUTO.settleMs;
    return true;
  }

  /** A slow window asks for the tier below, unless it looks like a frame-rate cap (looksCapped). */
  private tierDown(s: WindowStats): void {
    if (looksCapped(s)) return;
    const failedBefore = this.failed;
    if (this.stepTier(-1)) this.tierAsked = { fps: s.fps, failedBefore };
  }

  /** Ask for the tier above or below (auto only, one request at a time, never into a failed tier). True when asked. */
  private stepTier(dir: -1 | 1): boolean {
    if (!this.auto || this.pendingTier) return false;
    const i = TIERS.indexOf(this.tier) + dir;
    if (i < 0 || i >= TIERS.length) return false;
    const next = TIERS[i];
    if (dir < 0) {
      if (this.failed === null || tierCmp(this.tier, this.failed) < 0) this.failed = this.tier;
    } else if (this.failed !== null && tierCmp(next, this.failed) >= 0) {
      return false;
    }
    this.pendingTier = next;
    this.last = dir < 0 ? 'tier-down' : 'tier-up';
    return true;
  }

  /**
   * The tier now in use (an applied pendingTier, or the player's choice). A step down starts at the new
   * tier's sharpest pixel ratio not above the current one, so it never gets heavier on the way down.
   */
  setTier(q: Quality, auto = this.auto): void {
    const cur = this.pixelRatio;
    const down = tierCmp(q, this.tier) < 0;
    // Only Auto's own step down is judged by its first window (did it lift the frame rate?).
    this.tierStep = down && q === this.pendingTier ? this.tierAsked : null;
    this.tierAsked = null;
    this.cut = null;
    this.flat = null;
    this.tier = q;
    this.auto = auto;
    this.pendingTier = null;
    this.steps = dprSteps(q, this.deviceDpr);
    this.level = 0;
    if (down) while (this.level < this.steps.length - 1 && this.steps[this.level] > cur + 1e-6) this.level++;
    this.raisedFrom = -1;
    this.good = 0;
    this.fast = 0;
    this.restartWindow(AUTO.warmupMs);
  }

  /** The device ratio changed (window moved to another screen, browser zoom). Returns true when pixelRatio changed. */
  setDeviceDpr(d: number): boolean {
    if (d === this.deviceDpr) return false;
    const before = this.pixelRatio;
    this.deviceDpr = d;
    this.steps = dprSteps(this.tier, d);
    this.level = Math.min(this.level, this.steps.length - 1);
    this.cut = null;
    this.flat = null;
    this.restartWindow(AUTO.settleMs);
    return this.pixelRatio !== before;
  }

  private restartWindow(wait: number): void {
    this.n = 0;
    this.span = 0;
    this.wait = wait;
  }

  private key(level: number): string {
    return `${this.tier}:${this.steps[level]}`;
  }
}

/**
 * The tier Auto starts from on a device: the platform's default (touchscreens Medium, else High),
 * below any tier this device was too slow for.
 */
export function autoStartTier(touch: boolean, failed: Quality | null): Quality {
  let q: Quality = touch ? 'medium' : 'high';
  while (failed !== null && tierCmp(q, failed) >= 0 && q !== 'low') q = TIERS[TIERS.indexOf(q) - 1];
  return q;
}
