// TouchWatch: which race touches the system took away (the signal behind the Back swallow rule).

import { describe, expect, it } from 'vitest';
import { TouchWatch } from '../src/input/touchWatch';

type Handler = (e: unknown) => void;

function watch(armed = true) {
  const on = new Map<string, { fn: Handler; capture: unknown }>();
  const target = { addEventListener: (t: string, fn: Handler, capture?: unknown) => void on.set(t, { fn, capture }) };
  const clock = { t: 1000 };
  const state = { armed };
  const w = new TouchWatch(() => state.armed, target as unknown as Pick<Window, 'addEventListener'>, () => clock.t);
  const fire = (type: string, pointerId: number, pointerType = 'touch') => on.get(type)!.fn({ pointerId, pointerType });
  return { w, on, clock, state, fire };
}

describe('TouchWatch', () => {
  it('records a race touch the system cancelled', () => {
    const { w, clock, fire } = watch();
    fire('pointerdown', 1);
    clock.t = 3000;
    fire('pointercancel', 1);
    expect(w.recent()).toEqual([{ downAt: 1000, at: 3000 }]);
    expect(w.bursts).toBe(1);
  });

  it('ignores touches that lift normally', () => {
    const { w, fire } = watch();
    fire('pointerdown', 1);
    fire('pointerup', 1);
    fire('pointercancel', 1);
    expect(w.recent()).toEqual([]);
    expect(w.bursts).toBe(0);
  });

  it('ignores the mouse and touches that started outside a race', () => {
    const { w, state, fire } = watch(false);
    fire('pointerdown', 1); // in a menu: may be cancelled to scroll
    state.armed = true;
    fire('pointercancel', 1);
    fire('pointerdown', 2, 'mouse');
    fire('pointercancel', 2, 'mouse');
    expect(w.recent()).toEqual([]);
  });

  it('counts cancels within 50 ms as one gesture', () => {
    const { w, clock, fire } = watch();
    fire('pointerdown', 1);
    fire('pointerdown', 2);
    clock.t = 2000;
    fire('pointercancel', 1);
    clock.t = 2010;
    fire('pointercancel', 2);
    expect(w.recent()).toHaveLength(2);
    expect(w.bursts).toBe(1);
    fire('pointerdown', 3);
    clock.t = 4000;
    fire('pointercancel', 3);
    expect(w.bursts).toBe(2);
  });

  it('forgets cancels after 15 s', () => {
    const { w, clock, fire } = watch();
    fire('pointerdown', 1);
    fire('pointercancel', 1);
    clock.t += 15_001;
    expect(w.recent()).toEqual([]);
    expect(w.bursts).toBe(1);
  });

  it('listens in the capture phase, ahead of the controls', () => {
    const { on } = watch();
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) expect(on.get(t)!.capture).toBe(true);
  });
});
