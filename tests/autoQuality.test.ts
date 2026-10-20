// Auto graphics quality (render/autoQuality.ts): the pixel-ratio scaler, the tier decisions and
// their hysteresis, and the settings migration that turns never-chosen tiers into Auto.

import { describe, expect, it } from 'vitest';
import { chooseQuality, qualityOptionsHtml } from '../src/app/app';
import { DEFAULT_SETTINGS, migrateQuality, migrateSettings } from '../src/game/storage';
import { AUTO, autoStartTier, dprSteps, FrameGovernor, looksCapped, windowStats, type GovernorOptions } from '../src/render/autoQuality';
import { QUALITY, type Quality } from '../src/render/quality';

const gov = (o: Partial<GovernorOptions> = {}) =>
  new FrameGovernor({ tier: 'medium', auto: true, failed: null, deviceDpr: 2.75, ...o });

/**
 * Drive `ms` of frames. `frameMs` is the frame time for the governor's current pixel ratio (a device
 * model), `work` the JS time per frame. Returns the pixel ratios the governor switched to.
 */
function drive(g: FrameGovernor, ms: number, frameMs: (dpr: number, tier: Quality) => number, work = 3): number[] {
  const changes: number[] = [];
  for (let t = 0; t < ms; ) {
    const dt = frameMs(g.pixelRatio, g.tier);
    if (g.frame(dt, work, true)) changes.push(g.pixelRatio);
    t += dt;
  }
  return changes;
}

const fps = (f: number) => () => 1000 / f;

describe('pixel-ratio steps', () => {
  it("start at each tier's cap and never exceed the device", () => {
    for (const q of ['low', 'medium', 'high'] as Quality[]) expect(dprSteps(q, 3)[0]).toBe(QUALITY[q].maxDpr);
    expect(dprSteps('high', 2.75)).toEqual([2, 1.75, 1.5, 1.25]);
    expect(dprSteps('medium', 1.3)).toEqual([1.3, 1.25, 1]);
    // A 1x screen: High and Medium have nothing to scale, Low may still go below 1.
    expect(dprSteps('high', 1)).toEqual([1]);
    expect(dprSteps('medium', 1)).toEqual([1]);
    expect(dprSteps('low', 1)).toEqual([1, 0.85, 0.75]);
    expect(dprSteps('medium', NaN)).toEqual([1]);
  });
});

describe('window stats', () => {
  it('trims the slowest frames and reads the 90th percentile of the work', () => {
    const n = 100;
    const dts = new Float32Array(n).fill(1000 / 60);
    const works = new Float32Array(n);
    for (let i = 0; i < n; i++) works[i] = i / 10; // 0 .. 9.9 ms
    // Five stray 40 ms frames are the trimmed 5%.
    for (let i = 0; i < 5; i++) dts[i * 20] = 40;
    const s = windowStats(dts, works, n, new Float32Array(n));
    expect(s.fps).toBeCloseTo(60, 1);
    expect(s.workMs).toBeCloseTo(9, 1);
    expect(s.frames).toBe(n);
    // One in five frames missing vsync is not ~55 fps.
    for (let i = 0; i < 20; i++) dts[i * 5] = 1000 / 30;
    expect(windowStats(dts, works, n, new Float32Array(n)).fps).toBeLessThan(AUTO.slowFps);
  });
});

