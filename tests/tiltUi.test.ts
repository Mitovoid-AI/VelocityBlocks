// The tilt UI shared by Settings, Profile > Controls and the Tilt steering screen (src/app/tiltUi.ts):
// the sliders' ranges and labels, the gauge, Recentre and auto-centre, Reset.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/app';
import { bindTiltControls, gaugeState, GAUGE_DEG, recentreSaved, resetTiltTuning, setAutoCentre, TILT_KNOBS, tiltGaugeHtml, tiltSliderHtml } from '../src/app/tiltUi';
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from '../src/game/storage';
import { smoothingCutoff, TILT_DEAD_DEG, tiltLockDeg } from '../src/input/tilt';
import { toast } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  toast: vi.fn(),
}));

afterEach(() => {
  vi.mocked(toast).mockClear();
});

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, steerMode: 'tilt', ...over });

describe('defaults', () => {
  it('are the tilt feel of earlier builds: dead zone 1.5, linear, the same light smoothing', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ tiltSensitivity: 0.5, tiltDeadzone: TILT_DEAD_DEG, tiltCurve: 0, tiltSmoothing: 0.5, analogSteer: true });
    expect(smoothingCutoff(DEFAULT_SETTINGS.tiltSmoothing)).toBeCloseTo(9.49, 2);
  });
});

describe('TILT_KNOBS', () => {
  it('drive the four settings over their stored ranges', () => {
    expect(TILT_KNOBS.sens).toMatchObject({ key: 'tiltSensitivity', spec: { min: 0, max: 1 } });
    expect(TILT_KNOBS.dead).toMatchObject({ key: 'tiltDeadzone', spec: { min: 0, max: 6 } });
    expect(TILT_KNOBS.smooth).toMatchObject({ key: 'tiltSmoothing', spec: { min: 0, max: 1 } });
    expect(TILT_KNOBS.curve).toMatchObject({ key: 'tiltCurve', spec: { min: 0, max: 1 } });
    // migrateSettings clamps to the same ranges.
    const m = migrateSettings({ tiltDeadzone: 99, tiltSmoothing: -1, tiltCurve: 3, tiltSensitivity: 0.5125 });
    expect(m).toMatchObject({ tiltDeadzone: 6, tiltSmoothing: 0, tiltCurve: 1, tiltSensitivity: 0.5125 });
  });

  it('say what a value means', () => {
    expect(TILT_KNOBS.sens.text(0.5)).toBe('5.0');
    expect(TILT_KNOBS.sens.aria(1)).toContain('12 degrees');
    expect(TILT_KNOBS.dead.text(1.5)).toBe('1.5°');
    expect(TILT_KNOBS.smooth.text(0)).toBe('Off');
    expect(TILT_KNOBS.smooth.text(0.5)).toBe('Medium');
    expect(TILT_KNOBS.smooth.text(1)).toBe('Strong');
    expect(TILT_KNOBS.curve.text(0)).toBe('Linear');
    expect(TILT_KNOBS.curve.text(0.4)).toBe('Gentle 40%');
  });

  it('render as sliders tagged with their knob', () => {
    const h = tiltSliderHtml('dead', settings({ tiltDeadzone: 3 }), 'lbl');
    expect(h).toContain('data-tilt="dead"');
    expect(h).toContain('aria-valuenow="3"');
    expect(tiltGaugeHtml(true)).toContain('data-tilt-gauge');
  });
});

describe('gaugeState', () => {
  const s = settings();

  it('says so without a reading, or before the automatic straight ahead is taken', () => {
    expect(gaugeState(null, 0, s)).toMatchObject({ needle: 0, fill: 0, text: 'No tilt reading yet' });
    expect(gaugeState(12, null, s)).toMatchObject({ needle: 0, fill: 0, text: 'Hold the device the way you drive' });
  });

  it('measures from the straight ahead it is given: needle the tilt, fill the steering up to the lock mark', () => {
    const lock = tiltLockDeg(0.5);
    const g = gaugeState(20 + lock, 20, s);
    expect(g.text).toBe('Right 100%');
    expect(g.needle).toBeCloseTo(lock / GAUGE_DEG, 9);
    expect(g.fill).toBeCloseTo(g.lock, 9);
    expect(g.lock).toBeCloseTo(lock / GAUGE_DEG, 9);
    expect(g.dead).toBeCloseTo(TILT_DEAD_DEG / GAUGE_DEG, 9);
    expect(gaugeState(21, 20, s).text).toBe('Straight'); // inside the dead zone
    expect(gaugeState(10, 20, s).text).toMatch(/^Left \d+%$/);
    expect(gaugeState(20 - 80, 20, s).needle).toBe(-1);
  });

  it('shows the centre feel: the same tilt steers less', () => {
    const lin = gaugeState(10, 0, s);
    const gentle = gaugeState(10, 0, settings({ tiltCurve: 1 }));
    expect(gentle.needle).toBe(lin.needle);
    expect(gentle.fill).toBeLessThan(lin.fill);
  });
});

