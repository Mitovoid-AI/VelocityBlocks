// App.setMode must exit the current mode BEFORE building the next one (bug: "Next track" started
// with no HUD or touch controls because the old RaceMode's exit() ran after the new one showed
// them). App itself needs the DOM and WebGL, so the method is called with a stand-in `this`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type Mode } from '../src/app/app';
import { toast } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  toast: vi.fn(),
}));

afterEach(() => vi.mocked(toast).mockClear());

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

// A race start may wait for an interstitial and for the realistic model to load. It must not start twice
// from a double tap, nor from a screen the player has left meanwhile (Android Back), and it must start
// with the classic vehicle when the model cannot be loaded.
describe('App.playRace', () => {
  type Fake = {
    ads: { busy: boolean; interstitial: () => Promise<void> };
    audio: { unlock: () => void };
    mode: Mode | null;
    store: { profile: { models: Record<string, string> } };
    startRace: ReturnType<typeof vi.fn>;
    waitForModel: (v: string) => Promise<boolean>;
    blockLocked: () => boolean;
    blockChained: () => boolean;
  };
  const entry = { vehicle: 'car' } as never;
  let screen: object = {};

  function fake(wait: () => Promise<boolean>): Fake {
    vi.stubGlobal('document', { querySelector: () => screen });
    return {
      ads: { busy: false, interstitial: () => Promise.resolve() },
      audio: { unlock() {} },
      mode: noop,
      store: { profile: { models: { car: 'sport' } } },
      startRace: vi.fn(),
      waitForModel: wait,
      blockLocked: () => false,
      blockChained: () => false,
    };
  }
  const play = (f: Fake) => App.prototype.playRace.call(f as unknown as App, entry);

  it('starts once the model is ready, and ignores a second tap meanwhile', async () => {
    let done!: () => void;
    const f = fake(() => new Promise<boolean>((r) => (done = () => r(true))));
    const first = play(f);
    const second = play(f);
    done();
    await Promise.all([first, second]);
    expect(f.startRace).toHaveBeenCalledTimes(1);
    // And the next tap starts again.
    f.waitForModel = () => Promise.resolve(true);
    await play(f);
    expect(f.startRace).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('starts nothing when the player went back while it loaded', async () => {
    let done!: () => void;
    const f = fake(() => new Promise<boolean>((r) => (done = () => r(true))));
    const p = play(f);
    // Back: the previous menu replaced the screen.
    screen = {};
    done();
    await p;
    expect(f.startRace).not.toHaveBeenCalled();
    // And a new tap works again (the model is ready now).
    f.waitForModel = () => Promise.resolve(true);
    await play(f);
    expect(f.startRace).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('after Back during "Loading vehicle...", a start from the new screen is not blocked, and the stale one ends quietly', async () => {
    let fail!: () => void;
    const f = fake(() => new Promise<boolean>((r) => (fail = () => r(false))));
    const stale = play(f);
    screen = {}; // Back to the menu while the model loads
    f.waitForModel = () => Promise.resolve(true);
    await play(f);
    expect(f.startRace).toHaveBeenCalledTimes(1);
    // The old load gives up later: no race from the screen that was left, and no "could not be loaded" toast.
    fail();
    await stale;
    expect(f.startRace).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('says the model could not be loaded only for a start still on screen, and races the classic one', async () => {
    const f = fake(() => Promise.resolve(false));
    await play(f);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'), 3000);
    expect(f.startRace).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('starts nothing when the mode changed while it loaded', async () => {
    let done!: () => void;
    const f = fake(() => new Promise<boolean>((r) => (done = () => r(true))));
    const p = play(f);
    f.mode = { update() {}, exit() {} };
    done();
    await p;
    expect(f.startRace).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('realistic model loading', () => {
  it('resolves "not ready" when a model cannot be loaded, so the race goes ahead with the classic vehicle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = await import('../src/render/modelCache');
    // No renderer yet: nothing loads.
    expect(await cache.ensureModel('coupe', 50)).toBe(false);
    // A renderer the KTX2 loader cannot use (as a decode failure or a missing file would): the load fails.
    cache.setModelRenderer({} as never);
    expect(await cache.ensureModel('coupe', 5000)).toBe(false);
    expect(cache.readyModel('coupe')).toBeNull();
    // Not retried in this session.
    expect(await cache.loadModel('coupe')).toBeNull();
    warn.mockRestore();
  });
});
