// Driver profile: the home-page card, the first-launch setup page and the profile editor.
// Both pages sit in a left-hand panel while the garage camera shows the car on the right.
// Every change is saved at once and reported through app.profileChanged().

import { CAR_BODIES, CAR_ICON_WHEELS, isCarBody, vehicleInfo, VEHICLE_INFO, type IconWheel } from '../core/cars';
import { isModelId, modelsOf, vehicleModel } from '../core/vehicleModels';
import { isVehicleClass, VEHICLE_LABEL, type VehicleClass } from '../core/vehicles';
import { DEFAULT_NAME, PROFILE_NAME_MAX, sanitizeColor, sanitizeName, STEER_MODES, type PedalMode, type Profile } from '../game/storage';
import { isTouchDevice } from '../input/input';
import { STEER_LABEL } from '../input/touchModel';
import { avatarSrc } from '../ui/avatarArt';
import { $, esc, pickImageFile, showScreen, toast } from '../ui/dom';
import { PHOTO_MAX_FILE_BYTES, squarePhoto } from '../ui/photo';
import '../ui/profile.css';
import type { App } from './app';
import { effectiveModel, effectiveVehicle, fullGame, modelLocked, vehicleLocked } from './fullGame';
import { showTiltScreen } from './tiltScreen';
import { bindTiltControls, tiltSliderHtml, tiltValHtml } from './tiltUi';

export const CAR_COLORS = ['#e8452c', '#ffb02e', '#2fbf5b', '#2f6fd6', '#9b5cff', '#f5f5f5', '#1b1e24', '#ff4fa3'];

export type ProfileMode = 'setup' | 'edit';

type Tab = 'driver' | 'car' | 'controls';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'driver', label: 'Driver' },
  // The Car tab picks the vehicle (Car, Bike or Truck) too.
  { id: 'car', label: 'Vehicle' },
  { id: 'controls', label: 'Controls' },
];
const CAMERAS = [
  { id: 'chase', label: 'Chase' },
  { id: 'far', label: 'Far' },
  { id: 'hood', label: 'Hood' },
] as const;
const PEDALS: readonly { id: PedalMode; label: string }[] = [
  { id: 'bars', label: 'Bars' },
  { id: 'buttons', label: 'On / off' },
];
/** Traction control (physics TcLevel). Low lets the rear wheels spin out of corners. */
const TRACTION = [
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
] as const;

// Reopening the editor returns to the tab used last.
let lastTab: Tab = 'driver';
// A photo is being decoded and encoded; survives leaving the screen.
let busy = false;

/** The field shows the placeholder rather than the literal default name. */
const nameValue = (p: Profile): string => (p.name === DEFAULT_NAME ? '' : p.name);

const bodyInfo = (p: Profile) => CAR_BODIES.find((b) => b.id === p.carBody) ?? CAR_BODIES[0];

/**
 * The realistic model drawn for a class, if any: a stale id reads as Classic, and so does a model that
 * needs the Full Game (the profile keeps it for when it is bought).
 */
const modelOf = (p: Profile, cls: VehicleClass, unlocked = fullGame().unlocked) => {
  const id = effectiveModel(p, cls, unlocked);
  return isModelId(id) && vehicleModel(id).cls === cls ? vehicleModel(id) : null;
};

/** The class shown and raced: the profile's, or the Car while that class needs the Full Game. */
const classOf = (p: Profile, unlocked = fullGame().unlocked): VehicleClass =>
  isVehicleClass(p.vehicle) ? effectiveVehicle(p, unlocked) : 'car';

/** What the home card says under the name: the realistic model, the car's body style, or the Bike / Truck. */
const vehicleName = (p: Profile): string => {
  const cls = classOf(p);
  const m = modelOf(p, cls);
  if (m) return m.name;
  return cls !== 'car' ? VEHICLE_LABEL[cls] ?? bodyInfo(p).name : bodyInfo(p).name;
};

/** The small padlock on an option that needs the Full Game (the option opens the Full Game screen). */
const LOCK = '<span class="lock" aria-label="Locked: Full Game">&#128274;</span>';

