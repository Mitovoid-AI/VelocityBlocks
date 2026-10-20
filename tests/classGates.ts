// Acceptance gates for every vehicle class on the campaign, shared by the campaign tests and
// scripts/class-tune.ts (the tuning harness), so a spec that passes one passes the other.
import type { Controls, TcLevel } from '../src/physics/vehicle';

/** A phone player on the buttons: on/off steering (with a small dead zone), on/off gas and brake; no nitro. */
export function touchStyle(c: Controls): Controls {
  return { steer: Math.abs(c.steer) > 0.3 ? Math.sign(c.steer) : 0, gas: c.gas > 0.5 ? 1 : 0, brake: c.brake > 0 ? 1 : 0 };
}

/**
 * The same player pressing the nitro button wherever the autopilot fires it: the autopilot's nitro rule
 * (bot.ts NITRO_RULE) must be one a button player can copy without spinning out.
 */
export function touchNitroStyle(c: Controls): Controls {
  const t = touchStyle(c);
  if (c.nitro) t.nitro = true;
  return t;
}

/** The same player with auto-accelerate on: full gas whenever the brake is up (input.ts). */
export function autoGasStyle(c: Controls): Controls {
  const t = touchStyle(c);
  return { ...t, gas: t.brake ? 0 : 1 };
}

export interface TouchDriver {
  tc: TcLevel;
  /** Auto-accelerate (always normal traction control). */
  auto: boolean;
  filter: (c: Controls) => Controls;
}

/**
 * Phone-style drivers. Every class must take touch-normal and touch-low, and the same with the nitro
 * (nitro-normal, nitro-low), round every campaign track with no respawn and no spin (tests/campaign.test.ts).
 * auto-gas never lifts, so it meets crests too fast; it is measured by scripts/class-tune.ts but not gated
 * (the car's own lap spins on A05 with it).
 */
export const TOUCH_DRIVERS: Record<string, TouchDriver> = {
  'touch-normal': { tc: 'normal', auto: false, filter: touchStyle },
  'touch-low': { tc: 'low', auto: false, filter: touchStyle },
  'auto-gas': { tc: 'normal', auto: true, filter: autoGasStyle },
  'nitro-normal': { tc: 'normal', auto: false, filter: touchNitroStyle },
  'nitro-low': { tc: 'low', auto: false, filter: touchNitroStyle },
};

export const GATES = {
  /** Largest heading error against the route (deg): more is a spin. */
  spinDeg: 90,
  /** Largest distance (m) from the route's centre line (the road is 20 m wide; landings and wide lines included). */
  offRoute: 25,
  /** A phone-style lap may take at most this multiple of the autopilot's lap. */
  touchVsBot: 1.25,
  /**
   * Author time over the class's racing-line lap: not near-impossible (the hidden author medal) and not a
   * gift. The car's laps sit at 1.17..1.36.
   */
  authorVsLine: [1.1, 1.45] as const,
  /** Largest lateral offset (m) of a pace lap from the centre line: on the road, give or take a wheel (the car reaches 10.3). */
  lineOffRoute: 12,
};
