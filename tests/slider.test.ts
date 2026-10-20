// The drag slider (src/ui/slider.ts): its pure helpers, its markup, and the pointer rules on a
// stand-in element (grab offset, the touch-on-track wait, revert on cancel, keys).

import { describe, expect, it, vi } from 'vitest';
import { bindSlider, keyStep, sliderFrac, sliderHtml, snapTo, THUMB_R, touchIntent, valueAtX, type SliderSpec } from '../src/ui/slider';

const SENS: SliderSpec = { min: 0, max: 1, step: 0.0125 };
const DEAD: SliderSpec = { min: 0, max: 6, step: 0.5 };

describe('snapTo', () => {
  it('rounds to the step without float drift, and clamps', () => {
    expect(snapTo(0.5125, SENS)).toBe(0.5125);
    expect(snapTo(0.0125 * 3, SENS)).toBe(0.0375);
    for (let n = 0; n <= 80; n++) expect(String(snapTo(n * 0.0125, SENS)).length).toBeLessThanOrEqual(6);
    expect(snapTo(0.51, SENS)).toBe(0.5125);
    expect(snapTo(-1, SENS)).toBe(0);
    expect(snapTo(2, SENS)).toBe(1);
    expect(snapTo(Number.NaN, SENS)).toBe(0);
    expect(snapTo(2.2, DEAD)).toBe(2);
    expect(snapTo(2.3, DEAD)).toBe(2.5);
    expect(snapTo(6, DEAD)).toBe(6);
  });
});

describe('valueAtX', () => {
  it('maps the thumb travel to the range, clamped beyond either end', () => {
    expect(valueAtX(10, 10, 200, DEAD)).toBe(0);
    expect(valueAtX(210, 10, 200, DEAD)).toBe(6);
    expect(valueAtX(110, 10, 200, DEAD)).toBe(3);
    expect(valueAtX(-50, 10, 200, DEAD)).toBe(0);
    expect(valueAtX(900, 10, 200, DEAD)).toBe(6);
    expect(valueAtX(50, 10, 0, DEAD)).toBe(0);
    expect(sliderFrac(1.5, DEAD)).toBe(0.25);
  });
});

describe('keyStep', () => {
  it("arrows step, Page keys move a tenth, Home and End go to the ends, other keys are not the slider's", () => {
    expect(keyStep('ArrowRight', 2, DEAD)).toBe(2.5);
    expect(keyStep('ArrowUp', 2, DEAD)).toBe(2.5);
    expect(keyStep('ArrowLeft', 2, DEAD)).toBe(1.5);
    expect(keyStep('ArrowDown', 0, DEAD)).toBe(0);
    expect(keyStep('PageUp', 2, DEAD)).toBe(2.5); // a tenth is 0.6, the nearest step 0.5
    expect(keyStep('PageUp', 0.5, SENS)).toBe(0.6);
    expect(keyStep('PageDown', 0.5, SENS)).toBe(0.4);
    expect(keyStep('Home', 3, DEAD)).toBe(0);
    expect(keyStep('End', 3, DEAD)).toBe(6);
    expect(keyStep('Enter', 3, DEAD)).toBeNull();
    expect(keyStep('KeyA', 3, DEAD)).toBeNull();
  });
});

describe('sliderHtml', () => {
  it('is a role=slider with its aria values and position, and no data-act (showScreen never routes it)', () => {
    const h = sliderHtml(DEAD, 1.5, { labelledBy: 'lbl', text: '1.5 degrees', id: 's-x', data: { tilt: 'dead' } });
    expect(h).toContain('role="slider"');
    expect(h).toContain('tabindex="0"');
    expect(h).toContain('aria-labelledby="lbl"');
    expect(h).toContain('aria-valuemin="0"');
    expect(h).toContain('aria-valuemax="6"');
    expect(h).toContain('aria-valuenow="1.5"');
    expect(h).toContain('aria-valuetext="1.5 degrees"');
    expect(h).toContain('--p:0.2500');
    expect(h).toContain('id="s-x"');
    expect(h).toContain('data-tilt="dead"');
    expect(h).not.toContain('data-act');
  });

  it('escapes what it is given', () => {
    expect(sliderHtml(DEAD, 0, { labelledBy: 'a"b', text: '<x>' })).not.toMatch(/a"b|<x>/);
  });
});

type Ev = Record<string, unknown>;

/** A stand-in slider element 224 px wide at x 0, so the thumb travels x 12..212 (200 px). */
function fake() {
  const on = new Map<string, ((e: Ev) => void)[]>();
  const style = new Map<string, string>();
  const attrs = new Map<string, string>();
  const cls = new Set<string>();
  const el = {
    addEventListener: (t: string, fn: (e: Ev) => void) => on.set(t, [...(on.get(t) ?? []), fn]),
    getBoundingClientRect: () => ({ left: 0, width: 224, right: 224, top: 0, bottom: 30, height: 30 }),
    style: { setProperty: (k: string, v: string) => style.set(k, v) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    setPointerCapture: vi.fn(),
    classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) },
    focus: vi.fn(),
  };
  const fire = (t: string, e: Ev = {}) => {
    const ev = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 0, clientY: 0, preventDefault: vi.fn(), ...e };
    on.get(t)?.forEach((fn) => fn(ev));
    return ev;
  };
  const input = vi.fn();
  const change = vi.fn();
  const spec: SliderSpec = { min: 0, max: 1, step: 0.05 };
  const h = bindSlider(el as unknown as HTMLElement, spec, 0.5, { input, change, text: (v) => `${Math.round(v * 100)}%` })!;
  /** x of a value's thumb centre. */
  const x = (v: number) => THUMB_R + v * 200;
  return { el, fire, style, attrs, cls, input, change, h, x };
}