/** A 64x24 side-view icon: the shape, then its wheels. */
const iconSvg = (path: string, wheels: readonly IconWheel[]): string =>
  `<svg viewBox="0 0 64 24" aria-hidden="true"><path d="${path}"/>${wheels.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('')}</svg>`;

/** Avatar <img>: the photo or the dummy, ringed in the car colour (sanitised, so safe in style). */
function avatarImg(photo: string | null, color: string, cls: string): string {
  const src = avatarSrc(photo);
  return `<img class="${cls}" data-avatar alt="" draggable="false" ${src ? `src="${esc(src)}"` : ''} style="border-color:${color}"/>`;
}

/** Profile pill for the home page. Not a .btn, so the screen's auto-focus still lands on Play. */
export function homeCardHtml(app: App): string {
  const p = app.store.profile;
  const photo = app.store.profilePhoto();
  return `<button class="home-profile" data-act="profile" aria-label="Driver profile: ${esc(p.name)}. Tap to edit.">
    <span class="hp-avatar">${avatarImg(photo, p.carColor, 'avatar')}<span class="hp-add ${photo ? 'hidden' : ''}" aria-hidden="true">+</span></span>
    <span class="hp-text"><span class="hp-name">${esc(p.name)}</span>
      <span class="hp-car"><span class="color-dot" style="background:${p.carColor}"></span>${esc(vehicleName(p))}</span></span>
    <span class="hp-edit" aria-hidden="true">&#9998;</span>
  </button>`;
}

/** Photo, name and photo buttons: the whole setup page, and the editor's Driver tab. */
function identityHtml(app: App): string {
  const p = app.store.profile;
  const photo = app.store.profilePhoto();
  const pick = isTouchDevice()
    ? '<button class="btn small" data-act="photo-pick">Gallery</button><button class="btn small" data-act="photo-camera">Camera</button>'
    : '<button class="btn small" data-act="photo-pick">Choose photo</button>';
  return `<div class="pf-id">
    <button class="pf-photo ${busy ? 'busy' : ''}" data-act="photo-pick" aria-label="Choose a photo" ${busy ? 'disabled' : ''}>
      ${avatarImg(photo, p.carColor, 'avatar avatar-lg')}<span class="pf-add ${photo ? 'hidden' : ''}" aria-hidden="true">+</span></button>
    <div class="pf-fields">
      <label class="pf-label pf-name-label" for="pf-name">Driver name</label>
      <input id="pf-name" type="text" maxlength="${PROFILE_NAME_MAX}" placeholder="Your name" aria-label="Driver name" value="${esc(nameValue(p))}" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done"/>
      <div class="pf-photo-btns">${pick}<button class="btn small" data-act="photo-remove" ${photo && !busy ? '' : 'disabled'}>Remove</button></div>
      <p class="pf-note">Only this game uses your photo. It is never sent anywhere.</p>
    </div>
  </div>`;
}

/**
 * The Vehicle tab: the class (Car, Bike, Truck), the colour (shared by all three), then the car's
 * body styles (cars only). Re-rendered in place when the class changes (data-act handlers are
 * delegated from the screen, so they keep working).
 */
