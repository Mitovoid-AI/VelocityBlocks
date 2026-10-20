// Tilt steering UI shared by Settings, Profile > Controls and the Tilt steering screen: the
// sliders (src/ui/slider.ts) for sensitivity, dead zone, smoothing and centre feel, the live
// gauge, and the Recentre / auto-centre rules. The pure parts (TILT_KNOBS, gaugeState) are
// tested in tests/tiltUi.test.ts; the binders are null-safe for the tests' screen stand-ins.

import { DEFAULT_SETTINGS, type Settings } from '../game/storage';
import { angleDiff, clampCenter, sensLabel, steerFromRoll, TILT_DEAD_MAX, tiltLockDeg } from '../input/tilt';
import { toast } from '../ui/dom';
import { bindSlider, sliderHtml, type SliderHandle, type SliderSpec } from '../ui/slider';
import type { App } from './app';

export type TiltKnob = 'sens' | 'dead' | 'smooth' | 'curve';
type TiltKey = 'tiltSensitivity' | 'tiltDeadzone' | 'tiltSmoothing' | 'tiltCurve';

interface Knob {
  key: TiltKey;
  spec: SliderSpec;
  /** The short value beside the slider. */
  text(v: number): string;
  /** What a screen reader says. */
  aria(v: number): string;
}

const smoothText = (v: number): string => (v <= 0 ? 'Off' : v < 0.35 ? 'Light' : v < 0.65 ? 'Medium' : 'Strong');

/** The four tilt sliders: the setting each drives, its range and how its value reads. */
export const TILT_KNOBS: Record<TiltKnob, Knob> = {
  sens: {
    key: 'tiltSensitivity',
    // 80 steps: the shown 1.0 .. 9.0 moves by 0.1.
    spec: { min: 0, max: 1, step: 0.0125 },
    text: sensLabel,
    aria: (v) => `${sensLabel(v)}, full lock at ${Math.round(tiltLockDeg(v))} degrees of tilt`,
  },
  dead: {
    key: 'tiltDeadzone',
    spec: { min: 0, max: TILT_DEAD_MAX, step: 0.5 },
    text: (v) => `${v.toFixed(1)}°`,
    aria: (v) => `${v.toFixed(1)} degrees either side of straight ahead steer nothing`,
  },
  smooth: {
    key: 'tiltSmoothing',
    spec: { min: 0, max: 1, step: 0.05 },
    text: smoothText,
    aria: (v) => `${smoothText(v)} (${Math.round(v * 100)}%): steadier when held still, a little later to follow`,
  },
  curve: {
    key: 'tiltCurve',
    spec: { min: 0, max: 1, step: 0.05 },
    text: (v) => (v <= 0 ? 'Linear' : `Gentle ${Math.round(v * 100)}%`),
    aria: (v) => (v <= 0 ? 'Linear: the same response all the way to full lock' : `${Math.round(v * 100)}% gentler near straight ahead, full lock unchanged`),
  },
};

/** A tilt slider at the setting's current value (labelled by `labelId`); its value text goes in a [data-tilt-val] element. */
export function tiltSliderHtml(kind: TiltKnob, s: Settings, labelId: string): string {
  const k = TILT_KNOBS[kind];
  return sliderHtml(k.spec, s[k.key], { labelledBy: labelId, text: k.aria(s[k.key]), data: { tilt: kind } });
}

/** The value text beside a tilt slider. */
export function tiltValHtml(kind: TiltKnob, s: Settings, cls = 'tilt-val'): string {
  return `<span class="${cls}" data-tilt-val="${kind}">${TILT_KNOBS[kind].text(s[TILT_KNOBS[kind].key])}</span>`;
}

/** The live gauge: the tilt (needle) against the dead zone and full-lock marks, and the steering it gives (fill). */
export function tiltGaugeHtml(big = false): string {
  return `<div class="tilt-gauge${big ? ' big' : ''}" data-tilt-gauge aria-hidden="true"><div class="tg-bar"><span class="tg-dead"></span><span class="tg-lock l"></span><span class="tg-lock r"></span><span class="tg-fill"></span><span class="tg-needle"></span></div><div class="tg-text">No tilt reading yet</div></div>`;
}

/** Degrees of tilt either side of the gauge's middle. */
export const GAUGE_DEG = 45;
/** With auto-centre, the preview takes straight ahead from the way the device is held this long after the first reading. */
export const AUTO_REF_MS = 500;

