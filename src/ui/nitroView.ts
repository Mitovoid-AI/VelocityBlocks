// What the Nitro button (touch) and the HUD's nitro ring (keys, controller) show, from the car's
// nitro timers. Pure, so it is unit-tested (tests/nitroView.test.ts); Hud.nitro paints it.

import { nitroGauge, type NitroGauge } from '../physics/vehicle';

export type NitroState = NitroGauge['state'];

export interface NitroView {
  state: NitroState;
  /** The ring, 0..1: full when ready, the push left while boosting, the charge (0 to 1 over the 6 s) while recharging. */
  p: number;
  /** While recharging, the whole seconds until it is ready (6 .. 1); else 0. */
  secondsLeft: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The view for CarState.nitroTime (seconds of push left) and nitroCooldown (seconds until ready): a thin
 * adapter over physics' nitroGauge, the one source of truth for the ring and the seconds.
 */
export function nitroView(nitroTime: number, nitroCooldown: number): NitroView {
  const g = nitroGauge({ nitroTime, nitroCooldown });
  return { state: g.state, p: clamp01(g.p), secondsLeft: g.state === 'recharging' ? Math.max(1, g.seconds) : 0 };
}