export function carHtml(p: Profile, unlocked = fullGame().unlocked): string {
  const cur = classOf(p, unlocked);
  const vehicles = VEHICLE_INFO.map((v) => {
    const on = v.id === cur;
    const lock = vehicleLocked(v.id, unlocked);
    return `<button class="body-opt veh-opt ${on ? 'sel' : ''}${lock ? ' locked' : ''}" data-act="vehicle" data-v="${v.id}" role="radio" aria-checked="${on}" title="${esc(lock ? `${v.blurb}. Full Game` : v.blurb)}">${iconSvg(v.icon, v.wheels)}<span>${lock ? LOCK : ''}${esc(v.name)}</span></button>`;
  }).join('');
  const colors = CAR_COLORS.includes(p.carColor) ? CAR_COLORS : [p.carColor, ...CAR_COLORS];
  const swatches = colors
    .map((c) => `<button class="swatch ${c === p.carColor ? 'sel' : ''}" style="background:${c}" data-act="color" data-c="${c}" aria-label="Colour ${c}"></button>`)
    .join('');
  const model = modelOf(p, cur, unlocked);
  // Every realistic model of this class needs the Full Game: the Realistic toggle carries the lock.
  const realLocked = modelsOf(cur).length > 0 && modelsOf(cur).every((m) => modelLocked(m.id, unlocked));
  // Classic (procedural) or Realistic (a downloaded model): two small toggles in the label row, so the
  // pane keeps its height budget (profile.css).
  const look = (['classic', 'realistic'] as const)
    .map((v) => {
      const on = (v === 'realistic') === !!model;
      const lock = v === 'realistic' && realLocked;
      return `<button class="look-opt ${on ? 'sel' : ''}${lock ? ' locked' : ''}" data-act="look" data-v="${v}" aria-pressed="${on}">${lock ? LOCK : ''}${v === 'classic' ? 'Classic' : 'Realistic'}</button>`;
    })
    .join('');
  const options = model
    ? modelsOf(cur).map((m) => {
        const on = m.id === model.id;
        const lock = modelLocked(m.id, unlocked);
        return `<button class="body-opt ${on ? 'sel' : ''}${lock ? ' locked' : ''}" data-act="model" data-m="${m.id}" role="radio" aria-checked="${on}" title="${esc(m.blurb)}">${iconSvg(m.icon, m.wheels)}<span>${lock ? LOCK : ''}${esc(m.name)}</span></button>`;
      })
    : cur === 'car'
      ? CAR_BODIES.map((b) => {
          const on = b.id === p.carBody;
          return `<button class="body-opt ${on ? 'sel' : ''}" data-act="body" data-b="${b.id}" role="radio" aria-checked="${on}" title="${esc(b.blurb)}">${iconSvg(b.icon, CAR_ICON_WHEELS)}<span>${esc(b.name)}</span></button>`;
        })
      : [];
  // A single realistic model needs no picker row.
  const bodies = `<div class="pf-label pf-look-row"><span id="pf-body-l">${cur === 'car' ? 'Body style' : 'Look'}</span><span class="look-seg" role="group" aria-label="Look">${look}</span></div>
    ${options.length > 1 ? `<div class="bodies" role="radiogroup" aria-labelledby="pf-body-l">${options.join('')}</div>` : ''}`;
  // At 640x360 the car's note is cut to one line (its body-style row fills the height budget in profile.css);
  // the bike's and the truck's have room to wrap, so a realistic model's credit and paint note stay whole.
  const note = model
    ? `${model.name} by ${model.credit.author}, ${model.credit.license}${model.tintable ? '' : '. Factory paint: the rider wears your colour'}.`
    : cur === 'car'
      ? 'Own records per vehicle. Bodies are looks only.'
      : `${vehicleInfo(cur).blurb}. Own records and medals.`;
  const oneLine = cur === 'car';
  return `<div class="pf-label" id="pf-veh-l">Vehicle</div>
    <div class="bodies vehicles" role="radiogroup" aria-labelledby="pf-veh-l">${vehicles}</div>
    <div class="pf-label">Colour</div>
    <div class="swatches pf-swatches">${swatches}</div>
    ${bodies}
    <div class="body-note${oneLine ? ' one-line' : ''}" title="${esc(note)}">${esc(note)}</div>`;
}

// Toggles are buttons, not checkboxes, so a second-finger tap (pointerup routing in
// showScreen, which sends no click) works on them like on every other control.
const switchHtml = (k: string, label: string, on: boolean, title = ''): string =>
  `<button class="pf-switch" data-act="switch" data-k="${k}" role="switch" aria-checked="${on}"${title ? ` title="${esc(title)}"` : ''}><span class="pf-box" aria-hidden="true"></span><span>${label}</span></button>`;

