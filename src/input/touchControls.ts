// The on-screen driving controls (#touch in index.html): ◀ ▶ buttons, wheel or tilt for
// steering, and gas / brake as analog bars or round buttons. This is the DOM side: pointer
// events go to TouchModel (the finger rules, tested without a DOM), and what it reads goes to
// Input and onto the controls. The pills (CP, Restart, Pause, Cam) are bound by App.
//
// Kept from the round pads: controls act on pointerdown; touchstart is cancelled so a held
// control never sets off Android's long-press buzz; a thumb held through the pause menu takes
// the control it moves onto after Resume (TouchModel).

import { STEER_MODES, type PedalMode, type SteerMode } from '../game/storage';
import type { Input } from './input';
import { TouchModel, WHEEL_LOCK_DEG, type CtlKey, type Rect } from './touchModel';

export interface TouchLayout {
  steer: SteerMode;
  pedals: PedalMode;
  /** Auto-accelerate: the gas bar is hidden and the brake takes its place. */
  autoGas: boolean;
}

/** With tilt chosen, the ◀ ▶ buttons take over if the sensor has not answered this long after the controls show. */
const TILT_WAIT_MS = 1500;

export class TouchControls {
  private readonly model = new TouchModel();
  private readonly ctls: HTMLElement[];
  private readonly rim: HTMLElement | null;
  private layout: TouchLayout = { steer: 'buttons', pedals: 'bars', autoGas: false };
  private shown = false;
  /** Tilt is chosen but the sensor has not answered: the buttons are shown instead. */
  private fallback = false;
  private fallbackTimer = 0;

  /**
   * `notify` shows a short message during the race (why the buttons replaced tilt). `onRelayout`
   * runs when the controls change places by themselves (tilt gives way to the buttons, or comes
   * back): App.syncEdgeGuard measures them and moves the gesture exclusion with them.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly input: Input,
    private readonly notify: (msg: string) => void = () => {},
    private readonly onRelayout: () => void = () => {},
  ) {
    this.ctls = [...root.querySelectorAll<HTMLElement>('.t-ctl')];
    this.rim = root.querySelector<HTMLElement>('.t-wheel-rim');
    for (const el of this.ctls) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        // Fresh boxes on every touch: the layout may have moved (rotation, gesture strips).
        this.measure();
        if (this.model.press(e.pointerId, el.dataset.t as CtlKey, e.clientX, e.clientY)) this.sync();
      });
      // Cancelling touchstart stops Android's long-press gesture, which otherwise buzzes
      // the phone (and may open a context menu) about half a second into every held control.
      el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('pointermove', (e) => {
      // Editor pans and menu drags never reach the model.
      if (!this.shown) return;
      if (this.model.move(e.pointerId, e.clientX, e.clientY, e.pointerType === 'touch')) this.sync();
    });
    const lift = (e: PointerEvent) => {
      if (this.model.lift(e.pointerId)) this.sync();
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    input.onTiltLive = () => {
      if (!this.fallback) return;
      // The sensor answered after all: back to tilt.
      this.fallback = false;
      if (this.model.releaseSteering()) this.sync();
      this.applyClasses();
      this.onRelayout();
    };
  }

  /** Apply the steering and pedal settings. Fingers on controls whose layout changed are let go. */
  setLayout(l: TouchLayout): void {
    const was = this.layout;
    this.layout = { ...l };
    this.model.digital = l.pedals === 'buttons';
    if (l.steer !== was.steer) {
      window.clearTimeout(this.fallbackTimer);
      this.fallback = false;
      this.model.releaseSteering();
    }
    if (l.pedals !== was.pedals || l.autoGas !== was.autoGas) this.model.clear();
    this.applyClasses();
    this.sync();
    if (this.shown) {
      this.measure();
      this.watchTilt();
    }
  }

  /** Show or hide the controls. Hiding lets go of every control (pause, menus, results). */
  show(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.root.classList.toggle('hidden', !v);
    window.clearTimeout(this.fallbackTimer);
    if (!v) {
      this.release();
      return;
    }
    this.measure();
    this.watchTilt();
  }

  /** Let go of everything. */
  release(): void {
    this.model.clear();
    this.sync();
  }

  /**
   * Read the shown controls' boxes for the model's hit tests (holds keep the box they started
   * with). Call it after the controls move (App.syncEdgeGuard does: resize, rotation, gesture strips).
   */
  measure(): void {
    if (!this.shown) return;
    const boxes: Partial<Record<CtlKey, Rect>> = {};
    for (const el of this.ctls) boxes[el.dataset.t as CtlKey] = el.getBoundingClientRect();
    this.model.setTargets(boxes, window.innerWidth);
  }

  /** Tilt with no reading yet: give the sensor a moment, then show the buttons instead. */
  private watchTilt(): void {
    window.clearTimeout(this.fallbackTimer);
    if (this.layout.steer !== 'tilt' || this.fallback || this.input.tiltLive) return;
    this.fallbackTimer = window.setTimeout(() => {
      if (!this.shown || this.layout.steer !== 'tilt' || this.input.tiltLive) return;
      this.fallback = true;
      this.applyClasses();
      // The ◀ ▶ buttons may come up by an edge nothing guarded (tilt with auto-accelerate).
      this.onRelayout();
      this.notify('No tilt sensor reading - steer with the buttons');
    }, TILT_WAIT_MS);
  }

  /** Root classes for the layout (classList, so 'hidden' survives). */
  private applyClasses(): void {
    const l = this.layout;
    const steer: SteerMode = l.steer === 'tilt' && this.fallback ? 'buttons' : l.steer;
    for (const s of STEER_MODES) this.root.classList.toggle(`steer-${s}`, s === steer);
    this.root.classList.toggle('pedals-bars', l.pedals === 'bars');
    this.root.classList.toggle('pedals-buttons', l.pedals === 'buttons');
    this.root.classList.toggle('auto-gas', l.autoGas);
  }

  /** Model to Input and to the controls' looks. */
  private sync(): void {
    const s = this.model.read();
    this.input.setTouchState({ steer: s.steer, gas: s.gas, brake: s.brake });
    for (const el of this.ctls) {
      const k = el.dataset.t as CtlKey;
      if (k === 'left' || k === 'right') {
        el.classList.toggle('active', s.pads[k]);
      } else if (k === 'gas' || k === 'brake') {
        const v = s[k];
        el.style.setProperty('--v', v.toFixed(3));
        el.classList.toggle('active', v > 0);
      }
    }
    // Not held, the CSS transition brings the wheel back to the centre.
    if (this.rim) this.rim.style.transform = `rotate(${((s.wheel ?? 0) * WHEEL_LOCK_DEG).toFixed(1)}deg)`;
    this.root.classList.toggle('wheel-held', s.wheel !== null);
  }
}