describe('bindSlider', () => {
  it('is null-safe', () => {
    expect(bindSlider(null, DEAD, 1)).toBeNull();
  });

  it('a grab on the thumb keeps its offset (no jump), drags live, and saves once on lift', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.5) + 6 });
    expect(s.input).not.toHaveBeenCalled();
    // A touch waits for a sideways move before it is a drag (it may be a scroll).
    expect(s.cls.has('dragging')).toBe(false);
    s.fire('pointermove', { clientX: s.x(0.6) + 6 });
    expect(s.cls.has('dragging')).toBe(true);
    expect(s.input).toHaveBeenLastCalledWith(0.6);
    expect(s.style.get('--p')).toBe('0.6000');
    expect(s.attrs.get('aria-valuenow')).toBe('0.6');
    expect(s.attrs.get('aria-valuetext')).toBe('60%');
    s.fire('pointermove', { clientX: s.x(0.8) + 6 });
    expect(s.change).not.toHaveBeenCalled();
    s.fire('pointerup', { clientX: s.x(0.8) + 6 });
    s.fire('lostpointercapture');
    expect(s.change).toHaveBeenCalledTimes(1);
    expect(s.change).toHaveBeenCalledWith(0.8);
    expect(s.h.value).toBe(0.8);
    expect(s.cls.has('dragging')).toBe(false);
  });

  it('a second finger can drag it; another pointer is ignored while one is followed', () => {
    const s = fake();
    s.fire('pointerdown', { pointerId: 7, clientX: s.x(0.5) });
    s.fire('pointerdown', { pointerId: 8, clientX: s.x(0.1), pointerType: 'mouse' });
    s.fire('pointermove', { pointerId: 8, clientX: s.x(0.1) });
    expect(s.input).not.toHaveBeenCalled();
    s.fire('pointermove', { pointerId: 7, clientX: s.x(0.3) });
    expect(s.input).toHaveBeenLastCalledWith(0.3);
    s.fire('pointerup', { pointerId: 8 });
    expect(s.change).not.toHaveBeenCalled();
    s.fire('pointerup', { pointerId: 7 });
    expect(s.change).toHaveBeenCalledWith(0.3);
  });

  it('a mouse press on the track jumps at once', () => {
    const s = fake();
    s.fire('pointerdown', { pointerType: 'mouse', clientX: s.x(0.2) });
    expect(s.input).toHaveBeenCalledWith(0.2);
    expect(s.el.focus).toHaveBeenCalled();
    s.fire('pointerup', { pointerType: 'mouse' });
    expect(s.change).toHaveBeenCalledWith(0.2);
    // Not the right button.
    s.fire('pointerdown', { pointerType: 'mouse', button: 2, clientX: s.x(0.9) });
    expect(s.h.value).toBe(0.2);
  });

  it('a touch on the track waits: a vertical swipe (the screen scrolls, the pointer is cancelled) changes nothing', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.2), clientY: 10 });
    s.fire('pointermove', { clientX: s.x(0.2) + 2, clientY: 40 });
    expect(s.input).not.toHaveBeenCalled();
    s.fire('pointercancel');
    s.fire('click', { clientX: s.x(0.2) }); // none comes after a scroll, but even so
    expect(s.input).not.toHaveBeenCalled();
    expect(s.change).not.toHaveBeenCalled();
    expect(s.h.value).toBe(0.5);
  });

  it('a touch on the track: a tap jumps on the native click (none comes for a fling stop), a sideways move drags', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.2) });
    s.fire('pointerup', { clientX: s.x(0.2) });
    expect(s.input).not.toHaveBeenCalled(); // a fling stop ends here: Chrome sends no click
    s.fire('click', { clientX: s.x(0.2) });
    expect(s.change).toHaveBeenCalledWith(0.2);
    s.fire('click', { clientX: s.x(0.9) }); // a stray click later does nothing
    expect(s.h.value).toBe(0.2);

    s.fire('pointerdown', { clientX: s.x(0.8) - 5 });
    s.fire('pointermove', { clientX: s.x(0.8) - 2 });
    expect(s.h.value).toBe(0.2);
    s.fire('pointermove', { clientX: s.x(0.8) });
    expect(s.h.value).toBe(0.8);
    s.fire('pointerup');
    expect(s.change).toHaveBeenLastCalledWith(0.8);
  });

  it('a vertical swipe that starts on the thumb scrolls: the value neither changes nor saves', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.5) + 3, clientY: 15 });
    // Mostly down, drifting sideways as a thumb does.
    s.fire('pointermove', { clientX: s.x(0.5) + 6, clientY: 25 });
    s.fire('pointermove', { clientX: s.x(0.5) + 30, clientY: 80 });
    expect(s.input).not.toHaveBeenCalled();
    expect(s.cls.has('dragging')).toBe(false);
    // Whether the browser cancels the pointer (it scrolled) or not (nothing to scroll), nothing is saved.
    s.fire('pointerup', { clientX: s.x(0.5) + 30 });
    s.fire('click', { clientX: s.x(0.5) + 30 });
    expect(s.input).not.toHaveBeenCalled();
    expect(s.change).not.toHaveBeenCalled();
    expect(s.h.value).toBe(0.5);
  });

  it('a tap on the thumb (a fling stop) never nudges it', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.5) + 10 });
    s.fire('pointerup', { clientX: s.x(0.5) + 10 });
    s.fire('click', { clientX: s.x(0.5) + 10 });
    expect(s.input).not.toHaveBeenCalled();
    expect(s.change).not.toHaveBeenCalled();
    expect(s.h.value).toBe(0.5);
    // A mouse still grabs the thumb at once.
    s.fire('pointerdown', { pointerType: 'mouse', clientX: s.x(0.5) + 4 });
    expect(s.cls.has('dragging')).toBe(true);
    s.fire('pointermove', { pointerType: 'mouse', clientX: s.x(0.7) + 4 });
    expect(s.h.value).toBe(0.7);
  });

  it('touchIntent: a drag only when the move is mostly sideways', () => {
    expect(touchIntent(3, 2)).toBe('wait');
    expect(touchIntent(4, 4)).toBe('drag');
    expect(touchIntent(-6, 1)).toBe('drag');
    expect(touchIntent(5, 9)).toBe('scroll');
    expect(touchIntent(1, -4)).toBe('scroll');
  });

  it('a cancelled drag goes back to where it started and saves nothing', () => {
    const s = fake();
    s.fire('pointerdown', { clientX: s.x(0.5) });
    s.fire('pointermove', { clientX: s.x(0.9) });
    expect(s.h.value).toBe(0.9);
    s.fire('pointercancel');
    expect(s.h.value).toBe(0.5);
    expect(s.input).toHaveBeenLastCalledWith(0.5);
    expect(s.change).not.toHaveBeenCalled();
  });

  it('keys step it and save; other keys pass', () => {
    const s = fake();
    const e = s.fire('keydown', { key: 'ArrowRight' });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(s.change).toHaveBeenLastCalledWith(0.55);
    s.fire('keydown', { key: 'Home' });
    expect(s.change).toHaveBeenLastCalledWith(0);
    s.fire('keydown', { key: 'ArrowLeft' }); // already at the end: nothing to save
    expect(s.change).toHaveBeenCalledTimes(2);
    expect(s.fire('keydown', { key: 'Tab' }).preventDefault).not.toHaveBeenCalled();
  });

  it('set() shows a value from outside without reporting it', () => {
    const s = fake();
    s.h.set(0.73);
    expect(s.h.value).toBe(0.75);
    expect(s.style.get('--p')).toBe('0.7500');
    expect(s.input).not.toHaveBeenCalled();
    expect(s.change).not.toHaveBeenCalled();
  });
});