/** A row of choice buttons (seg); `act` is the data-act, the value goes in data-v. */
const segHtml = (id: string, act: string, opts: readonly { id: string; label: string }[], cur: string): string =>
  `<div class="seg" role="group" aria-labelledby="${id}">${opts
    .map((o) => `<button class="btn small ${o.id === cur ? 'sel' : ''}" data-act="${act}" data-v="${o.id}" aria-pressed="${o.id === cur}">${o.label}</button>`)
    .join('')}</div>`;

// One row at 640x360 (see the height budget in profile.css): the sensitivity slider (src/ui/slider.ts,
// which a second finger can drag too) and "More...", the Tilt steering screen with the gauge,
// Recentre and the other sliders.
function tiltHtml(app: App): string {
  const s = app.store.settings;
  return `<div class="pf-glabel pf-tilt-row ${s.steerMode === 'tilt' ? '' : 'hidden'}" id="pf-tilt-l">Tilt</div>
    <div class="pf-tilt pf-tilt-row ${s.steerMode === 'tilt' ? '' : 'hidden'}">
      ${tiltSliderHtml('sens', s, 'pf-tilt-l')}${tiltValHtml('sens', s, 'pf-sens')}
      <button class="btn small" data-act="tilt-more" aria-label="More tilt steering settings">More&hellip;</button>
    </div>`;
}

function controlsHtml(app: App): string {
  const s = app.store.settings;
  const touch = isTouchDevice();
  const steer = touch
    ? `<div class="pf-glabel" id="pf-steer-l">Steering</div>
      ${segHtml('pf-steer-l', 'steer', STEER_MODES.map((m) => ({ id: m, label: STEER_LABEL[m] })), s.steerMode)}
      <div class="pf-glabel" id="pf-pedal-l">Pedals</div>
      ${segHtml('pf-pedal-l', 'pedals', PEDALS, s.pedals)}
      ${tiltHtml(app)}`
    : '';
  return `<div class="pf-grid">
      <div class="pf-glabel" id="pf-cam-l">Camera</div>
      ${segHtml('pf-cam-l', 'cam', CAMERAS, s.camera)}
      ${steer}
      <div class="pf-glabel" id="pf-tc-l" title="Auto-accelerate always uses Normal">Traction</div>
      ${segHtml('pf-tc-l', 'tc', TRACTION, s.autoAccelerate ? 'normal' : s.tractionControl)}
    </div>
    <div class="pf-switches">
      ${switchHtml('auto', 'Auto-accelerate', s.autoAccelerate)}
      ${switchHtml('line', 'Racing line', s.racingLine)}
      ${switchHtml('badge', 'Photo on my car', app.store.profile.showBadge, 'Your photo above your car and your ghost')}
      ${touch ? switchHtml('analog', 'Fast wheel/tilt', s.analogSteer, 'A quicker steering response for tilt and the wheel (buttons and keys are unchanged)') : ''}
    </div>`;
}

function editHtml(app: App): string {
  const tabs = TABS.map(
    (t) => `<button class="btn small pf-tab ${t.id === lastTab ? 'sel' : ''}" role="tab" aria-selected="${t.id === lastTab}" data-act="tab" data-tab="${t.id}">${t.label}</button>`,
  ).join('');
  const pane = (id: Tab, html: string) => `<div class="pf-pane pf-${id} ${id === lastTab ? '' : 'hidden'}" data-pane="${id}" role="tabpanel">${html}</div>`;
  return `<div class="pf-wrap">
    <div class="header pf-head"><button class="btn small" data-act="back">&#8592; Back</button><h2>Driver profile</h2><div class="spacer"></div><button class="btn small primary" data-act="done">Done</button></div>
    <div class="pf-tabs" role="tablist" aria-label="Profile sections">${tabs}</div>
    <section class="panel pf-panel">
      ${pane('driver', identityHtml(app))}
      ${pane('car', carHtml(app.store.profile))}
      ${pane('controls', controlsHtml(app))}
    </section>
  </div>`;
}

