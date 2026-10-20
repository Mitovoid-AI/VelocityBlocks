// Unified driving input: keyboard, gamepad, on-screen touch controls and optional tilt steering.

import type { Controls } from '../physics/vehicle';
import {
  clampCenter,
  MOTION_SMOOTH_SCALE,
  motionRoll,
  rawRoll,
  RollFilter,
  screenAngle,
  smoothingCutoff,
  steerFromRoll,
  TILT_DEAD_DEG,
  TILT_SMOOTH_DEFAULT,
  tiltRoll,
  type TiltReading,
} from './tilt';

/**
 * Edge-triggered presses. 'nitro' is feedback only (RaceMode shakes the button when it is still
 * recharging): the nitro itself reaches the race through read(), like the pedals.
 */
export type Action = 'respawn' | 'restart' | 'pause' | 'camera' | 'ghost' | 'nitro';
/** Where an action came from (the pause screen says what paused the race). */
export type ActionSource = 'key' | 'gamepad' | 'touch';

/** Keys that fire the nitro: N, and either Shift. */
const NITRO_KEYS = ['KeyN', 'ShiftLeft', 'ShiftRight'] as const;
/** A nitro press counts for the next racing read() this long at most (a tap shorter than a tick still fires). */
const NITRO_PRESS_MS = 250;
/** The controller's nitro button: RB. */
const PAD_NITRO = 5;

/**
 * What the on-screen controls add up to (TouchControls). steer is null when no touch steers,
 * so tilt can. A released pedal must be exactly 0: rolling resistance only applies then.
 */
export interface TouchInput {
  steer: number | null;
  gas: number;
  brake: number;
}

export class Input {
  private keys = new Set<string>();
  private touch: TouchInput = { steer: null, gas: 0, brake: 0 };
  private actionHandler: ((a: Action, src: ActionSource) => void) | null = null;
  private padPrev: boolean[] = [];
  autoAccelerate = false;
  enabled = true;
  /** Tilt steering: 0 (gentle) .. 1 (sharp), and the roll in degrees that means straight ahead. */
  tiltSensitivity = 0.5;
  tiltCenter = 0;
  /** Tilt steering: degrees either side of straight ahead that steer nothing, and the centre feel (0 linear .. 1 gentle). */
  tiltDeadzone = TILT_DEAD_DEG;
  tiltCurve = 0;
  private smoothing = TILT_SMOOTH_DEFAULT;
  private tiltOn = false;
  /** The device roll smoothed (RollFilter); its value is null until a reading arrives after tilt is turned on. */
  private readonly filter = new RollFilter();
  /** The last raw roll and how strongly its source is smoothed (MOTION_SMOOTH_SCALE for gravity). */
  private lastRaw: number | null = null;
  private lastScale = 1;
  /** deviceorientation has given a reading since tilt was turned on: gravity readings are ignored from then on. */
  private orientSeen = false;
  /** iOS reports gravity with the opposite sign (set when tilt is turned on). */
  private iosGravity = false;
  /** Pending waitForTilt calls: settled true by the first reading, false by setTilt(false) or their timeout. */
  private tiltWaiters: ((ok: boolean) => void)[] = [];
  /** Called when the first reading arrives after tilt was turned on (TouchControls shows the tilt layout again). */
  onTiltLive: (() => void) | null = null;
  /** The touch Nitro button is held (TouchControls). */
  private nitroTouch = false;
  /** When the nitro was last pressed (performance.now() ms), until a racing read() takes it. */
  private nitroPressAt = -Infinity;
  private readonly onOrientation = (e: DeviceOrientationEvent) => {
    const r = tiltRoll(e.beta, e.gamma, screenAngle());
    if (!r) return; // phones without the sensor may send one all-null event
    this.orientSeen = true;
    this.takeRoll(r, 1);
  };
  private readonly onMotion = (e: DeviceMotionEvent) => {
    // The orientation sensor is smoother; gravity alone is the fallback for phones whose orientation
    // sensor never answers. Not "silent for a while": Chromium sends nothing while a device is still.
    if (this.orientSeen) return;
    const g = e.accelerationIncludingGravity;
    const r = motionRoll(g?.x, g?.y, g?.z, screenAngle(), this.iosGravity);
    if (r) this.takeRoll(r, MOTION_SMOOTH_SCALE);
  };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const k = e.code;
      if (activatesFocused(e)) {
        // The browser clicks the button (Next track, Resume, a menu item). Marked held, so the
        // key's auto-repeat doesn't restart the race once the button is gone.
        this.keys.add(k);
        return;
      }
      if (!this.keys.has(k)) {
        const a = keyAction(k);
        // Shift and N have no default to prevent (and Shift+Tab must keep moving the focus).
        if (a === 'nitro') this.pressNitro('key');
        else if (a && this.enabled) {
          e.preventDefault();
          this.actionHandler?.(a, 'key');
        }
      }
      this.keys.add(k);
      if (k.startsWith('Arrow') || k === 'Space' || k === 'Backspace') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  onAction(fn: (a: Action, src: ActionSource) => void): void {
    this.actionHandler = fn;
  }