describe('frame governor', () => {
  it('leaves a device that holds 60 fps alone', () => {
    const g = gov();
    expect(drive(g, 60_000, fps(60))).toEqual([]);
    expect(g.pixelRatio).toBe(1.5);
    expect(g.pendingTier).toBeNull();
    expect(g.last).toBe('good');
  });

  /** Each cut lifts the frame rate a little (more than AUTO.gainMin), never enough: 40 fps at 2x, 51 at 1.25x. */
  const partlyFillBound = (d: number) => 1000 / (40 * Math.sqrt(2 / d));

  it('steps the pixel ratio down while that helps, then asks for the tier below', () => {
    const g = gov({ tier: 'high' });
    const changes = drive(g, 30_000, partlyFillBound);
    expect(changes).toEqual([1.5, 1.25]);
    expect(g.pendingTier).toBe('medium');
    expect(g.failed).toBe('high');
  });

  it('undoes a cut that gained nothing and asks for the tier below instead (load the pixel ratio does not touch)', () => {
    const g = gov({ tier: 'high' });
    // 45 fps whatever the pixel ratio: one cut shows it, the sharp image comes back, and only a lower tier may help.
    expect(drive(g, 30_000, fps(45))).toEqual([1.75, 2]);
    expect(g.pendingTier).toBe('medium');
    expect(g.failed).toBe('high');
    // The undone level was not banned: a raise may come back to it later.
    expect(g.pixelRatio).toBe(2);
  });

  it('holds on a 30 fps cap (battery saver): no blurrier picture, no lower tier, nothing marked failed', () => {
    const g = gov({ tier: 'medium' });
    // One double cut while it cannot tell, then the cut is undone: 30 fps at any pixel ratio, little JS work.
    expect(drive(g, 120_000, fps(30))).toEqual([1, 1.5]);
    expect(g.pixelRatio).toBe(1.5);
    expect(g.pendingTier).toBeNull();
    expect(g.failed).toBeNull();
    expect(g.last).toBe('hold');
    // Hopeless-looking at High's sharpest too: still a cap, not a tier to leave.
    const h = gov({ tier: 'high' });
    drive(h, 120_000, () => 1000 / 29.5);
    expect(h.pendingTier).toBeNull();
    expect(h.failed).toBeNull();
    expect(h.pixelRatio).toBe(2);
    expect(looksCapped({ fps: 30, workMs: 3, frames: 75 })).toBe(true);
    expect(looksCapped({ fps: 30, workMs: 12, frames: 75 })).toBe(false);
    expect(looksCapped({ fps: 24, workMs: 3, frames: 60 })).toBe(false);
  });

  it('30 fps with heavy JS work is load, not a cap: the tier steps down', () => {
    const g = gov({ tier: 'medium' });
    drive(g, 30_000, fps(30), 12);
    expect(g.pendingTier).toBe('low');
    expect(g.failed).toBe('medium');
  });

  it('takes back a tier step that gained nothing, and holds there', () => {
    const g = gov({ tier: 'high' });
    drive(g, 30_000, fps(45));
    expect(g.pendingTier).toBe('medium');
    g.setTier(g.pendingTier!);
    // Medium is no faster: High was not what held the frame rate back.
    expect(drive(g, 60_000, fps(45))).toEqual([]);
    expect(g.failed).toBeNull();
    expect(g.pendingTier).toBeNull();
    expect(g.last).toBe('hold');
    // A tier step that did help stays: the tier above is failed for good.
    const f = gov({ tier: 'high' });
    drive(f, 30_000, fps(45));
    f.setTier(f.pendingTier!);
    drive(f, 30_000, fps(60));
    expect(f.failed).toBe('high');
  });

  it('settles where the device holds the frame rate (fill-rate bound phone)', () => {
    const g = gov({ tier: 'medium' });
    // GPU time grows with the pixels drawn, frames wait for the 60 Hz vsync: 1.5x is 50 fps, 1.25x holds 60.
    const changes = drive(g, 120_000, (d) => Math.max(1000 / 60, (1000 / 60) * (d / 1.25)));
    // Down once and there it stays: a level measured too slow is not tried again.
    expect(changes).toEqual([1.25]);
    expect(g.pendingTier).toBeNull();
  });

  it('drops two steps when far too slow, and asks for a lower tier at once when hopeless', () => {
    const g = gov({ tier: 'high' });
    g.decide({ fps: 40, workMs: 3, frames: 100 });
    expect(g.pixelRatio).toBe(1.5);
    expect(g.pendingTier).toBeNull();
    const h = gov({ tier: 'high' });
    h.decide({ fps: 25, workMs: 3, frames: 100 });
    expect(h.pendingTier).toBe('medium');
  });

  it('only scales the pixel ratio for a tier the player chose', () => {
    const g = gov({ tier: 'high', auto: false });
    // Fill-rate bound: 23 fps at 2x, 42 at 1.5x, 60 at 1.25x.
    drive(g, 60_000, (d) => 1000 / (60 * (1.25 / d) ** 2));
    expect(g.pixelRatio).toBe(1.25);
    expect(g.pendingTier).toBeNull();
    expect(g.failed).toBeNull();
  });

  it('raises the pixel ratio back to a level it skipped, after a run of good windows, and never see-saws', () => {
    // Holds 60 at 1.25x and below, not at 1.5x.
    const model = (d: number) => (d > 1.3 ? 1000 / 48 : 1000 / 60);
    // A stall (say a background app) made it drop two steps at once: 1.25x was never measured.
    const h = gov({ tier: 'medium' });
    h.decide({ fps: 40, workMs: 3, frames: 100 });
    expect(h.pixelRatio).toBe(1);
    expect(drive(h, 120_000, model)).toEqual([1.25]);
    // A raise that does not hold goes back down and is never tried again.
    const r = gov({ tier: 'high' });
    r.decide({ fps: 40, workMs: 3, frames: 100 }); // 2 -> 1.5, 1.75 unmeasured
    const rs = drive(r, 120_000, (d) => (d > 1.6 ? 1000 / 50 : 1000 / 60));
    expect(rs).toEqual([1.75, 1.5]);
  });

  it('does not raise when the JS work per frame leaves no room', () => {
    const g = gov({ tier: 'medium' });
    g.decide({ fps: 50, workMs: 3, frames: 100 });
    expect(g.pixelRatio).toBe(1.25);
    expect(drive(g, 60_000, fps(60), 12)).toEqual([]);
  });

  it('steps a tier up only with clear headroom (a 120 Hz screen) and never into a tier that failed', () => {
    const g = gov({ tier: 'low' });
    drive(g, 30_000, fps(60));
    expect(g.pendingTier).toBeNull();
    drive(g, 30_000, fps(118));
    expect(g.pendingTier).toBe('medium');
    const f = gov({ tier: 'low', failed: 'medium' });
    drive(f, 60_000, fps(118));
    expect(f.pendingTier).toBeNull();
  });

  it('ignores frames that are not driving, the warm-up after them, and hitches', () => {
    const g = gov({ tier: 'high' });
    // Countdown, pause and menus at 20 fps: not counted.
    for (let i = 0; i < 2000; i++) g.frame(50, 3, false);
    expect(g.pixelRatio).toBe(2);
    // Shader compiles and loads (hitch-length gaps) while driving: not a frame rate.
    for (let i = 0; i < 200; i++) g.frame(400, 3, true);
    expect(g.pixelRatio).toBe(2);
    // The first warm-up after GO is skipped even when slow.
    let t = 0;
    while (t < AUTO.warmupMs - 50) {
      g.frame(25, 3, true);
      t += 25;
    }
    expect(g.lastStats.frames).toBe(0);
  });

  it('a step down starts the new tier no sharper than the old one', () => {
    const g = gov({ tier: 'high' });
    drive(g, 30_000, partlyFillBound);
    expect(g.pixelRatio).toBe(1.25);
    g.setTier(g.pendingTier!);
    expect(g.tier).toBe('medium');
    expect(g.pixelRatio).toBe(1.25);
    expect(g.pendingTier).toBeNull();
    // A step up starts at the tier's own cap.
    g.setTier('high');
    expect(g.pixelRatio).toBe(2);
  });
});

