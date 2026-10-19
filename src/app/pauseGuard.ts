// Rules for what Android Back does during a race, and the pause screen's reason and diagnostics
// lines. Pure, so the rules are unit-tested (tests/pauseGuard.test.ts).

import type { Box, GestureInsets } from '../input/edgeGuard';
import type { SysCancel } from '../input/touchWatch';
import type { DeviceInfo } from '../platform/native';

/** What paused the race; shown on the pause screen. */
export type PauseReason = 'button' | 'key' | 'gamepad' | 'back' | 'focus' | 'hidden';

/** Sent with 'vb-focuslost' by MainActivity (an older app build sends none). */
export interface FocusDetail {
  /** How long focus had been gone when the event was sent. */
  ms?: number;
  /** False when a whole screen covers the game (call, camera); true for an overlay (shade, pop-up, game panel). */
  resumed?: boolean;
  multiWindow?: boolean;
}

/** Where the race is when Back arrives, since when (performance.now() ms), and the previous Back's time. */
export interface BackState {
  phase: 'racing' | 'paused' | 'results';
  since: number;
  lastBackAt: number;
}

/** swallow: ignore the Back. pause / resume: the pause menu. leave: let the screen's own Back button handle it. */
export type BackOutcome = 'swallow' | 'pause' | 'resume' | 'leave';

/** A system cancel lets the next Back be swallowed for this long (the finger may stay down a while first). */
export const SWALLOW_TOKEN_MS = 10_000;

/** Shown when a Back during a race is swallowed. */
export const SWALLOW_HINT = 'Back swipes are off while racing - tap ❚❚ to pause';

/**
 * Android Back. A back swipe cancels the swiping finger (and, up to Android 12, every finger)
 * before Back arrives, so each system cancel grants one swallow token, used by the next Back
 * within SWALLOW_TOKEN_MS. A Back with no token (3-button navigation, a hardware key) acts:
 * - racing: a token from this stretch of racing swallows the Back; otherwise it pauses;
 * - paused: Back resumes, unless a touch that was down before the pause has been cancelled since
 *   (the driving thumb carried over into the menu made the swipe);
 * - results: a touch from the race that the system took swallows the Back, so a stray swipe
 *   right after the finish doesn't throw the results away; otherwise the screen's Back acts.
 */
export function backOutcome(s: BackState, cancels: readonly SysCancel[], now: number): BackOutcome {
  const live = cancels.filter((c) => c.at > s.lastBackAt && now - c.at <= SWALLOW_TOKEN_MS);
  switch (s.phase) {
    case 'racing':
      return live.some((c) => c.at >= s.since) ? 'swallow' : 'pause';
    case 'paused':
      return live.some((c) => c.at >= s.since && c.downAt < s.since) ? 'swallow' : 'resume';
    case 'results':
      return live.some((c) => c.downAt < s.since) ? 'swallow' : 'leave';
  }
}

/** The pause screen's reason line. */
export function pauseWhy(r: PauseReason, d?: FocusDetail): string {
  switch (r) {
    case 'button':
      return 'Paused: pause button';
    case 'key':
      return 'Paused: Esc / P key';
    case 'gamepad':
      return 'Paused: controller Start button';
    case 'back':
      return 'Paused: Back button';
    case 'hidden':
      return 'Paused: app hidden';
    case 'focus': {
      const why = d?.multiWindow
        ? ' (split screen)'
        : d?.resumed === false
          ? ' (another screen opened)'
          : d?.resumed
            ? ' (a panel or pop-up covered it)'
            : '';
      return `Paused: app lost focus${why}`;
    }
  }
}

/** What the pause screen's diagnostics line reports. Counters are since the race was opened. */
export interface PauseDiag {
  device: DeviceInfo | null;
  insets: GestureInsets | null;
  swallowedBacks: number;
  touchCancels: number;
  longFrames: number;
  flipRespawns: number;
}

const NAV_LABEL: Record<string, string> = {
  gesture: 'gesture nav',
  '3-button': '3-button nav',
  '2-button': '2-button nav',
};

/**
 * One small grey line, so a screenshot of the pause screen tells what caused a pause: the phone
 * and its navigation mode, the gesture strips the app was told about, then the non-zero counters.
 * Empty when there is nothing to say (a browser with nothing unusual).
 */
export function diagLine(d: PauseDiag): string {
  const parts: string[] = [];
  const dev = d.device;
  if (dev) {
    const sameMaker = dev.model.toLowerCase().startsWith(dev.maker.toLowerCase());
    parts.push((sameMaker ? dev.model : `${dev.maker} ${dev.model}`).trim());
    parts.push(`Android ${dev.release}`);
    parts.push(NAV_LABEL[dev.nav] ?? 'nav ?');
  }
  if (d.insets) parts.push(`edges ${d.insets.l}/${d.insets.r}/${d.insets.b}`);
  if (d.swallowedBacks) parts.push(`swallowed Backs: ${d.swallowedBacks}`);
  if (d.touchCancels) parts.push(`cancelled touches: ${d.touchCancels}`);
  if (d.longFrames) parts.push(`long frames: ${d.longFrames}`);
  if (d.flipRespawns) parts.push(`flip respawns: ${d.flipRespawns}`);
  return parts.join(' · ');
}

/**
 * A frame gap that counts as a hitch. Gaps of 2 s and more are a trip to the background or an
 * ad, and the shell resets its clock after those anyway.
 */
export const isLongFrame = (ms: number): boolean => ms > 150 && ms < 2000;

/** The pause pill acts when the finger lifts within `slop` px of it, so a mis-tap can slide off. */
export function liftInside(r: Box, x: number, y: number, slop = 10): boolean {
  return r.width > 0 && x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop;
}
