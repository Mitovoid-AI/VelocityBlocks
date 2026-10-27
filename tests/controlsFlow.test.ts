// The controls wiring: App.setSteerMode / applyControls / showControlsTip, the pause menu's
// Steering and Recentre tilt rows, the tilt recentre at GO, Profile > Controls and the Tilt
// steering screen, the analog steering assist, and the nitro's feedback in a race. App, RaceMode
// and the profile editor need the DOM and WebGL, so their methods run on stand-ins.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, CONTROLS_TIP } from '../src/app/app';
import { showProfileScreen } from '../src/app/profileScreen';
import { analogSteerFor, RaceMode, RECENTRE_SETTLE_MS } from '../src/app/raceMode';
import { showTiltScreen } from '../src/app/tiltScreen';
import { DEFAULT_SETTINGS, migrateProfile, type Settings, type SteerMode } from '../src/game/storage';
import { Input } from '../src/input/input';
import { showScreen, toast } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  showScreen: vi.fn(),
  clearScreen: vi.fn(),
  toast: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showScreen).mockClear();
  vi.mocked(toast).mockClear();
});

const touchScreen = () => vi.stubGlobal('window', { ontouchstart: null });

function shell(over: Partial<Settings> = {}, tiltOk = true) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...over };
  return {
    store: { settings, saveSettings: vi.fn() },
    input: {
      requestTilt: vi.fn(async () => tiltOk),
      setTilt: vi.fn(),
      recentreTilt: vi.fn(() => 4),
      autoAccelerate: false,
      tiltSensitivity: 0,
      tiltCenter: 0,
    },
    touchCtl: { setLayout: vi.fn() },
    syncEdgeGuard: vi.fn(),
    applyControls: vi.fn(),
    applyTiltTuning(this: unknown) {
      App.prototype.applyTiltTuning.call(this as App);
    },
  };
}
type Shell = ReturnType<typeof shell>;
const call = <K extends 'setSteerMode' | 'applyControls' | 'showControlsTip'>(k: K, app: Shell, ...a: Parameters<App[K]>) =>
  (App.prototype[k] as (...x: unknown[]) => ReturnType<App[K]>).call(app, ...a);

describe('App.setSteerMode', () => {
  it('saves and applies buttons or wheel at once', async () => {
    const app = shell();
    expect(await call('setSteerMode', app, 'wheel')).toBe(true);
    expect(app.store.settings.steerMode).toBe('wheel');
    expect(app.store.saveSettings).toHaveBeenCalled();
    expect(app.applyControls).toHaveBeenCalled();
    expect(app.input.requestTilt).not.toHaveBeenCalled();
  });

  it('keeps tilt only when the sensor answers', async () => {
    const ok = shell();
    expect(await call('setSteerMode', ok, 'tilt')).toBe(true);
    expect(ok.store.settings.steerMode).toBe('tilt');

    const no = shell({ steerMode: 'wheel' }, false);
    expect(await call('setSteerMode', no, 'tilt')).toBe(false);
    expect(no.store.settings.steerMode).toBe('wheel');
    expect(no.store.saveSettings).not.toHaveBeenCalled();
    expect(no.applyControls).toHaveBeenCalled(); // tilt listening goes back off
    expect(toast).toHaveBeenCalled();
  });
});