describe('auto quality settings', () => {
  it('starts Auto from the platform default, below a tier the device failed', () => {
    expect(autoStartTier(true, null)).toBe('medium');
    expect(autoStartTier(false, null)).toBe('high');
    expect(autoStartTier(false, 'high')).toBe('medium');
    expect(autoStartTier(true, 'medium')).toBe('low');
    expect(autoStartTier(true, 'low')).toBe('low');
    expect(DEFAULT_SETTINGS.qualityAuto).toBe(true);
    expect(DEFAULT_SETTINGS.qualityFailed).toBeNull();
  });

  it('turns a never-chosen tier into Auto and keeps an explicit choice', () => {
    // Nothing stored: Auto.
    expect(migrateQuality({}, true)).toEqual({ quality: 'medium', qualityAuto: true, qualityFailed: null });
    // The old platform default was most likely never chosen: Auto, from the same tier.
    expect(migrateQuality({ quality: 'medium' }, true)).toEqual({ quality: 'medium', qualityAuto: true, qualityFailed: null });
    expect(migrateQuality({ quality: 'high' }, false)).toEqual({ quality: 'high', qualityAuto: true, qualityFailed: null });
    // Anything else was a choice.
    expect(migrateQuality({ quality: 'low' }, true).qualityAuto).toBe(false);
    expect(migrateQuality({ quality: 'high' }, true)).toEqual({ quality: 'high', qualityAuto: false, qualityFailed: null });
    expect(migrateQuality({ quality: 'medium' }, false).qualityAuto).toBe(false);
  });

  it('keeps what Auto learnt, and drops junk', () => {
    expect(migrateQuality({ quality: 'low', qualityAuto: true, qualityFailed: 'medium' }, true)).toEqual({
      quality: 'low',
      qualityAuto: true,
      qualityFailed: 'medium',
    });
    // An explicit Medium stays even where Auto failed it.
    expect(migrateQuality({ quality: 'medium', qualityAuto: false, qualityFailed: 'medium' }, true).quality).toBe('medium');
    // Auto never sits on a failed tier (an older APK may have written it back).
    expect(migrateQuality({ quality: 'medium', qualityAuto: true, qualityFailed: 'medium' }, true).quality).toBe('low');
    expect(migrateQuality({ quality: 'ultra', qualityAuto: 'yes', qualityFailed: 7 }, true)).toEqual({
      quality: 'medium',
      qualityAuto: true,
      qualityFailed: null,
    });
    // Through migrateSettings, with the other keys untouched.
    const s = migrateSettings({ quality: 'low', volume: 0.3 }, true);
    expect(s).toMatchObject({ quality: 'low', qualityAuto: false, qualityFailed: null, volume: 0.3 });
  });

  it('picking Auto again forgets the tiers it marked failed; picking a tier keeps them', () => {
    const s = { quality: 'low' as Quality, qualityAuto: true, qualityFailed: 'medium' as Quality | null };
    chooseQuality(s, 'high', true);
    expect(s).toEqual({ quality: 'high', qualityAuto: false, qualityFailed: 'medium' });
    chooseQuality(s, 'auto', true);
    expect(s).toEqual({ quality: 'medium', qualityAuto: true, qualityFailed: null });
    chooseQuality(s, 'auto', false);
    expect(s.quality).toBe('high');
    // Junk changes nothing.
    chooseQuality(s, 'ultra', false);
    expect(s).toEqual({ quality: 'high', qualityAuto: true, qualityFailed: null });
  });

  it('names the current tier on the Auto option', () => {
    const h = qualityOptionsHtml('auto', 'medium');
    expect(h).toContain('<option value="auto" selected>Auto (currently: Medium)</option>');
    expect(h).toContain('<option value="low" >Low (fastest)</option>');
    expect(qualityOptionsHtml('high', 'high')).toContain('<option value="high" selected>High</option>');
  });
});
