// The controls wiring: App.setSteerMode / applyControls / showControlsTip, the pause menu's
// Steering row, the tilt recentre at GO and the Controls tab's Recentre. App, RaceMode and the
// profile editor need the DOM and WebGL, so their methods run on stand-ins.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, CONTROLS_TIP } from '../src/app/app';
import { showProfileScreen } from '../src/app/profileScreen';
import { RaceMode } from '../src/app/raceMode';
import { DEFAULT_SETTINGS, migrateProfile, type Settings, type SteerMode } from '../src/game/storage';
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
};
const proto = RaceMode.prototype as unknown as RaceProto;

/** The RaceMode fields the pause menu uses, over a stand-in App whose setSteerMode follows App's rules. */
function race(steerMode: SteerMode, tiltOk = true) {
  const settings: Settings = { ...DEFAULT_SETTINGS, steerMode };
  const app = {
    store: { settings, saveSettings: vi.fn() },
    hud: { message: vi.fn(), show: vi.fn(), countdown: vi.fn() },
    audio: { silence: vi.fn(), countdown: vi.fn() },
    rig: {},
    input: { recentreTilt: vi.fn(() => 3) },
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
    resultsShown: false,
    paused: false,
    phaseSince: 0,
    steerBusy: false,
    swallowedBacks: 0,
    flipRespawns: 0,
    framesAtStart: 0,
    cancelsAtStart: 0,
    ghostLabel: () => 'Ghost: on',
    lineLabel: () => 'Racing line: off',
    steerLabel: (RaceMode.prototype as unknown as { steerLabel(): string }).steerLabel,
    diagText: () => '',
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

describe('Controls tab Recentre', () => {
  /** The profile editor over a stand-in App; returns its data-act handlers (showScreen is mocked). */
  function editor(reading: number | null) {
    const el = { querySelector: () => null, querySelectorAll: () => [], contains: () => false };
    vi.mocked(showScreen).mockReturnValueOnce(el as unknown as HTMLElement);
    vi.stubGlobal('document', { activeElement: null });
    const settings: Settings = { ...DEFAULT_SETTINGS, steerMode: 'tilt' };
    const app = {
      store: { settings, profile: migrateProfile(null, {}), profilePhoto: () => null, saveSettings: vi.fn(), saveProfile: vi.fn() },
      input: { recentreTilt: vi.fn(() => reading) },
      setGarageView: vi.fn(),
    };
    showProfileScreen(app as unknown as App, 'edit', () => {});
    const handlers = vi.mocked(showScreen).mock.calls[0][2];
    return { app, settings, recentre: () => handlers.recentre(el as unknown as HTMLElement) };
  }

  it('saves straight ahead for every race (no centre at GO from then on)', () => {
    const { app, settings, recentre } = editor(7.26);
    recentre();
    expect(settings).toMatchObject({ tiltCenter: 7.3, tiltCenterSet: true });
    expect(app.store.saveSettings).toHaveBeenCalled();
  });

  it('saves nothing without a tilt reading', () => {
    const { app, settings, recentre } = editor(null);
    recentre();
    expect(settings).toMatchObject({ tiltCenter: 0, tiltCenterSet: false });
    expect(app.store.saveSettings).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });
});
