// Driver profile: the home-page card, the first-launch setup page and the profile editor.
// Both pages sit in a left-hand panel while the garage camera shows the car on the right.
// Every change is saved at once and reported through app.profileChanged().

import { CAR_BODIES, CAR_BODY_NOTE, isCarBody } from '../core/cars';
import { DEFAULT_NAME, PROFILE_NAME_MAX, sanitizeColor, sanitizeName, type Profile } from '../game/storage';
import { isTouchDevice } from '../input/input';
import { avatarSrc } from '../ui/avatarArt';
import { $, esc, pickImageFile, showScreen, toast } from '../ui/dom';
import { PHOTO_MAX_FILE_BYTES, squarePhoto } from '../ui/photo';
import '../ui/profile.css';
import type { App } from './app';

export const CAR_COLORS = ['#e8452c', '#ffb02e', '#2fbf5b', '#2f6fd6', '#9b5cff', '#f5f5f5', '#1b1e24', '#ff4fa3'];

export type ProfileMode = 'setup' | 'edit';

type Tab = 'driver' | 'car' | 'controls';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'driver', label: 'Driver' },
  { id: 'car', label: 'Car' },
  { id: 'controls', label: 'Controls' },
];
const CAMERAS = [
  { id: 'chase', label: 'Chase' },
  { id: 'far', label: 'Far' },
  { id: 'hood', label: 'Hood' },
] as const;

// Reopening the editor returns to the tab used last.
let lastTab: Tab = 'driver';
// A photo is being decoded and encoded; survives leaving the screen.
let busy = false;

/** The field shows the placeholder rather than the literal default name. */
const nameValue = (p: Profile): string => (p.name === DEFAULT_NAME ? '' : p.name);

const bodyInfo = (p: Profile) => CAR_BODIES.find((b) => b.id === p.carBody) ?? CAR_BODIES[0];

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
      <span class="hp-car"><span class="color-dot" style="background:${p.carColor}"></span>${esc(bodyInfo(p).name)}</span></span>
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

function carHtml(p: Profile): string {
  const colors = CAR_COLORS.includes(p.carColor) ? CAR_COLORS : [p.carColor, ...CAR_COLORS];
  const swatches = colors
    .map((c) => `<button class="swatch ${c === p.carColor ? 'sel' : ''}" style="background:${c}" data-act="color" data-c="${c}" aria-label="Colour ${c}"></button>`)
    .join('');
  const bodies = CAR_BODIES.map((b) => {
    const on = b.id === p.carBody;
    return `<button class="body-opt ${on ? 'sel' : ''}" data-act="body" data-b="${b.id}" role="radio" aria-checked="${on}" title="${esc(b.blurb)}"><svg viewBox="0 0 64 24" aria-hidden="true"><path d="${b.icon}"/><circle cx="16" cy="19" r="5"/><circle cx="46" cy="19" r="5"/></svg><span>${esc(b.name)}</span></button>`;
  }).join('');
  return `<div class="pf-label">Car colour</div>
    <div class="swatches pf-swatches">${swatches}</div>
    <div class="pf-label" id="pf-body-l">Body style</div>
    <div class="bodies" role="radiogroup" aria-labelledby="pf-body-l">${bodies}</div>
    <div class="body-note">${esc(CAR_BODY_NOTE)}</div>`;
}

// Toggles are buttons, not checkboxes, so a second-finger tap (pointerup routing in
// showScreen, which sends no click) works on them like on every other control.
const switchHtml = (k: string, label: string, on: boolean): string =>
  `<button class="pf-switch" data-act="switch" data-k="${k}" role="switch" aria-checked="${on}"><span class="pf-box" aria-hidden="true"></span><span>${label}</span></button>`;

function controlsHtml(app: App): string {
  const s = app.store.settings;
  const cams = CAMERAS.map(
    (c) => `<button class="btn small ${c.id === s.camera ? 'sel' : ''}" data-act="cam" data-cam="${c.id}" aria-pressed="${c.id === s.camera}">${c.label}</button>`,
  ).join('');
  return `<div class="pf-label" id="pf-cam-l">Start camera</div>
    <div class="seg" role="group" aria-labelledby="pf-cam-l">${cams}</div>
    <div class="pf-label">Driving</div>
    <div class="pf-switches">
      ${switchHtml('tilt', 'Tilt steering', s.tilt)}
      ${switchHtml('auto', 'Auto-accelerate', s.autoAccelerate)}
      ${switchHtml('badge', 'Photo above my car', app.store.profile.showBadge)}
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
    back();
  };
  const selectIn = (group: string, b: HTMLElement, aria: 'aria-pressed' | 'aria-checked' | 'aria-selected') =>
    el.querySelectorAll<HTMLElement>(group).forEach((x) => {
      x.classList.toggle('sel', x === b);
      x.setAttribute(aria, String(x === b));
    });
  const setSwitch = (b: HTMLElement, on: boolean) => b.setAttribute('aria-checked', String(on));

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
      selectIn('.body-opt', b, 'aria-checked');
      app.profileChanged('body');
    },
    cam: (b) => {
      const v = CAMERAS.find((c) => c.id === b.dataset.cam);
      if (!v) return;
      // No applySettings: it would also move the menu camera off 'far'. RaceMode reads it.
      s.camera = v.id;
      store.saveSettings();
      selectIn('.seg [data-act="cam"]', b, 'aria-pressed');
    },
    switch: (b) => {
      const on = b.getAttribute('aria-checked') !== 'true';
      switch (b.dataset.k) {
        case 'tilt': {
          // toggleTilt takes a checkbox: it unchecks it (and toasts) when sensors are denied.
          const t = document.createElement('input');
          t.type = 'checkbox';
          t.checked = on;
          setSwitch(b, on);
          void app.toggleTilt(t).then(() => setSwitch(b, t.checked));
          break;
        }
        case 'auto':
          s.autoAccelerate = on;
          app.input.autoAccelerate = on;
          store.saveSettings();
          setSwitch(b, on);
          break;
        case 'badge':
          p.showBadge = on;
          store.saveProfile();
          setSwitch(b, on);
          app.profileChanged('badge');
          break;
      }
    },
  });

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
