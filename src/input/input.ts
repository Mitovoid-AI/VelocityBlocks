// Unified driving input: keyboard, gamepad, on-screen touch controls and optional tilt steering.

import type { Controls } from '../physics/vehicle';

export type Action = 'respawn' | 'restart' | 'pause' | 'camera' | 'ghost';

export class Input {
  private keys = new Set<string>();
  private touch = { left: false, right: false, gas: false, brake: false };
  private tiltSteer = 0;
  private actionHandler: ((a: Action) => void) | null = null;
  private padPrev: boolean[] = [];
  autoAccelerate = false;
  tiltEnabled = false;
  enabled = true;

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
        if (a && this.enabled) {
          e.preventDefault();
          this.actionHandler?.(a);
        }
      }
      this.keys.add(k);
      if (k.startsWith('Arrow') || k === 'Space' || k === 'Backspace') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('deviceorientation', (e) => {
      if (!this.tiltEnabled) return;
      // Landscape: device "beta" is the steering axis; the sign flips with orientation.
      const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 90) as number;
      const raw = e.beta ?? 0;
      const v = angle === 270 || angle === -90 ? -raw : raw;
      this.tiltSteer = Math.max(-1, Math.min(1, v / 22));
    });
  }

  onAction(fn: (a: Action) => void): void {
    this.actionHandler = fn;
  }

  setTouch(key: keyof Input['touch'], down: boolean): void {
    this.touch[key] = down;
  }

  clearTouch(): void {
    this.touch = { left: false, right: false, gas: false, brake: false };
  }

  /** Request iOS motion permission (must be called from a gesture). */
  async enableTilt(on: boolean): Promise<boolean> {
    this.tiltEnabled = on;
    if (!on) return true;
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        this.tiltEnabled = r === 'granted';
      } catch {
        this.tiltEnabled = false;
      }
    }
    return this.tiltEnabled;
  }

  read(): Controls {
    let steer = 0;
    let gas = 0;
    let brake = 0;
    const k = this.keys;
    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1;
    if (k.has('ArrowUp') || k.has('KeyW')) gas = 1;
    if (k.has('ArrowDown') || k.has('KeyS') || k.has('Space')) brake = 1;

    if (this.touch.left) steer -= 1;
    if (this.touch.right) steer += 1;
    if (this.touch.gas) gas = 1;
    if (this.touch.brake) brake = 1;
    if (this.tiltEnabled && !this.touch.left && !this.touch.right) steer += this.tiltSteer;

    const pad = this.readPad();
    if (pad) {
      if (Math.abs(pad.steer) > Math.abs(steer)) steer = pad.steer;
      gas = Math.max(gas, pad.gas);
      brake = Math.max(brake, pad.brake);
    }
    if (this.autoAccelerate && brake === 0) gas = Math.max(gas, 1);
    return { steer: Math.max(-1, Math.min(1, steer)), gas, brake };
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
    const gas = Math.max(b(7), pressed(0) ? 1 : 0);
    const brake = Math.max(b(6), pressed(2) ? 1 : 0, pressed(1) ? 1 : 0);
    // Edge-triggered actions.
    const map: [number, Action][] = [
      [3, 'respawn'],
      [8, 'restart'],
      [9, 'pause'],
      [4, 'camera'],
    ];
    for (const [i, a] of map) {
      const now = pressed(i);
      if (now && !this.padPrev[i] && this.enabled) this.actionHandler?.(a);
      this.padPrev[i] = now;
    }
    return { steer, gas, brake };
  }
}

function keyAction(code: string): Action | null {
  switch (code) {
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

/** A text field, checkbox, slider or drop-down has focus: it takes every key. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Enter on a focused button or link clicks it, so it is not the restart key there. */
function activatesFocused(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return e.code === 'Enter' && !!t && (t.tagName === 'BUTTON' || t.tagName === 'A');
}

export const isTouchDevice = (): boolean => 'ontouchstart' in window || navigator.maxTouchPoints > 0;
