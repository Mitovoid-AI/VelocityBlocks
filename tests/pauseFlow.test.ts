// The pause wiring: RaceMode.back applies the Back rules, the pause menu says why it paused,
// App.back never lets an error minimise a race, and the controller's Start button can resume.
// RaceMode and App need the DOM and WebGL, so their methods run on stand-ins.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/app';
import { SWALLOW_HINT } from '../src/app/pauseGuard';
import { RaceMode } from '../src/app/raceMode';
import { lineJobs } from '../src/game/racingLine';
import { Input, type Action, type ActionSource } from '../src/input/input';
import type { SysCancel } from '../src/input/touchWatch';
import { showScreen } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  showScreen: vi.fn(),
  clearScreen: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showScreen).mockClear();
});

type RaceProto = {
  back(cancels: readonly SysCancel[], now: number): boolean;
  setPaused(p: boolean, reason?: string, detail?: unknown): void;
  onAction(a: Action, src?: ActionSource): void;
};
const proto = RaceMode.prototype as unknown as RaceProto;

/** The RaceMode fields back() and setPaused() use, with the App parts stubbed. */
function race(over: Record<string, unknown> = {}) {
  const app = {
    hud: { message: vi.fn(), show: vi.fn() },
    audio: { silence: vi.fn() },
    showTouch: vi.fn(),
    input: { clearNitroPress: vi.fn() },
    store: { settings: { showGhost: true } },
    device: { sdk: 34, release: '14', maker: 'Xiaomi', model: 'Redmi Note 12', nav: 'gesture' },
    gestureInsets: { l: 24, r: 24, t: 24, b: 16 },
    touches: { bursts: 3 },
    longFrames: 7,
  };
  const r = {
    app,
    entry: { fromEditor: false },
    resultsShown: false,
    paused: false,
    phaseSince: 0,
    lastBackAt: -Infinity,
    swallowedBacks: 0,
    flipRespawns: 0,
    framesAtStart: 2,
    cancelsAtStart: 1,
    ghostLabel: () => 'Ghost: on',
    medalGhostLabel: () => 'Target ghost: on',
    chaseLabel: () => 'Chase: Auto (Gold)',
    lineLabel: (RaceMode.prototype as unknown as { lineLabel(): string }).lineLabel,
    diagText: (RaceMode.prototype as unknown as { diagText(): string }).diagText,
    setPaused: vi.fn(),
    ...over,
  };
  return r;
}
const back = (r: ReturnType<typeof race>, cancels: SysCancel[], now: number) => proto.back.call(r, cancels, now);

describe('RaceMode.back', () => {
  it('pauses a race on a Back with no swipe behind it', () => {
    const r = race({ phaseSince: 1000 });
    expect(back(r, [], 5000)).toBe(true);
    expect(r.setPaused).toHaveBeenCalledWith(true, 'back');
  });

  it('swallows the Back of a back swipe made over the controls, with a hint, once', () => {
    const r = race({ phaseSince: 1000 });
    const swipe = [{ downAt: 2000, at: 3000 }];
    expect(back(r, swipe, 4500)).toBe(true);
    expect(r.setPaused).not.toHaveBeenCalled();
    expect(r.app.hud.message).toHaveBeenCalledWith(SWALLOW_HINT, expect.any(Number));
    expect(r.swallowedBacks).toBe(1);
    // The token is spent: a deliberate Back right after pauses.
    expect(back(r, swipe, 5000)).toBe(true);
    expect(r.setPaused).toHaveBeenCalledWith(true, 'back');
  });

  it('resumes a paused race', () => {
    const r = race({ paused: true, phaseSince: 1000 });
    expect(back(r, [], 5000)).toBe(true);
    expect(r.setPaused).toHaveBeenCalledWith(false);
  });

  it('keeps the pause menu when the thumb held through the pause made the swipe', () => {
    const r = race({ paused: true, phaseSince: 1000 });
    expect(back(r, [{ downAt: 500, at: 2000 }], 3000)).toBe(true);
    expect(r.setPaused).not.toHaveBeenCalled();
    expect(r.app.hud.message).not.toHaveBeenCalled(); // the HUD is under the menu
  });

  it("leaves the results screen to its Menu button, unless a race touch was taken", () => {
    expect(back(race({ resultsShown: true, phaseSince: 1000 }), [], 3000)).toBe(false);
    const r = race({ resultsShown: true, phaseSince: 1000 });
    expect(back(r, [{ downAt: 200, at: 900 }], 3000)).toBe(true);
    expect(r.setPaused).not.toHaveBeenCalled();
  });
});

