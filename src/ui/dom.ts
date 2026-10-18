// Small DOM helpers for the menu screens.

import { saveTextFile } from '../platform/native';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let touchActAt = -1e9;

/** Replace the current screen. Handlers map `data-act` values to callbacks. */
export function showScreen(html: string, cls: string, handlers: Record<string, (el: HTMLElement) => void>): HTMLElement {
  const host = $('#screens');
  host.innerHTML = '';
  const s = document.createElement('div');
  s.className = `screen ${cls}`;
  s.innerHTML = html;
  host.appendChild(s);
  const actTarget = (n: EventTarget | null): HTMLElement | null => {
    const t = n instanceof Element ? n.closest<HTMLElement>('[data-act]') : null;
    return t && s.contains(t) && !(t as HTMLButtonElement).disabled ? t : null;
  };
  const run = (t: HTMLElement | null) => {
    const fn = t && handlers[t.dataset.act!];
    if (fn) fn(t);
  };
  // Android sends no `click` for a tap made while another finger is down, e.g. a thumb still
  // resting on the gas pad when the pause or results screen appears. Such a tap (a
  // non-primary touch) activates on pointerup over the control it started on; ordinary
  // single-finger taps keep the native click, which already ignores fling-stops and scrolls.
  const pressed = new Map<number, HTMLElement>();
  let swallowTouchEnd = false;
  s.addEventListener('pointerdown', (e) => {
    const t = e.pointerType === 'touch' && !e.isPrimary ? actTarget(e.target) : null;
    if (t) pressed.set(e.pointerId, t);
  });
  s.addEventListener('pointercancel', (e) => pressed.delete(e.pointerId));
  s.addEventListener('pointerup', (e) => {
    const t = pressed.get(e.pointerId);
    pressed.delete(e.pointerId);
    if (!t || actTarget(document.elementFromPoint(e.clientX, e.clientY)) !== t) return;
    touchActAt = performance.now();
    swallowTouchEnd = true;
    // The tap never moves focus, so close the keyboard of a text field left focused.
    const focused = document.activeElement as HTMLElement | null;
    if (focused !== t && (focused?.tagName === 'INPUT' || focused?.tagName === 'TEXTAREA')) focused.blur();
    run(t);
  });
  // Cancelling the touchend stops the compatibility click from landing on whatever the
  // handler has just put under the finger (a checkbox on the next screen, say).
  s.addEventListener(
    'touchend',
    (e) => {
      if (!swallowTouchEnd) return;
      swallowTouchEnd = false;
      e.preventDefault();
    },
    { passive: false },
  );
  s.addEventListener('click', (e) => {
    // Skip the click a touch tap may still produce; programmatic clicks (Android Back) pass.
    if (e.isTrusted && performance.now() - touchActAt < 600) return;
    run(actTarget(e.target));
  });
  // Focus helps keyboard users; after a touch tap it would only draw a focus ring.
  if (performance.now() - touchActAt > 1000) {
    const first = s.querySelector<HTMLElement>('.btn.primary, .btn, .card');
    first?.focus({ preventScroll: true });
  }
  return s;
}

export function clearScreen(): void {
  $('#screens').innerHTML = '';
}

let toastTimer = 0;
export function toast(msg: string, ms = 2200): void {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), ms);
}

/** Save text as a file for the user. */
export function downloadText(name: string, text: string): void {
  // Android WebView silently drops <a download> (Capacitor sets no DownloadListener), so the
  // app saves through the OS "Save as" screen instead.
  saveTextFile(name, text).then(
    (r) => {
      if (r === 'unsupported') downloadViaLink(name, text);
      else if (r === 'saved') toast(`Saved ${name}`);
    },
    (e: Error) => toast(`Export failed: ${e.message}`, 3200),
  );
}

function downloadViaLink(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user for a file and read it as text. */
export function pickTextFile(accept = '.json,.vbtrack,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > 2_000_000) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

// Strong reference so the detached input isn't collected before its 'change' fires.
let activePicker: HTMLInputElement | null = null;
let pickerOpenedAt = -1e9;

/**
 * Ask the user for an image. With `capture` Capacitor opens the camera app instead of the
 * gallery (the facing hint is ignored on Android). Call it from a data-act handler: a click
 * and a second-finger pointerup both carry the user activation the chooser needs.
 */
export function pickImageFile(capture?: 'user' | 'environment'): Promise<File | null> {
  // A double tap would open two choosers, and on WebView 110 a cancelled one never settles.
  const now = performance.now();
  if (now - pickerOpenedAt < 1500) return Promise.resolve(null);
  pickerOpenedAt = now;
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', capture);
    const done = (f: File | null) => {
      if (activePicker === input) activePicker = null;
      resolve(f);
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    // Chrome 113+ only; older WebViews just never resolve a cancelled pick (no state is held).
    input.addEventListener('cancel', () => done(null));
    activePicker = input;
    input.click();
  });
}
