// Input: analog touch state, auto-accelerate, tilt steering from the sensors, gamepad triggers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/input/input';

type Handler = (e: unknown) => void;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** An Input over a stub window whose listeners the test can fire (`win` and `nav` add to the stubs). */
function input(angle = 90, win: Record<string, unknown> = {}, nav: Record<string, unknown> = {}) {
  const on = new Map<string, Set<Handler>>();
  vi.stubGlobal('window', {
    ...win,
    addEventListener: (t: string, fn: Handler) => {
      if (!on.has(t)) on.set(t, new Set());
      on.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: Handler) => on.get(t)?.delete(fn),
  });
  vi.stubGlobal('screen', { orientation: { angle } });
  vi.stubGlobal('navigator', nav);
  const inp = new Input();
  const fire = (t: string, e: unknown) => on.get(t)?.forEach((fn) => fn(e));
  /** A deviceorientation event for a device upright in landscape, turned `roll` degrees right. */
  const tilt = (roll: number) => fire('deviceorientation', angle === 270 ? { beta: -roll, gamma: 90 } : { beta: roll, gamma: -90 });
  const listening = (t: string) => (on.get(t)?.size ?? 0) > 0;
  return { inp, fire, tilt, listening };
}

describe('Input touch state', () => {
  it('passes analog touch values through', () => {
    const { inp } = input();
    inp.setTouchState({ steer: 0.4, gas: 0.62, brake: 0 });
    expect(inp.read()).toEqual({ steer: 0.4, gas: 0.62, brake: 0 });
  });

  it('released touch controls give exactly 0 gas and brake (rolling resistance needs it)', () => {
    const { inp } = input();
    inp.setTouchState({ steer: null, gas: 0.7, brake: 0.8 });
    inp.clearTouch();
    const c = inp.read();
    expect(c.gas).toBe(0);
    expect(c.brake).toBe(0);
    expect(c.steer).toBe(0);
  });

  it('auto-accelerate holds full gas until any brake', () => {
    const { inp } = input();
    inp.autoAccelerate = true;
    expect(inp.read().gas).toBe(1);
    inp.setTouchState({ steer: null, gas: 0, brake: 0.55 });
    expect(inp.read()).toMatchObject({ gas: 0, brake: 0.55 });
  });
});