function setupHtml(app: App): string {
  return `<div class="pf-wrap pf-setup">
    <div class="header pf-head"><h2>${app.store.returningPlayer ? 'New: your driver profile' : 'Welcome, driver!'}</h2><div class="spacer"></div><button class="btn small" data-act="back">Skip</button></div>
    <section class="panel pf-panel">
      ${identityHtml(app)}
      <div class="setup-go"><button class="btn primary" data-act="done">Let's race &#9654;</button>
        <span class="muted">Your photo floats above your car while you race. Tap your card on the home screen to change it, your car and your controls.</span></div>
    </section>
  </div>`;
}

/** Show the setup page or the editor. `back` is where Back, Done and Skip go. */
export function showProfileScreen(app: App, mode: ProfileMode, back: () => void): HTMLElement {
  const store = app.store;
  const p = store.profile;
  const s = store.settings;
  let el!: HTMLElement;
  // Keystrokes save at once but are reported once, on blur or when leaving (no blur fires
  // when the screen is replaced with the field still focused).
  let nameEdited = false;

  // Reads the field directly, so a name still being composed (Gboard) is never lost.
  const commitName = () => {
    const t = el.querySelector<HTMLInputElement>('#pf-name');
    const name = t ? sanitizeName(t.value) : p.name;
    if (name !== p.name) {
      p.name = name;
      store.saveProfile();
      nameEdited = true;
    }
    if (!nameEdited) return;
    nameEdited = false;
    app.profileChanged('name');
  };
  const leave = () => {
    commitName();
    if (mode === 'setup') {
      p.setupDone = true;
      store.saveProfile();
    }
    // A slider drag cut short by Android Back has applied its value but not saved it yet.
    if (mode === 'edit') store.saveSettings();
    back();
  };
  const selectIn = (group: string, b: HTMLElement, aria: 'aria-pressed' | 'aria-checked' | 'aria-selected') =>
    el.querySelectorAll<HTMLElement>(group).forEach((x) => {
      x.classList.toggle('sel', x === b);
      x.setAttribute(aria, String(x === b));
    });
  const setSwitch = (b: HTMLElement, on: boolean) => b.setAttribute('aria-checked', String(on));
  // A lock badge (Bike, Truck, Realistic): the Full Game screen, and Back returns to this tab.
  const openStore = () => {
    commitName();
    if (mode === 'edit') store.saveSettings();
    app.showFullGame(() => app.profileScreen(mode, back));
  };
  // The Vehicle pane changes shape with the class and the look; a keyboard user stays on the control used.
  const redrawCarPane = (focus: string) => {
    const pane = el.querySelector<HTMLElement>('.pf-pane.pf-car');
    if (!pane) return;
    const focused = pane.contains(document.activeElement);
    pane.innerHTML = carHtml(p);
    if (focused) pane.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  };
  // Auto-accelerate races on Normal traction control (physics assistsFor), so the choice is shown as Normal and locked.
  const syncTraction = () => {
    const shown = s.autoAccelerate ? 'normal' : s.tractionControl;
    el.querySelectorAll<HTMLButtonElement>('.seg [data-act="tc"]').forEach((x) => {
      x.disabled = s.autoAccelerate;
      x.classList.toggle('sel', x.dataset.v === shown);
      x.setAttribute('aria-pressed', String(x.dataset.v === shown));
    });
  };

  el = showScreen(mode === 'setup' ? setupHtml(app) : editHtml(app), `profile garage ${mode === 'setup' ? 'setup' : 'edit'}`, {
    back: leave,
    done: leave,
    tab: (b) => {
      const id = b.dataset.tab as Tab;
      if (!TABS.some((t) => t.id === id)) return;
      lastTab = id;
      selectIn('.pf-tab', b, 'aria-selected');
      el.querySelectorAll<HTMLElement>('.pf-pane').forEach((x) => x.classList.toggle('hidden', x.dataset.pane !== id));
    },
    'photo-pick': () => void pickPhoto(app, false),
    'photo-camera': () => void pickPhoto(app, true),
    'photo-remove': () => {
      store.saveProfilePhoto(null);
      refreshAvatars(app);
      app.profileChanged('photo');
    },
    color: (b) => {
      const c = sanitizeColor(b.dataset.c, p.carColor);
      if (c === p.carColor) return;
      p.carColor = c;
      store.saveProfile();
      el.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x === b));
      refreshAvatars(app);
      app.profileChanged('color');
    },
    body: (b) => {
      const v = b.dataset.b;
      if (!isCarBody(v) || v === p.carBody) return;
      p.carBody = v;
      store.saveProfile();
      selectIn('[data-act="body"]', b, 'aria-checked');
      app.profileChanged('body');
    },
    look: (b) => {
      const cls = classOf(p);
      const want = b.dataset.v === 'realistic';
      if (want === !!modelOf(p, cls)) return;
      if (want && modelsOf(cls).every((m) => modelLocked(m.id))) return openStore();
      const models = { ...p.models };
      // A model saved while it was locked (kept for the purchase) comes back first.
      const saved = p.models[cls];
      if (want) models[cls] = saved && !modelLocked(saved) ? saved : modelsOf(cls).find((m) => !modelLocked(m.id))?.id;
      else delete models[cls];
      if (want && !models[cls]) return;
      p.models = models;
      store.saveProfile();
      redrawCarPane(`[data-act="look"][data-v="${b.dataset.v}"]`);
      app.profileChanged('model');
    },
    model: (b) => {
      const id = b.dataset.m;
      const cls = classOf(p);
      if (!isModelId(id) || vehicleModel(id).cls !== cls) return;
      if (modelLocked(id)) return openStore();
      if (p.models[cls] === id) return;
      p.models = { ...p.models, [cls]: id };
      store.saveProfile();
      redrawCarPane(`[data-act="model"][data-m="${id}"]`);
      app.profileChanged('model');
    },
    vehicle: (b) => {
      const v = b.dataset.v;
      if (!isVehicleClass(v) || v === classOf(p)) return;
      // Saves the profile and swaps the garage vehicle; a class that needs the Full Game opens its screen.
      if (!app.setVehicle(v)) return openStore();
      // The body styles are the car's only, so the pane changes shape.
      redrawCarPane(`[data-act="vehicle"][data-v="${v}"]`);
    },
    cam: (b) => {
      const v = CAMERAS.find((c) => c.id === b.dataset.v);
      if (!v) return;
      // No applySettings: it would also move the menu camera off 'far'. RaceMode reads it.
      s.camera = v.id;
      store.saveSettings();
      selectIn('.seg [data-act="cam"]', b, 'aria-pressed');
    },
    steer: (b) => {
      const m = STEER_MODES.find((x) => x === b.dataset.v);
      if (!m) return;
      selectIn('.seg [data-act="steer"]', b, 'aria-pressed');
      // Tilt may be refused (no sensor, permission denied): show what was kept.
      void app.setSteerMode(m).then(() => {
        const cur = el.querySelector<HTMLElement>(`.seg [data-act="steer"][data-v="${s.steerMode}"]`);
        if (cur) selectIn('.seg [data-act="steer"]', cur, 'aria-pressed');
        el.querySelectorAll('.pf-tilt-row').forEach((x) => x.classList.toggle('hidden', s.steerMode !== 'tilt'));
      });
    },
    pedals: (b) => {
      const v = PEDALS.find((p) => p.id === b.dataset.v);
      if (!v) return;
      s.pedals = v.id;
      store.saveSettings();
      app.applyControls();
      selectIn('.seg [data-act="pedals"]', b, 'aria-pressed');
    },
    tc: (b) => {
      const v = TRACTION.find((t) => t.id === b.dataset.v);
      if (!v || s.autoAccelerate) return;
      // RaceMode reads it when a run starts or restarts.
      s.tractionControl = v.id;
      store.saveSettings();
      syncTraction();
    },
    // The Tilt steering screen; Back comes back to this tab (lastTab).
    'tilt-more': () => {
      commitName();
      store.saveSettings();
      showTiltScreen(app, () => app.profileScreen(mode, back));
    },
    switch: (b) => {
      const on = b.getAttribute('aria-checked') !== 'true';
      switch (b.dataset.k) {
        case 'auto':
          s.autoAccelerate = on;
          store.saveSettings();
          // The touch layout too: auto-accelerate hides the gas bar.
          app.applyControls();
          setSwitch(b, on);
          syncTraction();
          break;
        case 'line':
          s.racingLine = on;
          store.saveSettings();
          setSwitch(b, on);
          break;
        case 'badge':
          p.showBadge = on;
          store.saveProfile();
          setSwitch(b, on);
          app.profileChanged('badge');
          break;
        case 'analog':
          // RaceMode reads it when a run starts or restarts.
          s.analogSteer = on;
          store.saveSettings();
          setSwitch(b, on);
          break;
      }
    },
  });

  syncTraction();

  const name = $<HTMLInputElement>('#pf-name', el);
  if (name) {
    name.addEventListener('input', () => {
      p.name = sanitizeName(name.value);
      store.saveProfile();
      nameEdited = true;
    });
    name.addEventListener('blur', () => {
      commitName();
      name.value = nameValue(p);
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      }
    });
  }

  // showScreen focuses the first .btn in document order (Back, Skip). Make the primary
  // action the default instead; on setup without a touchscreen, start typing the name.
  const primary = el.querySelector<HTMLElement>('[data-act="done"]');
  if (mode === 'setup' && !isTouchDevice() && name) name.focus({ preventScroll: true });
  else if (mode === 'setup' || el.contains(document.activeElement)) primary?.focus({ preventScroll: true });

  // The sensitivity slider applies while dragged and saves when let go.
  bindTiltControls(el, app);

  app.setGarageView(true);
  return el;
}

