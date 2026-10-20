// A drag slider (role=slider) driven by pointer events: the tilt tuning and the Settings volume.
// Not <input type=range>: a native range ignores a second finger (Android sends no click for a
// tap made while another finger is down, and showScreen routes only [data-act] on pointerup), its
// thumb is small on a phone, and it jumps on a tap that only stops a scroll fling.
//
// The rules (bindSlider):
// - any pointer may grab it, the second finger too; only the first one is followed (captured);
// - grabbing the thumb keeps the grab offset, so it never jumps under the finger;
// - a touch waits, on the thumb as on the track: a mostly sideways move of 4 px starts a drag, a
//   mostly vertical one scrolls the screen (touch-action pan-y on the slider and its thumb; the
//   browser then cancels the pointer, and the value goes back to what it was), so a scroll swipe
//   that starts on the slider never changes or saves it. A tap on the track jumps on the native
//   click, which Chrome withholds for a tap that only stopped a fling; a tap on the thumb never
//   moves it (a fling stop there must not nudge it). A mouse or pen grabs the thumb or jumps at once;
// - input() runs on every change, change() once the value is settled (lift, key, tap);
// - no window listeners, so nothing is left behind when showScreen replaces the screen.
// The pure helpers are tested in tests/slider.test.ts.

import { esc } from './dom';

export interface SliderSpec {
  min: number;
  max: number;
  step: number;
}

export interface SliderHandlers {
  /** Every change while dragging or by key. */
  input?: (v: number) => void;
  /** The value settled on a new value: the finger lifted, a key or a tap set it. Save here. */
  change?: (v: number) => void;
  /** aria-valuetext for a value. */
  text?: (v: number) => string;
}

export interface SliderHandle {
  readonly value: number;
  /** Show a value set from outside (no input or change call). */
  set(v: number): void;
}

/** Thumb radius (px): its centre travels from this far inside one end of the slider to this far inside the other. */
export const THUMB_R = 12;
/** A press this close to the thumb's centre (px) grabs it where it is. */
export const GRAB_PX = 22;
/** A touch becomes a drag after this much sideways movement (px), when it is more sideways than vertical. */
export const DRAG_START_PX = 4;

/**
 * What a touch that has not started a drag does after moving (dx, dy) px: 'wait' while under
 * DRAG_START_PX, 'drag' when mostly sideways, 'scroll' when mostly vertical (the screen's, not the slider's).
 */
export function touchIntent(dx: number, dy: number): 'wait' | 'drag' | 'scroll' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax >= DRAG_START_PX && ax >= ay) return 'drag';
  if (ay >= DRAG_START_PX && ay > ax) return 'scroll';
  return 'wait';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The nearest step to `v` within the range, without float drift (0.1 + 0.2 stays 0.3). */
export function snapTo(v: number, s: SliderSpec): number {
  if (!Number.isFinite(v)) return s.min;
  const n = Math.round((clamp(v, s.min, s.max) - s.min) / s.step);
  return Number(Math.min(s.max, s.min + n * s.step).toFixed(6));
}

/** Where `v` sits along the range, 0..1. */
export function sliderFrac(v: number, s: SliderSpec): number {
  return s.max > s.min ? clamp((v - s.min) / (s.max - s.min), 0, 1) : 0;
}

/** The value under x, for a thumb that travels from `left` over `width` px. */
export function valueAtX(x: number, left: number, width: number, s: SliderSpec): number {
  const f = width > 0 ? clamp((x - left) / width, 0, 1) : 0;
  return snapTo(s.min + f * (s.max - s.min), s);
}

/** The value a key gives: arrows one step, Page Up/Down a tenth of the range, Home/End the ends; null for other keys. */
export function keyStep(key: string, v: number, s: SliderSpec): number | null {
  const big = Math.max(s.step, (s.max - s.min) / 10);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return snapTo(v + s.step, s);
    case 'ArrowLeft':
    case 'ArrowDown':
      return snapTo(v - s.step, s);
    case 'PageUp':
      return snapTo(v + big, s);
    case 'PageDown':
      return snapTo(v - big, s);
    case 'Home':
      return s.min;
    case 'End':
      return s.max;
    default:
      return null;
  }
}

export interface SliderHtmlOptions {
  /** id of the element that names it (aria-labelledby). */
  labelledBy: string;
  /** aria-valuetext. */
  text: string;
  id?: string;
  /** data-* attributes (names without the prefix). */
  data?: Record<string, string>;
}

