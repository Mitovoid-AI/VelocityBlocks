// "It keeps pausing by itself": Android Back from back swipes over the touch controls toggled the
// pause menu. These are the Back rules (swallow tokens), the pause screen's reason and diagnostics
// lines, the long-frame test and the pause pill's lift test.

import { describe, expect, it } from 'vitest';
import {
  backOutcome,
  diagLine,
  isLongFrame,
  liftInside,
  pauseWhy,
  SWALLOW_TOKEN_MS,
  type BackState,
  type PauseDiag,
  type PauseReason,
} from '../src/app/pauseGuard';
import type { SysCancel } from '../src/input/touchWatch';

const NOW = 100_000;
const racing = (since = NOW - 60_000, lastBackAt = -Infinity): BackState => ({ phase: 'racing', since, lastBackAt });
const paused = (since: number, lastBackAt = -Infinity): BackState => ({ phase: 'paused', since, lastBackAt });
const results = (since: number, lastBackAt = -Infinity): BackState => ({ phase: 'results', since, lastBackAt });
const cancel = (downAt: number, at: number): SysCancel => ({ downAt, at });

describe('Back during a race', () => {
  it('pauses when no touch was taken by the system (3-button or hardware Back)', () => {
    expect(backOutcome(racing(), [], NOW)).toBe('pause');
  });

  it('is swallowed right after a back swipe took a finger', () => {
    expect(backOutcome(racing(), [cancel(NOW - 4000, NOW - 300)], NOW)).toBe('swallow');
  });

  it('is still swallowed when the swiping thumb stayed down for seconds before lifting', () => {
    expect(backOutcome(racing(), [cancel(NOW - 9000, NOW - 5000)], NOW)).toBe('swallow');
  });

  it('is swallowed when the swipe cancelled every finger at once (Android 12 and older)', () => {
    const all = [cancel(NOW - 8000, NOW - 1200), cancel(NOW - 3000, NOW - 1199)];
    expect(backOutcome(racing(), all, NOW)).toBe('swallow');
  });

  it('pauses once the token has expired', () => {
    expect(backOutcome(racing(), [cancel(NOW - 20_000, NOW - SWALLOW_TOKEN_MS - 1)], NOW)).toBe('pause');
  });

  it('spends the token on one Back: the next one pauses', () => {
    const c = [cancel(NOW - 4000, NOW - 2000)];
    expect(backOutcome(racing(NOW - 60_000, NOW - 1000), c, NOW)).toBe('pause');
  });

  it('ignores cancels from before this stretch of racing (before a resume or restart)', () => {
    expect(backOutcome(racing(NOW - 1000), [cancel(NOW - 4000, NOW - 2000)], NOW)).toBe('pause');
  });
});

describe('Back while paused', () => {
  const pausedAt = NOW - 3000;

  it('resumes, as Android dialogs close on Back', () => {
    expect(backOutcome(paused(pausedAt), [], NOW)).toBe('resume');
  });

  it('is swallowed when the driving thumb, down since before the pause, was taken since', () => {
    expect(backOutcome(paused(pausedAt), [cancel(pausedAt - 5000, pausedAt + 1000)], NOW)).toBe('swallow');
  });

  it('resumes when the cancelled touch started in the menu', () => {
    expect(backOutcome(paused(pausedAt), [cancel(pausedAt + 500, pausedAt + 1000)], NOW)).toBe('resume');
  });

  it('resumes when the touch was taken before the pause', () => {
    expect(backOutcome(paused(pausedAt), [cancel(pausedAt - 5000, pausedAt - 100)], NOW)).toBe('resume');
  });

  it('resumes on the Back after a swallowed one', () => {
    const c = [cancel(pausedAt - 5000, pausedAt + 1000)];
    expect(backOutcome(paused(pausedAt, pausedAt + 1500), c, NOW)).toBe('resume');
  });
});