describe('Input tilt', () => {
  it('listens to the sensors only while tilt is on', () => {
    const { inp, listening } = input();
    expect(listening('deviceorientation')).toBe(false);
    inp.setTilt(true);
    expect(listening('deviceorientation')).toBe(true);
    expect(listening('devicemotion')).toBe(true);
    inp.setTilt(false);
    expect(listening('deviceorientation')).toBe(false);
    expect(listening('devicemotion')).toBe(false);
  });

  it('steers right for a clockwise turn in both landscapes', () => {
    for (const angle of [90, 270]) {
      const { inp, tilt } = input(angle);
      inp.setTilt(true);
      tilt(15);
      expect(inp.read().steer).toBeGreaterThan(0.5);
      inp.setTilt(false);
      inp.setTilt(true);
      tilt(-15);
      expect(inp.read().steer).toBeLessThan(-0.5);
    }
  });

  it('touch steering wins; tilt steers only when no touch steers', () => {
    const { inp, tilt } = input();
    inp.setTilt(true);
    tilt(30);
    inp.setTouchState({ steer: -1, gas: 0, brake: 0 });
    expect(inp.read().steer).toBe(-1);
    inp.setTouchState({ steer: 0, gas: 0, brake: 0 }); // both buttons held
    expect(inp.read().steer).toBe(0);
    inp.setTouchState({ steer: null, gas: 0, brake: 0 });
    expect(inp.read().steer).toBe(1);
  });

  it('ignores readings while tilt is off, and forgets them when turned off', () => {
    const { inp, tilt } = input();
    tilt(30);
    expect(inp.read().steer).toBe(0);
    inp.setTilt(true);
    tilt(30);
    expect(inp.tiltLive).toBe(true);
    inp.setTilt(false);
    expect(inp.tiltLive).toBe(false);
    expect(inp.read().steer).toBe(0);
  });

  it('recentre makes the way the device is held straight ahead', () => {
    const { inp, tilt } = input();
    expect(inp.recentreTilt()).toBeNull();
    inp.setTilt(true);
    tilt(12);
    expect(inp.recentreTilt()).toBeCloseTo(12, 6);
    expect(inp.read().steer).toBe(0);
    tilt(80);
    tilt(80);
    expect(inp.recentreTilt()).toBe(30); // at most 30 degrees off level
  });

  it('waitForTilt: true on the first reading, false when nothing answers', async () => {
    vi.useFakeTimers();
    const { inp, tilt } = input();
    inp.setTilt(true);
    const silent = inp.waitForTilt(1000);
    vi.advanceTimersByTime(1001);
    expect(await silent).toBe(false);
    const live = vi.fn();
    inp.onTiltLive = live;
    const answered = inp.waitForTilt(1000);
    tilt(5);
    expect(await answered).toBe(true);
    expect(live).toHaveBeenCalledTimes(1);
    expect(await inp.waitForTilt(1000)).toBe(true); // already live
  });

  it('requestTilt turns tilt on and reports whether the sensor answers', async () => {
    vi.useFakeTimers();
    const { inp, listening } = input();
    const p = inp.requestTilt(500);
    await vi.advanceTimersByTimeAsync(501);
    expect(await p).toBe(false);
    expect(listening('deviceorientation')).toBe(true);
  });

  it('falls back to gravity (devicemotion) when the orientation sensor is silent', () => {
    const { inp, fire, tilt } = input();
    inp.setTilt(true);
    fire('deviceorientation', { beta: null, gamma: null }); // no gyroscope: one empty event
    const roll = 20 * (Math.PI / 180);
    // Upright in landscape (90), turned 20 degrees right: up is (cos r, sin r, 0) in device axes.
    fire('devicemotion', { accelerationIncludingGravity: { x: 9.81 * Math.cos(roll), y: 9.81 * Math.sin(roll), z: 0 } });
    expect(inp.read().steer).toBeGreaterThan(0.5);
    // While the orientation sensor answers, gravity readings are ignored.
    for (let i = 0; i < 5; i++) tilt(-20);
    fire('devicemotion', { accelerationIncludingGravity: { x: 9.81, y: 9.81, z: 0 } });
    expect(inp.read().steer).toBeLessThan(-0.5);
  });

  /** Gravity (reaction-to-gravity, Android's sign) for a device upright in landscape 90, turned 20 degrees right. */
  const turned20 = (s = 1) => {
    const roll = 20 * (Math.PI / 180);
    return { accelerationIncludingGravity: { x: s * 9.81 * Math.cos(roll), y: s * 9.81 * Math.sin(roll), z: 0 } };
  };
  const permission = { requestPermission: () => Promise.resolve('granted') };

  it('gravity keeps its sign on Android WebViews that have requestPermission too', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/152.0.0.0 Mobile Safari/537.36';
    const { inp, fire } = input(90, { DeviceMotionEvent: permission, DeviceOrientationEvent: permission }, { userAgent: android, platform: 'Linux armv8l', maxTouchPoints: 5 });
    inp.setTilt(true);
    fire('devicemotion', turned20());
    expect(inp.read().steer).toBeGreaterThan(0.5);
  });

  it('gravity is flipped on iPhones and on iPads that say they are a Mac', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    for (const nav of [
      { userAgent: iphone, platform: 'iPhone', maxTouchPoints: 5 },
      { userAgent: ipad, platform: 'MacIntel', maxTouchPoints: 5 },
    ]) {
      const { inp, fire } = input(90, { DeviceMotionEvent: permission }, nav);
      inp.setTilt(true);
      fire('devicemotion', turned20(-1));
      expect(inp.read().steer).toBeGreaterThan(0.5);
    }
  });
});

describe('Input gamepad', () => {
  function pad() {
    const p = { connected: true, axes: [0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
    const { inp } = input();
    vi.stubGlobal('navigator', { getGamepads: () => [p] });
    return { inp, p };
  }

  it('a trigger resting just off zero reads exactly 0', () => {
    const { inp, p } = pad();
    p.buttons[7].value = 0.03;
    p.buttons[6].value = 0.04;
    expect(inp.read()).toMatchObject({ gas: 0, brake: 0 });
    p.buttons[7].value = 0.5;
    expect(inp.read().gas).toBe(0.5);
  });
});