describe('App.setSteerMode overtaken', () => {
  it('Wheel picked while the tilt check waits: Wheel stands, and no false "no motion sensor" toast', async () => {
    const app = shell({ steerMode: 'buttons' });
    let answer!: (ok: boolean) => void;
    app.input.requestTilt = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const tilt = call('setSteerMode', app, 'tilt');
    expect(await call('setSteerMode', app, 'wheel')).toBe(true);
    // Input.setTilt(false) (from applyControls) ends the pending check with false.
    answer(false);
    expect(await tilt).toBe(false);
    expect(app.store.settings.steerMode).toBe('wheel');
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('App.applyControls', () => {
  it('hands the settings to Input and the touch layout, camera untouched', () => {
    const app = shell({ steerMode: 'tilt', pedals: 'buttons', autoAccelerate: true, tiltSensitivity: 0.75, tiltCenter: -6 });
    call('applyControls', app);
    expect(app.input).toMatchObject({ autoAccelerate: true, tiltSensitivity: 0.75, tiltCenter: -6 });
    expect(app.input.setTilt).toHaveBeenCalledWith(true);
    expect(app.touchCtl.setLayout).toHaveBeenCalledWith({ steer: 'tilt', pedals: 'buttons', autoGas: true });
    expect(app.syncEdgeGuard).toHaveBeenCalled();

    const off = shell({ steerMode: 'wheel' });
    call('applyControls', off);
    expect(off.input.setTilt).toHaveBeenCalledWith(false);
  });

  it('hands the tilt tuning to Input too', () => {
    const app = shell({ steerMode: 'tilt', tiltDeadzone: 3, tiltCurve: 0.4, tiltSmoothing: 0.8, tiltSensitivity: 0.25 });
    call('applyControls', app);
    expect(app.input).toMatchObject({ tiltDeadzone: 3, tiltCurve: 0.4, tiltSmoothing: 0.8, tiltSensitivity: 0.25 });
  });
});

describe('analog steering assist', () => {
  const s = (steerMode: SteerMode, analogSteer = true) => ({ steerMode, analogSteer });
  it('is for wheel and live tilt runs on a touchscreen, with the setting on', () => {
    expect(analogSteerFor(s('wheel'), true, false)).toBe(true);
    expect(analogSteerFor(s('tilt'), true, true)).toBe(true);
    // Tilt fell back to the buttons (no sensor reading): the buttons' rack.
    expect(analogSteerFor(s('tilt'), true, false)).toBe(false);
    expect(analogSteerFor(s('buttons'), true, true)).toBe(false);
    // Keyboard and controller players, or the setting off.
    expect(analogSteerFor(s('wheel'), false, true)).toBe(false);
    expect(analogSteerFor(s('wheel', false), true, true)).toBe(false);
  });
});

describe('App.showControlsTip', () => {
  it('shows once, on touchscreens only', () => {
    const desk = shell();
    call('showControlsTip', desk);
    expect(toast).not.toHaveBeenCalled();
    expect(desk.store.settings.controlsTipShown).toBe(false);

    touchScreen();
    const app = shell();
    call('showControlsTip', app);
    call('showControlsTip', app);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(CONTROLS_TIP, expect.any(Number));
    expect(app.store.settings.controlsTipShown).toBe(true);
    expect(app.store.saveSettings).toHaveBeenCalled();
  });
});

type RaceProto = {
  setPaused(p: boolean, reason?: string): void;
  cycleSteering(el: { textContent: string }): Promise<void>;
  handle(events: unknown[]): void;
  onAction(a: string, src?: string): void;
};
const proto = RaceMode.prototype as unknown as RaceProto;

/** The RaceMode fields the pause menu uses, over a stand-in App whose setSteerMode follows App's rules. */
function race(steerMode: SteerMode, tiltOk = true) {
  const settings: Settings = { ...DEFAULT_SETTINGS, steerMode };
  const app = {
    store: { settings, saveSettings: vi.fn() },
    hud: { message: vi.fn(), show: vi.fn(), countdown: vi.fn(), nitroDeny: vi.fn(), nitroPop: vi.fn() },
    audio: { silence: vi.fn(), countdown: vi.fn(), deny: vi.fn(), nitro: vi.fn(), nitroReady: vi.fn() },
    rig: { shake: 0 },
    input: { recentreTilt: vi.fn((): number | null => 3), clearNitroPress: vi.fn() },
    showTouch: vi.fn(),
    setSteerMode: vi.fn(async (m: SteerMode) => {
      if (m === 'tilt' && !tiltOk) return false;
      settings.steerMode = m;
      return true;
    }),
    device: null,
    gestureInsets: null,
    touches: { bursts: 0 },
    longFrames: 0,
  };
  return {
    app,
    entry: { fromEditor: false },
    race: { phase: 'racing', car: { nitroTime: 0, nitroCooldown: 0 } },
    alive: true,
    nitroArmed: false,
    resultsShown: false,
    paused: false,
    phaseSince: 0,
    steerBusy: false,
    swallowedBacks: 0,
    flipRespawns: 0,
    framesAtStart: 0,
    cancelsAtStart: 0,
    ghostLabel: () => 'Ghost: on',
    medalGhostLabel: () => 'Target ghost: on',
    chaseLabel: () => 'Chase: Auto (Gold)',
    lineLabel: () => 'Racing line: off',
    steerLabel: (RaceMode.prototype as unknown as { steerLabel(): string }).steerLabel,
    diagText: () => '',
    recentreTilt: (RaceMode.prototype as unknown as { recentreTilt(el: unknown): void }).recentreTilt,
    nitroPressed: (RaceMode.prototype as unknown as { nitroPressed(): void }).nitroPressed,
  };
}

describe('pause menu Steering row', () => {
  it('is there on touchscreens only', () => {
    touchScreen();
    proto.setPaused.call(race('wheel'), true);
    expect(vi.mocked(showScreen).mock.calls[0][0]).toContain('Steering: Wheel');
    expect(vi.mocked(showScreen).mock.calls[0][2]).toHaveProperty('steer');
    vi.unstubAllGlobals();
    proto.setPaused.call(race('wheel'), true);
    expect(vi.mocked(showScreen).mock.calls[1][0]).not.toContain('Steering');
  });

  it('cycles Buttons, Wheel, Tilt and back', async () => {
    const r = race('buttons');
    const el = { textContent: '' };
    await proto.cycleSteering.call(r, el);
    expect(el.textContent).toBe('Steering: Wheel');
    await proto.cycleSteering.call(r, el);
    expect(el.textContent).toBe('Steering: Tilt');
    await proto.cycleSteering.call(r, el);
    expect(el.textContent).toBe('Steering: Buttons');
  });

  it('passes over tilt when its sensor does not answer', async () => {
    const r = { ...race('wheel', false), paused: true };
    const el = { textContent: '' };
    await proto.cycleSteering.call(r, el);
    expect(r.app.setSteerMode.mock.calls.map((c) => c[0])).toEqual(['tilt', 'buttons']);
    expect(el.textContent).toBe('Steering: Buttons');
  });

  it('leaves the layout alone when the race was resumed during the tilt check', async () => {
    // The probe waits up to 1.5 s; a player who taps Resume meanwhile is driving with the wheel.
    const r = { ...race('wheel', false), paused: true };
    r.app.setSteerMode.mockImplementationOnce(async () => {
      r.paused = false;
      return false;
    });
    await proto.cycleSteering.call(r, { textContent: '' });
    expect(r.app.setSteerMode.mock.calls.map((c) => c[0])).toEqual(['tilt']);
    expect(r.app.store.settings.steerMode).toBe('wheel');
  });
});

describe('tilt recentre at GO', () => {
  it('takes the way the device is held at the start as straight ahead, with tilt only', () => {
    const tilt = race('tilt');
    proto.handle.call(tilt, [{ type: 'go' }]);
    expect(tilt.app.input.recentreTilt).toHaveBeenCalledTimes(1);
    const wheel = race('wheel');
    proto.handle.call(wheel, [{ type: 'go' }]);
    expect(wheel.app.input.recentreTilt).not.toHaveBeenCalled();
  });

  it('keeps the centre saved with the Controls tab Recentre', () => {
    const saved = race('tilt');
    saved.app.store.settings.tiltCenterSet = true;
    proto.handle.call(saved, [{ type: 'go' }]);
    expect(saved.app.input.recentreTilt).not.toHaveBeenCalled();
  });
});

/** A screen stand-in: no elements, so the sliders and the gauge bind nothing (and start no frame loop). */
const screenEl = () => ({ querySelector: () => null, querySelectorAll: () => [], contains: () => false });

/** A stand-in App for the profile editor and the Tilt screen. */
function profileApp(reading: number | null, over: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, steerMode: 'tilt', ...over };
  return {
    settings,
    store: { settings, profile: migrateProfile(null, {}), profilePhoto: () => null, saveSettings: vi.fn(), saveProfile: vi.fn() },
    input: { recentreTilt: vi.fn(() => reading), tiltAngle: vi.fn(() => reading) },
    setGarageView: vi.fn(),
    applyTiltTuning: vi.fn(),
    profileScreen: vi.fn(),
  };
}

describe('Profile > Controls tilt row', () => {
  /** The profile editor over a stand-in App; returns its markup and data-act handlers (showScreen is mocked). */
  function editor(reading: number | null, over: Partial<Settings> = {}) {
    touchScreen();
    vi.mocked(showScreen).mockReturnValueOnce(screenEl() as unknown as HTMLElement);
    vi.stubGlobal('document', { activeElement: null });
    const app = profileApp(reading, over);
    const back = vi.fn();
    showProfileScreen(app as unknown as App, 'edit', back);
    const [html, , handlers] = vi.mocked(showScreen).mock.calls[0];
    return { app, html, handlers, back };
  }
  const el = {} as HTMLElement;

  it('is one row: the sensitivity slider, its value and More... (no steppers)', () => {
    const { html, handlers } = editor(3, { tiltSensitivity: 0.5125 });
    expect(html).toContain('data-tilt="sens"');
    expect(html).toContain('aria-valuenow="0.5125"');
    expect(html).toContain('data-tilt-val="sens">5.1<');
    expect(html).toContain('data-act="tilt-more"');
    expect(html).not.toContain('data-act="sens"');
    expect(handlers).not.toHaveProperty('sens');
    // The analog steering switch (touchscreens).
    expect(html).toContain('data-k="analog"');
  });

  it('More... saves and opens the Tilt steering screen, whose Back comes back to the profile', () => {
    const { app, handlers, back } = editor(3);
    vi.mocked(showScreen).mockReturnValueOnce(screenEl() as unknown as HTMLElement);
    handlers['tilt-more'](el);
    expect(app.store.saveSettings).toHaveBeenCalled();
    const [html, , tilt] = vi.mocked(showScreen).mock.calls[1];
    expect(html).toContain('Tilt steering');
    for (const k of ['sens', 'dead', 'smooth', 'curve']) expect(html).toContain(`data-tilt="${k}"`);
    tilt.back(el);
    expect(app.profileScreen).toHaveBeenCalledWith('edit', back);
  });

  it('the analog steering switch saves the setting', () => {
    const { app, handlers } = editor(3);
    const sw = { dataset: { k: 'analog' }, getAttribute: () => 'true', setAttribute: vi.fn() };
    handlers.switch(sw as unknown as HTMLElement);
    expect(app.settings.analogSteer).toBe(false);
    expect(app.store.saveSettings).toHaveBeenCalled();
    expect(sw.setAttribute).toHaveBeenCalledWith('aria-checked', 'false');
  });

  it('leaving saves the settings (a drag cut short by Back has applied but not saved)', () => {
    const { app, handlers, back } = editor(3);
    handlers.back(el);
    expect(app.store.saveSettings).toHaveBeenCalled();
    expect(back).toHaveBeenCalled();
  });
});

describe('Tilt steering screen', () => {
  afterEach(() => vi.mocked(showScreen).mockReset());

  function screen(reading: number | null, over: Partial<Settings> = {}) {
    vi.mocked(showScreen).mockReturnValue(screenEl() as unknown as HTMLElement);
    const app = profileApp(reading, over);
    const back = vi.fn();
    showTiltScreen(app as unknown as App, back);
    const [html, cls, handlers] = vi.mocked(showScreen).mock.calls[0];
    return { app, html, cls, handlers, back };
  }
  const el = {} as HTMLElement;
  const sw = (k: string, on: boolean) => ({ dataset: { k }, getAttribute: () => String(on), setAttribute: vi.fn() }) as unknown as HTMLElement;

  it('has Back first (Android Back presses it), the gauge, four sliders and the switches', () => {
    const { html, cls, app, back, handlers } = screen(3);
    expect(html.indexOf('data-act="back"')).toBeLessThan(html.indexOf('data-act="reset"'));
    expect(html).toContain('data-tilt-gauge');
    expect(html).toMatch(/data-k="auto" role="switch" aria-checked="true"/);
    expect(cls).toContain('garage');
    expect(app.setGarageView).toHaveBeenCalledWith(true);
    handlers.back(el);
    expect(app.store.saveSettings).toHaveBeenCalled();
    expect(back).toHaveBeenCalled();
  });

  it('Reset puts the tuning back (auto-centre on), applies, saves and redraws', () => {
    const { app, handlers } = screen(3, { tiltDeadzone: 5, tiltCurve: 1, tiltSmoothing: 0, tiltSensitivity: 0.9, tiltCenterSet: true });
    handlers.reset(el);
    expect(app.settings).toMatchObject({ tiltDeadzone: 1.5, tiltCurve: 0, tiltSmoothing: 0.5, tiltSensitivity: 0.5, tiltCenterSet: false });
    expect(app.applyTiltTuning).toHaveBeenCalled();
    expect(app.store.saveSettings).toHaveBeenCalled();
    expect(vi.mocked(showScreen)).toHaveBeenCalledTimes(2);
  });

  it('Recentre saves straight ahead for every race; the auto-centre switch turns it back', () => {
    const { app, handlers } = screen(7.26);
    handlers.recentre(el);
    expect(app.settings).toMatchObject({ tiltCenter: 7.3, tiltCenterSet: true });
    handlers.switch(sw('auto', false));
    expect(app.settings.tiltCenterSet).toBe(false);
    // Off again: the way the device is held now is saved.
    handlers.switch(sw('auto', true));
    expect(app.settings.tiltCenterSet).toBe(true);
  });

  it('without a reading, Recentre saves nothing and says so', () => {
    const { app, handlers } = screen(null);
    handlers.recentre(el);
    expect(app.settings).toMatchObject({ tiltCenter: 0, tiltCenterSet: false });
    expect(toast).toHaveBeenCalled();
  });
});

describe('pause menu Recentre tilt', () => {
  afterEach(() => vi.useRealTimers());

  it('is there on touchscreens steering with tilt only', () => {
    touchScreen();
    proto.setPaused.call(race('tilt'), true);
    expect(vi.mocked(showScreen).mock.calls[0][0]).toContain('data-act="recentre">Recentre tilt<');
    expect(vi.mocked(showScreen).mock.calls[0][2]).toHaveProperty('recentre');
    proto.setPaused.call(race('wheel'), true);
    expect(vi.mocked(showScreen).mock.calls[1][0]).not.toContain('Recentre tilt');
    vi.unstubAllGlobals();
    proto.setPaused.call(race('tilt'), true);
    expect(vi.mocked(showScreen).mock.calls[2][0]).not.toContain('Recentre tilt');
  });

  /** Pause a tilt race (touch) and tap Recentre tilt; returns the race and the button. */
  function tap(over: Partial<Settings> = {}, reading: number | null = 3) {
    vi.useFakeTimers();
    touchScreen();
    const r = race('tilt');
    Object.assign(r.app.store.settings, over);
    r.app.input.recentreTilt.mockImplementation(() => reading);
    proto.setPaused.call(r, true);
    const btn = { textContent: '' };
    vi.mocked(showScreen).mock.calls[0][2].recentre(btn as unknown as HTMLElement);
    return { r, btn };
  }

  it('takes the roll a moment after the tap (the tap jolts the device), for this run with auto-centre', () => {
    const { r, btn } = tap();
    expect(btn.textContent).toMatch(/Hold steady/);
    expect(r.app.input.recentreTilt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECENTRE_SETTLE_MS);
    expect(r.app.input.recentreTilt).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe('Recentred');
    // Auto-centre: held for this run only (the next start takes its own at GO).
    expect(r.app.store.saveSettings).not.toHaveBeenCalled();
    expect(r.app.store.settings.tiltCenterSet).toBe(false);
  });

  it('saves the new centre when a centre is kept for every race', () => {
    const { r } = tap({ tiltCenterSet: true, tiltCenter: 9 }, 4.26);
    vi.advanceTimersByTime(RECENTRE_SETTLE_MS);
    expect(r.app.store.settings.tiltCenter).toBe(4.3);
    expect(r.app.store.saveSettings).toHaveBeenCalled();
  });

  it('says so without a reading, and does nothing if the race was resumed meanwhile', () => {
    const { btn } = tap({}, null);
    vi.advanceTimersByTime(RECENTRE_SETTLE_MS);
    expect(toast).toHaveBeenCalled();
    expect(btn.textContent).toBe('Recentre tilt');
    vi.mocked(showScreen).mockClear();
    const { r } = tap();
    r.paused = false;
    vi.advanceTimersByTime(RECENTRE_SETTLE_MS);
    expect(r.app.input.recentreTilt).not.toHaveBeenCalled();
  });
});

describe('nitro in a race (feedback; the press itself goes through Input.read)', () => {
  it('a press in the 3-2-1 arms the button; a press while recharging shakes it; one while boosting is quiet', () => {
    const r = race('buttons');
    r.race.phase = 'countdown';
    proto.onAction.call(r, 'nitro', 'touch');
    expect(r.nitroArmed).toBe(true);
    expect(r.app.hud.nitroDeny).not.toHaveBeenCalled();

    r.race.phase = 'racing';
    r.race.car = { nitroTime: 0, nitroCooldown: 4 };
    proto.onAction.call(r, 'nitro', 'key');
    expect(r.app.hud.nitroDeny).toHaveBeenCalledTimes(1);
    expect(r.app.audio.deny).toHaveBeenCalledTimes(1);

    r.race.car = { nitroTime: 1, nitroCooldown: 0 };
    proto.onAction.call(r, 'nitro', 'key');
    r.race.car = { nitroTime: 0, nitroCooldown: 0 };
    proto.onAction.call(r, 'nitro', 'key');
    expect(r.app.hud.nitroDeny).toHaveBeenCalledTimes(1);
  });

  it('is ignored while paused, on the results and after the finish', () => {
    const r = { ...race('buttons'), paused: true };
    r.race.car = { nitroTime: 0, nitroCooldown: 4 };
    proto.onAction.call(r, 'nitro');
    r.paused = false;
    r.resultsShown = true;
    proto.onAction.call(r, 'nitro');
    r.resultsShown = false;
    r.race.phase = 'finished';
    proto.onAction.call(r, 'nitro');
    expect(r.app.hud.nitroDeny).not.toHaveBeenCalled();
  });

  it('a press on the pause menu does not fire on Resume; a key still held does', () => {
    const on = new Map<string, (e: unknown) => void>();
    vi.stubGlobal('window', { addEventListener: (t: string, fn: (e: unknown) => void) => on.set(t, fn) });
    const input = new Input();
    const key = (type: string, code: string) => on.get(type)!({ code, target: { tagName: 'BODY' }, preventDefault: vi.fn() });
    const r = race('buttons');
    (r.app as { input: unknown }).input = input;
    proto.setPaused.call(r, true);
    // N, Shift+Tab through the menu, or RB.
    key('keydown', 'ShiftLeft');
    key('keyup', 'ShiftLeft');
    input.pressNitro('gamepad');
    proto.setPaused.call(r, false);
    expect(input.read().nitro).toBeUndefined();
    proto.setPaused.call(r, true);
    key('keydown', 'KeyN');
    proto.setPaused.call(r, false);
    expect(input.read().nitro).toBe(true);
  });

  it('a respawn in the 3-2-1 (a full restart) drops the armed press', () => {
    const r = { ...race('buttons'), nitroArmed: true, track: { checkpointCount: 2 }, smoke: { clear: vi.fn() }, prev: null, lineView: null };
    Object.assign(r.app.hud, { setCheckpoints: vi.fn(), flipWarning: vi.fn(), clearMessages: vi.fn() });
    Object.assign(r.app.rig, { reset: vi.fn() });
    const at = { x: 0, y: 0, z: 0 };
    Object.assign(r.race, { phase: 'countdown', taken: new Set(), car: { pos: at, rot: { ...at, w: 1 }, nitroTime: 0, nitroCooldown: 0 } });
    proto.handle.call(r, [{ type: 'respawn', auto: false }]);
    expect(r.nitroArmed).toBe(false);
    expect(r.app.input.clearNitroPress).toHaveBeenCalled();
  });

  it('fires with a whoosh and a shake, and pops the button when it has recharged', () => {
    const r = { ...race('buttons'), nitroArmed: true };
    proto.handle.call(r, [{ type: 'nitro' }]);
    expect(r.app.audio.nitro).toHaveBeenCalled();
    expect(r.app.rig.shake).toBeGreaterThan(0);
    expect(r.nitroArmed).toBe(false);
    proto.handle.call(r, [{ type: 'nitroReady' }]);
    expect(r.app.audio.nitroReady).toHaveBeenCalled();
    expect(r.app.hud.nitroPop).toHaveBeenCalled();
  });
});