/** The App parts the tilt UI uses. */
function app(reading: number | null, over: Partial<Settings> = {}) {
  const s = settings(over);
  return {
    store: { settings: s, saveSettings: vi.fn() },
    input: { recentreTilt: vi.fn(() => reading), tiltAngle: vi.fn(() => reading) },
    applyTiltTuning: vi.fn(),
  };
}
const asApp = (a: ReturnType<typeof app>) => a as unknown as App;

describe('recentreSaved', () => {
  it('saves straight ahead for every race, and says auto-centre at the start is now off', () => {
    const a = app(7.26);
    expect(recentreSaved(asApp(a))).toBe(true);
    expect(a.store.settings).toMatchObject({ tiltCenter: 7.3, tiltCenterSet: true });
    expect(a.store.saveSettings).toHaveBeenCalled();
    expect(vi.mocked(toast).mock.calls[0][0]).toMatch(/Auto-centre/);
  });

  it('saves nothing without a reading', () => {
    const a = app(null);
    expect(recentreSaved(asApp(a))).toBe(false);
    expect(a.store.settings).toMatchObject({ tiltCenter: 0, tiltCenterSet: false });
    expect(a.store.saveSettings).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });
});

describe('setAutoCentre', () => {
  it('on: each race takes straight ahead at GO again', () => {
    const a = app(5, { tiltCenter: 9, tiltCenterSet: true });
    expect(setAutoCentre(asApp(a), true)).toBe(true);
    expect(a.store.settings.tiltCenterSet).toBe(false);
    expect(a.store.saveSettings).toHaveBeenCalled();
  });

  it('off: the way the device is held now is saved; without a reading it stays on', () => {
    const a = app(-4);
    expect(setAutoCentre(asApp(a), false)).toBe(false);
    expect(a.store.settings).toMatchObject({ tiltCenter: -4, tiltCenterSet: true });
    const none = app(null);
    expect(setAutoCentre(asApp(none), false)).toBe(true);
    expect(none.store.settings.tiltCenterSet).toBe(false);
  });
});

describe('resetTiltTuning', () => {
  it('puts every tilt setting back, auto-centre on', () => {
    const s = settings({ tiltSensitivity: 1, tiltDeadzone: 5, tiltSmoothing: 0, tiltCurve: 1, analogSteer: false, tiltCenter: 12, tiltCenterSet: true });
    resetTiltTuning(s);
    expect(s).toMatchObject({
      tiltSensitivity: DEFAULT_SETTINGS.tiltSensitivity,
      tiltDeadzone: DEFAULT_SETTINGS.tiltDeadzone,
      tiltSmoothing: DEFAULT_SETTINGS.tiltSmoothing,
      tiltCurve: DEFAULT_SETTINGS.tiltCurve,
      analogSteer: true,
      tiltCenterSet: false,
    });
  });
});

describe('bindTiltControls', () => {
  it('binds nothing and starts no frame loop on a screen stand-in', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const root = { querySelectorAll: () => [] };
    const c = bindTiltControls(root as unknown as HTMLElement, asApp(app(3)));
    expect(raf).not.toHaveBeenCalled();
    expect(() => c.set('sens', 0.2)).not.toThrow();
    vi.unstubAllGlobals();
  });

  it('a slider drag applies at once and saves when let go', () => {
    const on = new Map<string, (e: unknown) => void>();
    const val = { textContent: '' };
    const slider = {
      dataset: { tilt: 'dead' },
      addEventListener: (t: string, fn: (e: unknown) => void) => on.set(t, fn),
      getBoundingClientRect: () => ({ left: 0, width: 224 }),
      style: { setProperty() {} },
      setAttribute() {},
      setPointerCapture() {},
      classList: { add() {}, remove() {} },
      focus() {},
    };
    const root = {
      querySelectorAll: (sel: string) => (sel === '[data-tilt]' ? [slider] : sel === '[data-tilt-val="dead"]' ? [val] : []),
    };
    const a = app(3);
    bindTiltControls(root as unknown as HTMLElement, asApp(a));
    const ev = (x: number) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, preventDefault() {} });
    on.get('pointerdown')!(ev(12 + (3 / 6) * 200));
    on.get('pointermove')!(ev(12 + (4.5 / 6) * 200));
    expect(a.store.settings.tiltDeadzone).toBe(4.5);
    expect(a.applyTiltTuning).toHaveBeenCalled();
    expect(val.textContent).toBe('4.5°');
    expect(a.store.saveSettings).not.toHaveBeenCalled();
    on.get('pointerup')!(ev(12 + (4.5 / 6) * 200));
    expect(a.store.saveSettings).toHaveBeenCalledTimes(1);
  });
});