  setTouchState(t: TouchInput): void {
    this.touch = { steer: t.steer, gas: t.gas, brake: t.brake };
  }

  clearTouch(): void {
    this.touch = { steer: null, gas: 0, brake: 0 };
    this.nitroTouch = false;
  }

  /** The touch Nitro button went down (true) or every finger left it (false). Going down is a press. */
  setNitroTouch(held: boolean): void {
    if (held && !this.nitroTouch) this.pressNitro('touch');
    this.nitroTouch = held;
  }

  /**
   * A nitro press (key, controller, touch, or an accessibility click on the button): it reaches the
   * race on the next read() even when let go before it, and the mode hears it as the 'nitro' action.
   */
  pressNitro(src: ActionSource): void {
    if (!this.enabled) return;
    this.nitroPressAt = performance.now();
    this.actionHandler?.('nitro', src);
  }

  /** Forget a nitro press no race has read yet (a new run starts). */
  clearNitroPress(): void {
    this.nitroPressAt = -Infinity;
  }

  /** A tilt reading has arrived since tilt was turned on (the sensor answers). */
  get tiltLive(): boolean {
    return this.filter.value !== null;
  }

  /** Tilt smoothing 0 (raw) .. 1 (heavy), settings.tiltSmoothing. */
  get tiltSmoothing(): number {
    return this.smoothing;
  }

  set tiltSmoothing(s: number) {
    this.smoothing = s;
    this.filter.cutoff = smoothingCutoff(s);
  }

  /**
   * Listen to the motion sensors or stop. The listeners are only added while tilt is on, so
   * the sensors don't run (battery) for everyone else. Turning it off forgets the reading.
   */
  setTilt(on: boolean): void {
    if (on === this.tiltOn) return;
    this.tiltOn = on;
    if (on) {
      this.iosGravity = isIOS();
      window.addEventListener('deviceorientation', this.onOrientation);
      window.addEventListener('devicemotion', this.onMotion);
      return;
    }
    // Tests stub window with addEventListener only.
    if (typeof window.removeEventListener === 'function') {
      window.removeEventListener('deviceorientation', this.onOrientation);
      window.removeEventListener('devicemotion', this.onMotion);
    }
    this.filter.reset();
    this.lastRaw = null;
    this.orientSeen = false;
    // Tilt was turned off (another steering mode picked) while a check waited: it is over, not failed later.
    this.tiltWaiters.splice(0).forEach((f) => f(false));
  }

  /**
   * Turn tilt on from a tap: asks for motion permission first where the browser has the API
   * (iOS prompts; it must be called from the tap, before anything is awaited; Android WebViews
   * have it too and always grant), then waits for the sensor. False when permission is
   * denied or nothing answers within `ms` (no sensor); tilt is left on either way.
   */
  async requestTilt(ms = 1500): Promise<boolean> {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.setTilt(true);
    return this.waitForTilt(ms);
  }

