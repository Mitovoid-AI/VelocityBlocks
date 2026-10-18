// App.setMode must exit the current mode BEFORE building the next one (bug: "Next track" started
// with no HUD or touch controls because the old RaceMode's exit() ran after the new one showed
// them). App itself needs the DOM and WebGL, so the method is called with a stand-in `this`.

import { describe, expect, it, vi } from 'vitest';
import { App, type Mode } from '../src/app/app';

type Holder = { mode: Mode | null };
const noop: Mode = { update() {}, exit() {} };
const setMode = (fake: Holder, make: () => Mode) => App.prototype.setMode.call(fake as unknown as App, make);

describe('App.setMode', () => {
  it('exits the current mode before building the next one', () => {
    const log: string[] = [];
    const fake: Holder = { mode: { update() {}, exit: () => void log.push('exit') } };
    setMode(fake, () => {
      log.push(fake.mode === null ? 'build(mode=null)' : 'build(mode=set)');
      return noop;
    });
    expect(log).toEqual(['exit', 'build(mode=null)']);
    expect(fake.mode).toBe(noop);
  });

  it('routes nothing to the old mode while it exits', () => {
    let seen: Mode | null | undefined;
    const fake: Holder = { mode: { update() {}, exit: () => void (seen = fake.mode) } };
    setMode(fake, () => noop);
    expect(seen).toBeNull();
  });

  it('still builds the next mode when exit() throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake: Holder = {
      mode: {
        update() {},
        exit() {
          throw new Error('boom');
        },
      },
    };
    setMode(fake, () => noop);
    expect(fake.mode).toBe(noop);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('works on first launch with no current mode', () => {
    const fake: Holder = { mode: null };
    const make = vi.fn(() => noop);
    setMode(fake, make);
    expect(make).toHaveBeenCalledTimes(1);
    expect(fake.mode).toBe(noop);
  });

  it('exits each mode exactly once across a chain of switches', () => {
    const exits: string[] = [];
    const named = (n: string): Mode => ({ update() {}, exit: () => void exits.push(n) });
    const fake: Holder = { mode: null };
    setMode(fake, () => named('race1'));
    setMode(fake, () => named('race2')); // "Next track": a RaceMode replacing a RaceMode
    setMode(fake, () => named('menu'));
    expect(exits).toEqual(['race1', 'race2']);
  });
});
