// The touch Nitro button (TouchControls.bindNitro): held from pointerdown (a second finger too)
// until every finger lifts or slides off, let go when the controls hide, and edge-guarded only
// where it is edge-anchored (tilt with auto-accelerate). The DOM is stood in for.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Input } from '../src/input/input';
import { TouchControls } from '../src/input/touchControls';

afterEach(() => vi.unstubAllGlobals());

type Ev = Record<string, unknown>;

function setup() {
  vi.stubGlobal('window', { addEventListener() {}, clearTimeout() {}, setTimeout: () => 0, innerWidth: 640 });
  const on = new Map<string, ((e: Ev) => void)[]>();
  const cls = new Set<string>();
  const attrs = new Set<string>();
  const button = {
    addEventListener: (t: string, fn: (e: Ev) => void) => on.set(t, [...(on.get(t) ?? []), fn]),
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 164, bottom: 164, width: 64, height: 64 }),
    setPointerCapture: vi.fn(),
    classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) },
    toggleAttribute: (a: string, on: boolean) => (on ? attrs.add(a) : attrs.delete(a)),
  };
  const root = {
    querySelectorAll: () => [],
    querySelector: (sel: string) => (sel === '.t-nitro' ? button : null),
    classList: { toggle: vi.fn() },
  };
  const input = { setNitroTouch: vi.fn(), pressNitro: vi.fn(), setTouchState: vi.fn(), onTiltLive: null, tiltLive: false };
  const tc = new TouchControls(root as unknown as HTMLElement, input as unknown as Input);
  const fire = (t: string, e: Ev = {}) => on.get(t)?.forEach((fn) => fn({ pointerId: 1, clientX: 130, clientY: 130, preventDefault: vi.fn(), ...e }));
  return { tc, input, fire, cls, attrs, button };
}

describe('the touch Nitro button', () => {
  it('is held from pointerdown until the last finger on it lifts', () => {
    const { input, fire, cls, button } = setup();
    fire('pointerdown', { pointerId: 1 });
    expect(input.setNitroTouch).toHaveBeenLastCalledWith(true);
    expect(button.setPointerCapture).toHaveBeenCalledWith(1);
    expect(cls.has('pressing')).toBe(true);
    fire('pointerdown', { pointerId: 2 }); // a second finger
    fire('pointerup', { pointerId: 1 });
    expect(input.setNitroTouch).not.toHaveBeenCalledWith(false);
    fire('pointercancel', { pointerId: 2 });
    expect(input.setNitroTouch).toHaveBeenLastCalledWith(false);
    expect(cls.has('pressing')).toBe(false);
  });

  it('a thumb that slides off it (on to the steering) lets go of the nitro', () => {
    const { input, fire } = setup();
    fire('pointerdown');
    fire('pointermove', { clientX: 170 }); // within the slack
    expect(input.setNitroTouch).not.toHaveBeenCalledWith(false);
    fire('pointermove', { clientX: 120, clientY: 200 });
    expect(input.setNitroTouch).toHaveBeenLastCalledWith(false);
  });

  it('an accessibility click (no pointer) presses it once', () => {
    const { input, fire } = setup();
    fire('click', { detail: 1 });
    expect(input.pressNitro).not.toHaveBeenCalled();
    fire('click', { detail: 0 });
    expect(input.pressNitro).toHaveBeenCalledWith('touch');
  });

  it('is let go when the controls hide (pause, menus, results)', () => {
    const { tc, input, fire, cls } = setup();
    tc.show(true);
    fire('pointerdown');
    tc.show(false);
    expect(input.setNitroTouch).toHaveBeenLastCalledWith(false);
    expect(cls.has('pressing')).toBe(false);
  });

  it('is edge-guarded only with tilt and auto-accelerate, where it takes the bottom-left corner', () => {
    const { tc, attrs } = setup();
    tc.setLayout({ steer: 'buttons', pedals: 'bars', autoGas: false });
    expect(attrs.has('data-edge-guard')).toBe(false);
    tc.setLayout({ steer: 'tilt', pedals: 'bars', autoGas: true });
    expect(attrs.has('data-edge-guard')).toBe(true);
    tc.setLayout({ steer: 'tilt', pedals: 'bars', autoGas: false });
    expect(attrs.has('data-edge-guard')).toBe(false);
    tc.setLayout({ steer: 'wheel', pedals: 'buttons', autoGas: true });
    expect(attrs.has('data-edge-guard')).toBe(false);
  });
});