/** Point every avatar on screen at the current photo and colour (also after leaving the editor). */
export function refreshAvatars(app: App): void {
  const photo = app.store.profilePhoto();
  const color = app.store.profile.carColor;
  const src = avatarSrc(photo);
  document.querySelectorAll<HTMLImageElement>('#screens img[data-avatar]').forEach((img) => {
    if (src) img.src = src;
    else img.removeAttribute('src');
    img.style.borderColor = color;
  });
  document.querySelectorAll('#screens .hp-add, #screens .pf-add').forEach((x) => x.classList.toggle('hidden', !!photo));
  const remove = document.querySelector<HTMLButtonElement>('#screens [data-act="photo-remove"]');
  if (remove) remove.disabled = busy || !photo;
}

function setBusy(on: boolean): void {
  busy = on;
  document.querySelector('#screens .pf-photo')?.classList.toggle('busy', on);
  document.querySelectorAll<HTMLButtonElement>('#screens [data-act^="photo-"]').forEach((b) => (b.disabled = on));
  // refreshAvatars (called after) puts Remove back to "disabled while there is no photo".
}

async function pickPhoto(app: App, camera: boolean): Promise<void> {
  if (busy) return;
  // Busy starts only once a file arrives: a cancelled chooser on WebView 110 never settles.
  const f = await pickImageFile(camera ? 'user' : undefined);
  if (!f || busy) return;
  if (f.size > PHOTO_MAX_FILE_BYTES) {
    toast('That photo is too large.');
    return;
  }
  setBusy(true);
  try {
    let url = await squarePhoto(f);
    if (!app.store.saveProfilePhoto(url)) {
      // Storage is nearly full: a smaller encode may still fit.
      url = await squarePhoto(f, 128, [0.6]);
      if (!app.store.saveProfilePhoto(url)) {
        toast('Storage is full, so this photo is used only until you close the game. Settings > Reset records & ghosts frees space.', 4500);
      }
    }
  } catch {
    toast("Couldn't read that photo. Try a JPEG or PNG.", 3200);
  } finally {
    setBusy(false);
    refreshAvatars(app);
    app.profileChanged('photo');
  }
}
