// The Tilt steering screen, reached through "More..." in Settings and in Profile > Controls: a big
// live gauge, the sensitivity, dead zone, smoothing and centre feel sliders, Recentre, the
// auto-centre switch and the analog steering assist. It uses the profile pages' garage layout
// (profile.css), and fits 640x360 without scrolling:
//   340 - header 39 - panel 22 = 279 for: gauge 30 + 6 + four slider rows 4 x 30 + 3 x 6 = 138
//   + 6 + Recentre / switches 28 + 6 + 28 = 242.

import { esc, showScreen, toast } from '../ui/dom';
import '../ui/profile.css';
import type { App } from './app';
import { bindTiltControls, recentreSaved, resetTiltTuning, setAutoCentre, tiltGaugeHtml, tiltSliderHtml, tiltValHtml, type TiltKnob } from './tiltUi';

const ROWS: readonly { kind: TiltKnob; label: string; title: string }[] = [
  { kind: 'sens', label: 'Sensitivity', title: 'How far to tilt for full lock (1: 35 degrees, 9: 12 degrees)' },
  { kind: 'dead', label: 'Dead zone', title: 'Tilt around straight ahead that steers nothing' },
  { kind: 'smooth', label: 'Smoothing', title: 'Steadier while held still; stronger smoothing follows a little later' },
  { kind: 'curve', label: 'Centre feel', title: 'Gentler steering near straight ahead, the same full lock' },
];

// A checkbox look on a button, as in the profile (a second-finger tap works on it).
const switchHtml = (k: string, label: string, on: boolean, title: string): string =>
  `<button class="pf-switch" data-act="switch" data-k="${k}" role="switch" aria-checked="${on}" title="${esc(title)}"><span class="pf-box" aria-hidden="true"></span><span>${label}</span></button>`;

/** Show the Tilt steering screen; `back` (Back, Android Back) returns to where it was opened from. */
export function showTiltScreen(app: App, back: () => void): void {
  const { store } = app;
  const s = store.settings;
  const rows = ROWS.map(
    (r) =>
      `<div class="pf-glabel" id="tt-${r.kind}-l" title="${esc(r.title)}">${r.label}</div><div class="tilt-row">${tiltSliderHtml(r.kind, s, `tt-${r.kind}-l`)}${tiltValHtml(r.kind, s)}</div>`,
  ).join('');
  const el = showScreen(
    `<div class="pf-wrap">
      <div class="header pf-head"><button class="btn small" data-act="back">&#8592; Back</button><h2>Tilt steering</h2><div class="spacer"></div><button class="btn small" data-act="reset">Reset</button></div>
      <section class="panel pf-panel tilt-panel">
        ${tiltGaugeHtml(true)}
        <div class="pf-grid tilt-grid">${rows}</div>
        <div class="tilt-actions">
          <button class="btn small" data-act="recentre">Recentre</button>
          ${switchHtml('auto', 'Auto-centre at each start', !s.tiltCenterSet, 'Straight ahead is the way you hold the device at GO')}
          ${switchHtml('analog', 'Fast wheel/tilt', s.analogSteer, 'A quicker steering response for tilt and the wheel (buttons and keys are unchanged)')}
        </div>
      </section>
    </div>`,
    'profile garage edit tilt-screen',
    {
      back: () => {
        // A drag cut short by Android Back has applied its value but not saved it yet.
        store.saveSettings();
        back();
      },
      reset: () => {
        resetTiltTuning(s);
        app.applyTiltTuning();
        store.saveSettings();
        toast('Tilt steering is back to the defaults');
        showTiltScreen(app, back);
      },
      recentre: () => {
        if (recentreSaved(app)) setSwitch('auto', false);
      },
      switch: (b) => {
        const on = b.getAttribute('aria-checked') !== 'true';
        if (b.dataset.k === 'auto') {
          const now = setAutoCentre(app, on);
          setSwitch('auto', now);
          if (now) ctl.retakeAuto();
        } else if (b.dataset.k === 'analog') {
          // RaceMode reads it when a run starts or restarts.
          s.analogSteer = on;
          store.saveSettings();
          setSwitch('analog', on);
        }
      },
    },
  );
  const setSwitch = (k: string, on: boolean) => el.querySelector(`[data-act="switch"][data-k="${k}"]`)?.setAttribute('aria-checked', String(on));
  const ctl = bindTiltControls(el, app);
  app.setGarageView(true);
}