/** The slider's markup at `value`. No data-act: showScreen never routes it, bindSlider drives it. */
export function sliderHtml(s: SliderSpec, value: number, o: SliderHtmlOptions): string {
  const v = snapTo(value, s);
  const data = Object.entries(o.data ?? {})
    .map(([k, x]) => ` data-${k}="${esc(x)}"`)
    .join('');
  return `<div class="vb-slider" role="slider" tabindex="0"${o.id ? ` id="${esc(o.id)}"` : ''} aria-labelledby="${esc(o.labelledBy)}" aria-valuemin="${s.min}" aria-valuemax="${s.max}" aria-valuenow="${v}" aria-valuetext="${esc(o.text)}" style="--p:${sliderFrac(v, s).toFixed(4)}"${data}><span class="vs-track"><span class="vs-fill"></span></span><span class="vs-thumb"></span></div>`;
}

/**
 * Drive a sliderHtml element. Null-safe (null in, null out). Binding only adds listeners: the
 * markup already shows `value`.
 */
export function bindSlider(el: HTMLElement | null, s: SliderSpec, value: number, h: SliderHandlers = {}): SliderHandle | null {
  if (!el) return null;
  let v = snapTo(value, s);
  /** The pointer being followed, the value it started from, and how it is being handled. */
  let pid: number | null = null;
  let startV = v;
  let startX = 0;
  let startY = 0;
  let grab = 0;
  let dragging = false;
  /** The followed touch turned out to be a vertical swipe: it is the screen's scroll, not a drag. */
  let scrolling = false;
  /** The followed touch began on the thumb: a tap there never jumps. */
  let onThumb = false;
  /** A touch lifted from the track without dragging: its native click (if Chrome sends one) jumps. */
  let tapPending = false;

  const travel = () => {
    const r = el.getBoundingClientRect();
    return { left: r.left + THUMB_R, width: Math.max(1, r.width - 2 * THUMB_R) };
  };
  const thumbX = () => {
    const t = travel();
    return t.left + sliderFrac(v, s) * t.width;
  };
  const paint = () => {
    el.style.setProperty('--p', sliderFrac(v, s).toFixed(4));
    el.setAttribute('aria-valuenow', String(v));
    if (h.text) el.setAttribute('aria-valuetext', h.text(v));
  };
  const setValue = (nv: number) => {
    const n = snapTo(nv, s);
    if (n === v) return;
    v = n;
    paint();
    h.input?.(v);
  };
  const toX = (x: number) => {
    const t = travel();
    setValue(valueAtX(x - grab, t.left, t.width, s));
  };
  const end = (keep: boolean) => {
    pid = null;
    dragging = false;
    el.classList.remove('dragging');
    if (!keep) setValue(startV);
    else if (v !== startV) h.change?.(v);
  };

  el.addEventListener('pointerdown', (e) => {
    if (pid !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pid = e.pointerId;
    startV = v;
    startX = e.clientX;
    startY = e.clientY;
    grab = 0;
    tapPending = false;
    scrolling = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; its pointerup won't come.
    }
    const off = e.clientX - thumbX();
    onThumb = Math.abs(off) <= GRAB_PX;
    if (onThumb) {
      // Held where it was grabbed. A touch still waits for a sideways move: it may be a scroll.
      grab = off;
      dragging = e.pointerType !== 'touch';
    } else if (e.pointerType !== 'touch') {
      dragging = true;
      toX(e.clientX);
    }
    if (dragging) el.classList.add('dragging');
    // A mouse click focuses it for the arrow keys; a touch gets no focus ring.
    if (e.pointerType === 'mouse') el.focus({ preventScroll: true });
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid || scrolling) return;
    if (!dragging) {
      const intent = touchIntent(e.clientX - startX, e.clientY - startY);
      if (intent === 'wait') return;
      if (intent === 'scroll') {
        // The screen's scroll (the browser cancels the pointer once it pans): never the slider's.
        scrolling = true;
        return;
      }
      dragging = true;
      el.classList.add('dragging');
    }
    toX(e.clientX);
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pid) return;
    tapPending = !dragging && !scrolling && !onThumb && e.pointerType === 'touch';
    end(true);
  });
  // The browser took the touch (a vertical scroll), or the system did: put the value back, save nothing.
  el.addEventListener('pointercancel', (e) => {
    if (e.pointerId === pid) end(false);
  });
  el.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === pid) end(true);
  });
  el.addEventListener('click', (e) => {
    if (!tapPending) return;
    tapPending = false;
    const before = v;
    const t = travel();
    setValue(valueAtX(e.clientX, t.left, t.width, s));
    if (v !== before) h.change?.(v);
  });
  el.addEventListener('keydown', (e) => {
    const n = keyStep(e.key, v, s);
    if (n === null) return;
    e.preventDefault();
    const before = v;
    setValue(n);
    if (v !== before) h.change?.(v);
  });
  // No long-press menu (and its buzz) on a held thumb. Nothing calls preventDefault on touchstart:
  // that would also stop a vertical swipe starting on the thumb from scrolling the screen.
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    get value() {
      return v;
    },
    set(nv: number) {
      v = snapTo(nv, s);
      paint();
    },
  };
}