describe('Back on the results screen', () => {
  const shownAt = NOW - 1000;

  it("is left to the screen's own Menu button", () => {
    expect(backOutcome(results(shownAt), [], NOW)).toBe('leave');
  });

  it('is swallowed when a touch from the race was taken (a stray swipe at the finish)', () => {
    expect(backOutcome(results(shownAt), [cancel(NOW - 9000, shownAt - 400)], NOW)).toBe('swallow');
    expect(backOutcome(results(shownAt), [cancel(NOW - 9000, shownAt + 400)], NOW)).toBe('swallow');
  });
});

describe('pause screen lines', () => {
  it('names every reason differently', () => {
    const reasons: PauseReason[] = ['button', 'key', 'gamepad', 'back', 'focus', 'hidden'];
    const lines = reasons.map((r) => pauseWhy(r));
    expect(new Set(lines).size).toBe(reasons.length);
    for (const l of lines) expect(l).toMatch(/^Paused: \S/);
    expect(pauseWhy('back')).toBe('Paused: Back button');
    expect(pauseWhy('hidden')).toBe('Paused: app hidden');
    expect(pauseWhy('button')).toBe('Paused: pause button');
  });

  it('tells an overlay from another screen on focus loss', () => {
    const overlay = pauseWhy('focus', { ms: 500, resumed: true, multiWindow: false });
    const screen = pauseWhy('focus', { ms: 500, resumed: false, multiWindow: false });
    expect(overlay).toMatch(/^Paused: app lost focus/);
    expect(screen).toMatch(/^Paused: app lost focus/);
    expect(overlay).not.toBe(screen);
    expect(pauseWhy('focus')).toBe('Paused: app lost focus'); // an older app build sends no detail
  });

  const diag = (d: Partial<PauseDiag>): string =>
    diagLine({ device: null, insets: null, swallowedBacks: 0, touchCancels: 0, longFrames: 0, flipRespawns: 0, ...d });

  it('says nothing in a browser where nothing happened', () => {
    expect(diag({})).toBe('');
  });

  it('lists the phone, nav mode, gesture strips and the non-zero counters', () => {
    const line = diag({
      device: { sdk: 34, release: '14', maker: 'Xiaomi', model: 'Redmi Note 12', nav: 'gesture' },
      insets: { l: 24, r: 24, t: 24, b: 16 },
      swallowedBacks: 2,
      longFrames: 5,
    });
    expect(line).toBe('Xiaomi Redmi Note 12 · Android 14 · gesture nav · edges 24/24/16 · swallowed Backs: 2 · long frames: 5');
  });

  it('does not repeat the maker and flags an unknown nav mode', () => {
    const line = diag({ device: { sdk: 30, release: '11', maker: 'OnePlus', model: 'OnePlus 9', nav: 'unknown' }, touchCancels: 3, flipRespawns: 1 });
    expect(line).toBe('OnePlus 9 · Android 11 · nav ? · cancelled touches: 3 · flip respawns: 1');
  });
});

describe('long frames and the pause pill', () => {
  it('counts hitches but not trips to the background', () => {
    expect(isLongFrame(16)).toBe(false);
    expect(isLongFrame(150)).toBe(false);
    expect(isLongFrame(151)).toBe(true);
    expect(isLongFrame(1999)).toBe(true);
    expect(isLongFrame(2000)).toBe(false);
    expect(isLongFrame(60_000)).toBe(false);
  });

  const pill = { left: 100, top: 10, right: 142, bottom: 50, width: 42, height: 40 };

  it('fires the pause pill only for a lift on it (with a little slop)', () => {
    expect(liftInside(pill, 120, 30)).toBe(true);
    expect(liftInside(pill, 148, 55)).toBe(true);
    expect(liftInside(pill, 160, 30)).toBe(false); // slid off towards Cam
    expect(liftInside(pill, 120, 70)).toBe(false);
  });

  it('never fires from a hidden pill (empty box)', () => {
    expect(liftInside({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, 0, 0)).toBe(false);
  });
});