export interface GaugeState {
  /** Needle (the tilt) and fill (the steering, reaching the lock mark at full lock), -1..1 of the half-width. */
  needle: number;
  fill: number;
  /** The full-lock marks and the dead zone's half-width, 0..1 of the half-width. */
  lock: number;
  dead: number;
  text: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * What the gauge shows for the smoothed roll and the straight-ahead roll it is measured from
 * (null: not known yet), with the settings' sensitivity, dead zone and centre feel. It shows the
 * input (the race's steering rack then follows it at its own rate).
 */
export function gaugeState(roll: number | null, ref: number | null, s: Pick<Settings, TiltKey>): GaugeState {
  const lock = tiltLockDeg(s.tiltSensitivity) / GAUGE_DEG;
  const dead = clamp(s.tiltDeadzone, 0, TILT_DEAD_MAX) / GAUGE_DEG;
  if (roll === null) return { needle: 0, fill: 0, lock, dead, text: 'No tilt reading yet' };
  if (ref === null) return { needle: 0, fill: 0, lock, dead, text: 'Hold the device the way you drive' };
  const steer = steerFromRoll(roll, ref, s.tiltSensitivity, s.tiltDeadzone, s.tiltCurve);
  const pct = Math.round(Math.abs(steer) * 100);
  return {
    needle: clamp(angleDiff(roll, ref) / GAUGE_DEG, -1, 1),
    fill: steer * lock,
    lock,
    dead,
    text: pct === 0 ? 'Straight' : `${steer > 0 ? 'Right' : 'Left'} ${pct}%`,
  };
}

export interface TiltControls {
  /** Show values set from outside (Reset). */
  set(kind: TiltKnob, v: number): void;
  /** With auto-centre: take the preview's straight ahead again from how the device is held now. */
  retakeAuto(): void;
}

/**
 * Bind every [data-tilt] slider under `root` (each drag applies at once, a settled value is saved)
 * and keep its [data-tilt-gauge]s live while they are on screen. Null-safe: a stand-in root with
 * no sliders or gauges binds nothing and starts no frame loop.
 */
export function bindTiltControls(root: HTMLElement, app: App): TiltControls {
  const s = app.store.settings;
  const handles: Partial<Record<TiltKnob, SliderHandle | null>> = {};
  const showVal = (kind: TiltKnob, v: number) =>
    root.querySelectorAll<HTMLElement>(`[data-tilt-val="${kind}"]`).forEach((x) => (x.textContent = TILT_KNOBS[kind].text(v)));
  root.querySelectorAll<HTMLElement>('[data-tilt]').forEach((el) => {
    const kind = el.dataset.tilt as TiltKnob;
    const k = TILT_KNOBS[kind];
    if (!k) return;
    handles[kind] = bindSlider(el, k.spec, s[k.key], {
      text: k.aria,
      input: (v) => {
        s[k.key] = v;
        app.applyTiltTuning();
        showVal(kind, v);
      },
      change: () => app.store.saveSettings(),
    });
  });

  // The preview's straight ahead: the saved centre, or (auto-centre, as a race takes it at GO) the
  // way the device is held once the reading has been in for AUTO_REF_MS. Kept here, never in Input.
  let autoRef: number | null = null;
  let since = -1;
  const gauges = [...root.querySelectorAll<HTMLElement>('[data-tilt-gauge]')];
  if (gauges.length && root.isConnected) {
    let last = '';
    const tick = (now: number) => {
      if (!root.isConnected) return;
      // Gauges show only while steering with tilt: the cheap setting check comes first, so a menu that
      // merely holds a hidden gauge never forces a layout flush (offsetParent) every frame.
      if (s.steerMode === 'tilt' && gauges.some((g) => g.offsetParent !== null)) {
        const roll = app.input.tiltAngle();
        if (roll === null) since = -1;
        else if (autoRef === null && !s.tiltCenterSet) {
          if (since < 0) since = now;
          if (now - since >= AUTO_REF_MS) autoRef = clampCenter(roll);
        }
        const g = gaugeState(roll, s.tiltCenterSet ? s.tiltCenter : autoRef, s);
        const key = `${g.needle.toFixed(3)}|${g.fill.toFixed(3)}|${g.lock.toFixed(3)}|${g.dead.toFixed(3)}|${g.text}`;
        if (key !== last) {
          last = key;
          for (const el of gauges) paintGauge(el, g);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  return {
    set(kind, v) {
      handles[kind]?.set(v);
      showVal(kind, v);
    },
    retakeAuto() {
      autoRef = null;
      since = -1;
    },
  };
}

function paintGauge(el: HTMLElement, g: GaugeState): void {
  el.style.setProperty('--needle', g.needle.toFixed(3));
  el.style.setProperty('--fill', g.fill.toFixed(3));
  el.style.setProperty('--lock', g.lock.toFixed(3));
  el.style.setProperty('--dead', g.dead.toFixed(3));
  const t = el.querySelector('.tg-text');
  if (t && t.textContent !== g.text) t.textContent = g.text;
}

/** The tilt tuning keys back to their defaults (the Tilt screen's Reset): the feel of earlier builds, auto-centre on. */
export function resetTiltTuning(s: Settings): void {
  s.tiltSensitivity = DEFAULT_SETTINGS.tiltSensitivity;
  s.tiltDeadzone = DEFAULT_SETTINGS.tiltDeadzone;
  s.tiltSmoothing = DEFAULT_SETTINGS.tiltSmoothing;
  s.tiltCurve = DEFAULT_SETTINGS.tiltCurve;
  s.analogSteer = DEFAULT_SETTINGS.analogSteer;
  s.tiltCenterSet = false;
}

/** Straight ahead to one decimal, as it is saved. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Recentre from Settings, Profile or the Tilt screen: the way the device is held now is straight
 * ahead for every race (the automatic centre at GO stops). False, with a toast, without a reading.
 */
export function recentreSaved(app: App): boolean {
  const c = app.input.recentreTilt();
  if (c === null) {
    toast('No tilt reading yet. Hold the device the way you drive, then try again.', 3000);
    return false;
  }
  const s = app.store.settings;
  const wasAuto = !s.tiltCenterSet;
  s.tiltCenter = round1(c);
  s.tiltCenterSet = true;
  app.store.saveSettings();
  toast(wasAuto ? 'Straight ahead set for every race. Auto-centre at the start is off (Tilt steering screen).' : 'Straight ahead set for every race', 3000);
  return true;
}

/**
 * The Tilt screen's "Auto-centre at each start" switch. On: each race takes straight ahead from the
 * way the device is held at GO. Off: the way it is held now is saved (recentreSaved). The new state.
 */
export function setAutoCentre(app: App, on: boolean): boolean {
  const s = app.store.settings;
  if (!on) return !recentreSaved(app);
  s.tiltCenterSet = false;
  app.store.saveSettings();
  return true;
}
