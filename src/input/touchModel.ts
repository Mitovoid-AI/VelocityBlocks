// The on-screen driving controls as fingers and boxes: which finger holds what, and what that
// means for steer, gas and brake. Pure (no DOM), so the rules are unit-tested
// (tests/touchModel.test.ts); TouchControls feeds it pointer events and the measured boxes.
//
// The rules, per finger:
// - ◀ ▶ buttons: a finger slides from one onto the other; sliding off into empty space keeps
//   the last one held; a button finger never takes a pedal or the wheel.
// - Pedal bars: the higher on the bar, the more (see pedalValue); released is exactly 0. A
//   finger slides between gas and brake once it is a third of the way into the other bar.
//   Gas keeps its last value when the finger slides off the bar, below it or sideways (a
//   resting thumb drifts). The brake lets go when the finger slides off towards the middle of
//   the screen (foot off), and takes hold again if it slides back onto a bar. As round on/off
//   buttons (digital) both pedals give 1 and keep it until the finger lifts.
// - Wheel: one finger turns it, from wherever it grabbed (no jump on touch); it never hands its
//   finger to another control. A second finger on the wheel is ignored. Released, it centres.
// - A touch that went down somewhere else (the thumb held through the pause menu, then Resume)
//   takes the control it moves onto. A mouse only drives what it pressed.

import type { SteerMode } from '../game/storage';

export type PadKey = 'left' | 'right';
export type PedalKey = 'gas' | 'brake';
export type CtlKey = PadKey | PedalKey | 'wheel';

/** A control's box in CSS px (a DOMRect fits). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Gas from any touch on the bar, at its bottom edge. */
export const GAS_MIN = 0.35;
/** Gas is full from this fraction of the bar's height up (styles.css .t-gas --full). */
export const GAS_FULL_AT = 0.3;
/** Brake from any touch: above the brake-tap drift threshold (vehicle.ts drift needs brake > 0.5). */
export const BRAKE_MIN = 0.55;
/** Brake is full from this fraction of the bar's height up (styles.css .t-brake --full). */
export const BRAKE_FULL_AT = 0.5;
/** A finger this far beside a pedal bar still works it (thumbs drift). */
export const PEDAL_KEEP_PX = 24;
/** Wheel turn (degrees) for full steering lock. */
export const WHEEL_LOCK_DEG = 100;
/** Inside this fraction of the wheel's radius (the hub) a finger turns nothing. */
export const WHEEL_HUB = 0.3;
/** Turning is damped inside this fraction of the radius, where a small move is a big angle. */
export const WHEEL_FULL_GAIN = 0.6;