  /** True as soon as a tilt reading is in (at once if one is), false after `ms` without one or when tilt is turned off. */
  waitForTilt(ms: number): Promise<boolean> {
    if (this.tiltLive) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        this.tiltWaiters = this.tiltWaiters.filter((f) => f !== settle);
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false), ms);
      this.tiltWaiters.push(settle);
    });
  }

  /** The smoothed device roll in degrees now, or null with no reading (the tilt previews read it). */
  tiltAngle(): number | null {
    if (this.lastRaw === null) return null;
    return this.filter.advance(this.lastRaw, performance.now(), this.lastScale);
  }

  /** Tilt steering -1..1 now (0 with no reading). */
  tiltSteer(): number {
    const roll = this.tiltAngle();
    return roll === null ? 0 : steerFromRoll(roll, this.tiltCenter, this.tiltSensitivity, this.tiltDeadzone, this.tiltCurve);
  }

  /** Make the current roll straight ahead (at most 30 degrees off level). The new centre, or null with no reading. */
  recentreTilt(): number | null {
    const roll = this.tiltAngle();
    if (roll === null) return null;
    this.tiltCenter = clampCenter(roll);
    return this.tiltCenter;
  }

  private takeRoll(r: TiltReading, scale: number): void {
    const first = !this.tiltLive;
    this.lastRaw = rawRoll(this.lastRaw, r, this.tiltCenter);
    this.lastScale = scale;
    this.filter.push(this.lastRaw, performance.now(), scale);
    if (!first) return;
    this.tiltWaiters.splice(0).forEach((f) => f(true));
    this.onTiltLive?.();
  }

  /**
   * The controls now. Call it once per racing step: a nitro press since the last call is taken
   * here (as well as a held N, Shift, RB or touch button), so a second call in the same frame
   * would not see it again. A press made with the brake down is kept until the brake lifts.
   */
  read(): Controls {
    let steer = 0;
    let gas = 0;
    let brake = 0;
    const k = this.keys;
    let nitro = this.nitroTouch || performance.now() - this.nitroPressAt < NITRO_PRESS_MS || NITRO_KEYS.some((n) => k.has(n));
    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1;
    if (k.has('ArrowUp') || k.has('KeyW')) gas = 1;
    if (k.has('ArrowDown') || k.has('KeyS') || k.has('Space')) brake = 1;

    // Touch steering (buttons or wheel) wins over tilt; tilt counts only once the sensor answers.
    const t = this.touch;
    if (t.steer !== null) steer += t.steer;
    else if (this.tiltOn) steer += this.tiltSteer();
    gas = Math.max(gas, t.gas);
    brake = Math.max(brake, t.brake);

    const pad = this.readPad();
    if (pad) {
      if (Math.abs(pad.steer) > Math.abs(steer)) steer = pad.steer;
      gas = Math.max(gas, pad.gas);
      brake = Math.max(brake, pad.brake);
      nitro = nitro || pad.nitro === true;
    }
    // Any brake (the brake bar gives at least 0.55) lifts the automatic throttle.
    if (this.autoAccelerate && brake === 0) gas = Math.max(gas, 1);
    // The press is taken only by a step that can fire it (stepCar needs the brake up): one made at the
    // end of a braking zone waits, NITRO_PRESS_MS at most, for the brake to lift.
    if (brake === 0) this.nitroPressAt = -Infinity;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const c: Controls = { steer: Math.max(-1, Math.min(1, steer)), gas: clamp01(gas), brake: clamp01(brake) };
    // Only when asked for, so the plain {steer, gas, brake} of every other tick stays as it was.
    if (nitro) c.nitro = true;
    return c;
  }

  /** Only the gamepad's button presses, for screens that don't read() (Start resumes a paused race). */
  pollPad(): void {
    this.readPad();
  }

  private readPad(): Controls | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads && Array.from(pads).find((x) => x && x.connected);
    if (!p) return null;
    const b = (i: number) => (p.buttons[i] ? p.buttons[i].value : 0);
    const pressed = (i: number) => !!p.buttons[i]?.pressed;
    let steer = p.axes[0] ?? 0;
    if (Math.abs(steer) < 0.12) steer = 0;
    if (pressed(14)) steer = -1;
    if (pressed(15)) steer = 1;
    // A trigger resting a hair off zero must read exactly 0 (rolling resistance needs it).
    const trig = (v: number) => (v < 0.05 ? 0 : v);
    const gas = Math.max(trig(b(7)), pressed(0) ? 1 : 0);
    const brake = Math.max(trig(b(6)), pressed(2) ? 1 : 0, pressed(1) ? 1 : 0);
    // Edge-triggered actions.
    const map: [number, Action][] = [
      [3, 'respawn'],
      [8, 'restart'],
      [9, 'pause'],
      [4, 'camera'],
      [PAD_NITRO, 'nitro'],
    ];
    for (const [i, a] of map) {
      const now = pressed(i);
      if (now && !this.padPrev[i]) {
        if (a === 'nitro') this.pressNitro('gamepad');
        else if (this.enabled) this.actionHandler?.(a, 'gamepad');
      }
      this.padPrev[i] = now;
    }
    const c: Controls = { steer, gas, brake };
    if (pressed(PAD_NITRO)) c.nitro = true;
    return c;
  }
}

function keyAction(code: string): Action | null {
  switch (code) {
    case 'KeyN':
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'nitro';
    case 'Backspace':
    case 'KeyR':
      return 'respawn';
    case 'Enter':
    case 'Delete':
      return 'restart';
    case 'Escape':
    case 'KeyP':
      return 'pause';
    case 'KeyC':
      return 'camera';
    case 'KeyG':
      return 'ghost';
    default:
      return null;
  }
}

/** A text field, checkbox, slider (native or the role=slider of src/ui/slider.ts) or drop-down has focus: it takes every key. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.getAttribute?.('role') === 'slider')
  );
}

/** Enter on a focused button or link clicks it, so it is not the restart key there. */
function activatesFocused(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return e.code === 'Enter' && !!t && (t.tagName === 'BUTTON' || t.tagName === 'A');
}

/**
 * iPhone, iPad or iPod, from the platform: requestPermission no longer tells (Chromium has it
 * too). iPadOS says it is a Mac, but no Mac has a touchscreen.
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent ?? '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