describe('RaceMode pause actions', () => {
  it.each([
    ['key', 'key'],
    ['gamepad', 'gamepad'],
    ['touch', 'button'],
    [undefined, 'button'],
  ] as const)('pause from %s is shown as %s', (src, reason) => {
    const r = race();
    proto.onAction.call(r, 'pause', src);
    expect(r.setPaused).toHaveBeenCalledWith(true, reason);
  });

  it('the pause menu says why it paused and shows the diagnostics line', () => {
    const r = race({ setPaused: proto.setPaused });
    proto.setPaused.call(r, true, 'focus', { ms: 512, resumed: true, multiWindow: false });
    expect(r.paused).toBe(true);
    expect(r.app.showTouch).toHaveBeenCalledWith(false);
    const html = vi.mocked(showScreen).mock.calls[0][0];
    expect(html).toContain('Paused: app lost focus (a panel or pop-up covered it)');
    expect(html).toContain('Xiaomi Redmi Note 12 · Android 14 · gesture nav · edges 24/24/16');
    expect(html).toContain('cancelled touches: 2');
    expect(html).toContain('long frames: 5');
  });

  it('the pause menu has the racing line toggle: off, on, or n/a for a track with no line', () => {
    const r = race({ setPaused: proto.setPaused, entry: { fromEditor: false, key: 'c:A01|w', base: 'c:A01', vehicle: 'car', walls: true } });
    proto.setPaused.call(r, true);
    expect(vi.mocked(showScreen).mock.calls[0][0]).toContain('data-act="line">Racing line: off<');
    const label = (RaceMode.prototype as unknown as { lineLabel(this: unknown): string }).lineLabel;
    (r.app.store.settings as Record<string, unknown>).racingLine = true;
    // Campaign lines are precomputed, so A01 has one; a custom key nobody has worked out is not known yet.
    expect(label.call(r)).toBe('Racing line: on');
    const peek = vi.spyOn(lineJobs, 'peek').mockReturnValue(null);
    expect(label.call(r)).toBe('Racing line: n/a');
    // Lines are open-road lines: a walls-on run asks for the plain key's line.
    expect(peek).toHaveBeenCalledWith('c:A01');
  });

  it('starts a new stretch for the Back rules on pause and resume', () => {
    const r = race({ setPaused: proto.setPaused, phaseSince: 1 });
    proto.setPaused.call(r, true);
    const pausedAt = r.phaseSince;
    expect(pausedAt).toBeGreaterThan(1);
    proto.setPaused.call(r, false);
    expect(r.paused).toBe(false);
    expect(r.phaseSince).toBeGreaterThanOrEqual(pausedAt);
  });
});

describe('App.back', () => {
  type Shell = { mode: unknown; touches: { recent(): readonly SysCancel[] } };
  const appBack = (fake: Shell) => App.prototype.back.call(fake as unknown as App);

  it('hands a race the touches the system took', () => {
    const cancels = [{ downAt: 1, at: 2 }];
    const mode = Object.create(RaceMode.prototype) as RaceProto;
    mode.back = vi.fn(() => true);
    expect(appBack({ mode, touches: { recent: () => cancels } })).toBe(true);
    expect(mode.back).toHaveBeenCalledWith(cancels, expect.any(Number));
  });

  it('never turns a failing Back into "minimise the app" during a race', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mode = Object.create(RaceMode.prototype) as RaceProto;
    mode.back = () => {
      throw new Error('boom');
    };
    expect(appBack({ mode, touches: { recent: () => [] } })).toBe(true);
    expect(err).toHaveBeenCalled();
  });

  it("presses the screen's own way out elsewhere", () => {
    const click = vi.fn();
    vi.stubGlobal('document', { querySelector: () => ({ click }) });
    expect(appBack({ mode: null, touches: { recent: () => [] } })).toBe(true);
    expect(click).toHaveBeenCalled();
    vi.stubGlobal('document', { querySelector: () => null });
    expect(appBack({ mode: null, touches: { recent: () => [] } })).toBe(false);
  });
});

describe('Input action sources', () => {
  function input() {
    const on = new Map<string, (e: unknown) => void>();
    vi.stubGlobal('window', { addEventListener: (t: string, fn: (e: unknown) => void) => on.set(t, fn) });
    const pad = { connected: true, axes: [0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    const inp = new Input();
    const got: [Action, ActionSource][] = [];
    inp.onAction((a, src) => got.push([a, src]));
    return { inp, on, pad, got };
  }

  it('Esc pauses from the keyboard', () => {
    const { on, got } = input();
    on.get('keydown')!({ code: 'Escape', target: { tagName: 'BODY', isContentEditable: false }, preventDefault() {} });
    expect(got).toEqual([['pause', 'key']]);
  });

  it("the controller's Start is polled while paused, once per press", () => {
    const { inp, pad, got } = input();
    pad.buttons[9].pressed = true;
    inp.pollPad();
    inp.pollPad(); // still held
    pad.buttons[9].pressed = false;
    inp.pollPad();
    pad.buttons[9].pressed = true;
    inp.pollPad();
    expect(got).toEqual([
      ['pause', 'gamepad'],
      ['pause', 'gamepad'],
    ]);
  });
});