const LOCK = (WHEEL_LOCK_DEG * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isPad = (k: CtlKey): k is PadKey => k === 'left' || k === 'right';
const isPedal = (k: CtlKey): k is PedalKey => k === 'gas' || k === 'brake';

/** Pedal amount for a finger at `y` on a bar spanning top..bottom (screen y grows downwards). */
export function pedalValue(key: PedalKey, y: number, top: number, bottom: number): number {
  const t = clamp((bottom - y) / Math.max(1, bottom - top), 0, 1);
  const [min, full] = key === 'gas' ? [GAS_MIN, GAS_FULL_AT] : [BRAKE_MIN, BRAKE_FULL_AT];
  return t >= full ? 1 : min + ((1 - min) * t) / full;
}

/** a - b in radians, wrapped to -pi..pi. */
export function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** The pause menu's Steering row: Buttons > Wheel > Tilt > Buttons. */
export const nextSteerMode = (m: SteerMode): SteerMode => (m === 'buttons' ? 'wheel' : m === 'wheel' ? 'tilt' : 'buttons');

export const STEER_LABEL: Record<SteerMode, string> = { buttons: 'Buttons', wheel: 'Wheel', tilt: 'Tilt' };

type Hold =
  | { kind: 'pad'; key: PadKey }
  | { kind: 'pedal'; key: PedalKey; box: Rect; value: number }
  | { kind: 'wheel'; cx: number; cy: number; r: number; last: number | null; turned: number }
  /** Slid off the brake: holds nothing until it slides onto a pedal again. */
  | { kind: 'free' };

/** What the fingers add up to. */
export interface TouchRead {
  /** -1..1, or null when nothing steers by touch (tilt may steer then). */
  steer: number | null;
  /** The wheel's turn -1..1, or null when no finger is on it. */
  wheel: number | null;
  gas: number;
  brake: number;
  pads: { left: boolean; right: boolean };
}

export class TouchModel {
  /** On/off pedals (round buttons): any touch is full gas or brake. */
  digital = false;
  private targets = new Map<CtlKey, Rect>();
  private midX = 0;
  private held = new Map<number, Hold>();

  /** The shown controls' boxes and the viewport width. Zero-size (hidden) boxes are dropped. Holds keep their own. */
  setTargets(boxes: Partial<Record<CtlKey, Rect>>, vw: number): void {
    this.targets.clear();
    for (const [k, b] of Object.entries(boxes) as [CtlKey, Rect][]) {
      if (b && b.right > b.left && b.bottom > b.top) this.targets.set(k, { left: b.left, top: b.top, right: b.right, bottom: b.bottom });
    }
    this.midX = vw / 2;
  }

  /** A finger went down on control `key`. False when nothing changed (a second finger on the wheel). */
  press(id: number, key: CtlKey, x: number, y: number): boolean {
    if (key === 'wheel') {
      for (const [other, h] of this.held) if (h.kind === 'wheel' && other !== id) return false;
      const b = this.targets.get('wheel');
      const cx = b ? (b.left + b.right) / 2 : x;
      const cy = b ? (b.top + b.bottom) / 2 : y;
      const r = b ? Math.min(b.right - b.left, b.bottom - b.top) / 2 : 1;
      const h: Hold = { kind: 'wheel', cx, cy, r, last: null, turned: 0 };
      this.held.set(id, h);
      this.turn(h, x, y);
      return true;
    }
    if (isPad(key)) {
      this.held.set(id, { kind: 'pad', key });
      return true;
    }
    this.held.set(id, this.pedalHold(key, y));
    return true;
  }

  /** A pointer moved. `isTouch`: it may take a control it did not press (see the rules above). */
  move(id: number, x: number, y: number, isTouch: boolean): boolean {
    const h = this.held.get(id);
    if (h?.kind === 'wheel') return this.turn(h, x, y);
    if (!h && !isTouch) return false;
    const k = this.at(x, y);
    if (!h || h.kind === 'free') {
      if (!k || (h && !isPedal(k))) return false;
      return this.press(id, k, x, y);
    }
    if (h.kind === 'pad') {
      if (!k || !isPad(k) || k === h.key) return false;
      h.key = k;
      return true;
    }
    const other: PedalKey = h.key === 'gas' ? 'brake' : 'gas';
    const ob = this.targets.get(other);
    if (ob && this.wellInto(ob, h.box, x, y)) {
      this.held.set(id, this.pedalHold(other, y));
      return true;
    }
    const b = h.box;
    if (!this.digital && h.key === 'brake') {
      const inward = (b.left + b.right) / 2 > this.midX ? x < b.left - PEDAL_KEEP_PX : x > b.right + PEDAL_KEEP_PX;
      if (inward) {
        this.held.set(id, { kind: 'free' });
        return true;
      }
    }
    // Off the bar (below it or to the side): the pedal stays where it was.
    if (this.digital || y > b.bottom || x < b.left - PEDAL_KEEP_PX || x > b.right + PEDAL_KEEP_PX) return false;
    const v = pedalValue(h.key, y, b.top, b.bottom);
    if (v === h.value) return false;
    h.value = v;
    return true;
  }

  /** A pointer lifted or was cancelled. */
  lift(id: number): boolean {
    return this.held.delete(id);
  }

  clear(): void {
    this.held.clear();
  }

  /** Let go of the ◀ ▶ buttons and the wheel (their layout changed); pedal fingers stay. */
  releaseSteering(): boolean {
    let changed = false;
    for (const [id, h] of this.held) {
      if (h.kind === 'pad' || h.kind === 'wheel') changed = this.held.delete(id) || changed;
    }
    return changed;
  }

  read(): TouchRead {
    let gas = 0;
    let brake = 0;
    let left = false;
    let right = false;
    let wheel: number | null = null;
    for (const h of this.held.values()) {
      if (h.kind === 'pad') {
        if (h.key === 'left') left = true;
        else right = true;
      } else if (h.kind === 'pedal') {
        if (h.key === 'gas') gas = Math.max(gas, h.value);
        else brake = Math.max(brake, h.value);
      } else if (h.kind === 'wheel') {
        wheel = h.turned / LOCK;
      }
    }
    // Both buttons held is 0, not null, so tilt stays out of it.
    const steer = wheel ?? (left || right ? (right ? 1 : 0) - (left ? 1 : 0) : null);
    return { steer, wheel, gas, brake, pads: { left, right } };
  }

  private pedalHold(key: PedalKey, y: number): Hold {
    const box = this.targets.get(key) ?? { left: 0, top: y, right: 0, bottom: y };
    return { kind: 'pedal', key, box, value: this.digital ? 1 : pedalValue(key, y, box.top, box.bottom) };
  }

  /** The control under a point. The wheel counts as its circle. */
  private at(x: number, y: number): CtlKey | undefined {
    for (const [k, b] of this.targets) {
      if (k === 'wheel') {
        const r = Math.min(b.right - b.left, b.bottom - b.top) / 2;
        if (Math.hypot(x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2) <= r) return k;
      } else if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
        return k;
      }
    }
    return undefined;
  }

  /** The point is on bar `b`, at least a third of its width in from the side facing bar `from`. */
  private wellInto(b: Rect, from: Rect, x: number, y: number): boolean {
    if (y < b.top || y > b.bottom || x < b.left || x > b.right) return false;
    const third = (b.right - b.left) / 3;
    return b.left + b.right < from.left + from.right ? b.right - x >= third : x - b.left >= third;
  }

  /** Turn the wheel to the finger. False when the turn did not change. */
  private turn(h: Extract<Hold, { kind: 'wheel' }>, x: number, y: number): boolean {
    const dx = x - h.cx;
    const dy = y - h.cy;
    const d = Math.hypot(dx, dy);
    // Over the hub the angle means nothing: grab again on the way out, so there is no jump.
    if (d < WHEEL_HUB * h.r) {
      h.last = null;
      return false;
    }
    // 0 at 12 o'clock, clockwise positive (screen y points down).
    const a = Math.atan2(dx, -dy);
    const before = h.turned;
    if (h.last !== null) {
      const gain = Math.min(1, d / (WHEEL_FULL_GAIN * h.r));
      // A hard stop at full lock, with no wind-up past it.
      h.turned = clamp(h.turned + angleDelta(a, h.last) * gain, -LOCK, LOCK);
    }
    h.last = a;
    return h.turned !== before;
  }
}
