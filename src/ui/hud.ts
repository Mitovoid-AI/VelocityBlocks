// In-race heads-up display.

import { formatTime } from '../game/race';
import type { MedalTimes } from '../game/medals';
import { $, esc } from './dom';
import { authorRevealed, targetsHtml } from './medalUi';
import type { NitroView } from './nitroView';

export class Hud {
  private el = $('#hud');
  private time = $('#hud-time');
  private speed = $('#hud-speed');
  private cp = $('#hud-cp');
  private pb = $('#hud-pb');
  private track = $('#hud-track');
  private target = $('#hud-target');
  private tags = $('#hud-tags');
  private count = $('#hud-count');
  private split = $('#hud-split');
  private msg = $('#hud-msg');
  private boost = $('#hud-boost-bar');
  private flip = $('#hud-flip');
  private flipText = $('#hud-flip-text');
  private flipFill = $('#hud-flip-fill');
  private flipShown = false;
  private flipLabel = '';
  private flipPct = -1;
  private splitTimer = 0;
  private msgTimer = 0;
  private lastTime = '';
  private lastSpeed = '';
  private lastBoost = -1;
  /** The nitro's two faces: the HUD ring (keys, controller) and the touch button, which carries its own ring. */
  private nitroEls = [$('#hud-nitro'), $('#touch .t-nitro')].filter((x): x is HTMLElement => !!x);
  private nitroKey = '';
  private tiltBar = $('#hud-tilt');
  private tiltX = '';

  show(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  /**
   * The race's top-left lines: track name, the medal targets (the author target stays a "?" until
   * `best` has beaten it), then read-only `tags` such as the vehicle class or "Walls". The tags get a
   * line of their own: after a long name they would reach the race pills at 640 px.
   */
  setTrack(name: string, best: number | null, medals: MedalTimes | null, checkpoints: number, tags: readonly string[] = []): void {
    this.track.textContent = name;
    this.target.innerHTML = targetsHtml(medals, authorRevealed(best, medals));
    this.tags.innerHTML = tags.map((t) => `<span class="hud-chip">${esc(t)}</span>`).join('');
    this.pb.textContent = best !== null ? `PB ${formatTime(best)}` : 'No personal best';
    this.setCheckpoints(0, checkpoints);
    this.split.classList.remove('show');
    this.msg.classList.remove('show');
    this.flipWarning(null);
    this.nitroKey = '';
  }

  /**
   * The nitro: ready (full ring, glowing), boosting (the ring empties with the push) or recharging
   * (the ring fills over the 6 s with the seconds left in it); `armed` glows brighter for a press in
   * the 3-2-1. Called every frame, so it only writes on change.
   */
  nitro(v: NitroView, armed: boolean): void {
    // The ring in 2% steps: finer is invisible on a 26-64 px ring, and each change repaints its gradient.
    const p = Math.round(v.p * 50) / 50;
    const key = `${v.state}|${p}|${v.secondsLeft}|${armed}`;
    if (key === this.nitroKey) return;
    this.nitroKey = key;
    for (const el of this.nitroEls) {
      el.classList.toggle('n-ready', v.state === 'ready');
      el.classList.toggle('n-boost', v.state === 'boosting');
      el.classList.toggle('n-charge', v.state === 'recharging');
      el.classList.toggle('n-armed', armed);
      el.style.setProperty('--p', p.toFixed(2));
      const sec = el.querySelector('.n-sec');
      const text = v.secondsLeft ? String(v.secondsLeft) : '';
      if (sec && sec.textContent !== text) sec.textContent = text;
    }
  }

  /** The nitro has recharged: a short pop. */
  nitroPop(): void {
    this.flash('pop');
  }

  /** Pressed while recharging: a short shake. */
  nitroDeny(): void {
    this.flash('deny');
  }

  /** Restart a one-shot animation (the other one's class goes, or its rule would win). */
  private flash(cls: 'pop' | 'deny'): void {
    for (const el of this.nitroEls) {
      el.classList.remove('pop', 'deny');
      void el.offsetWidth;
      el.classList.add(cls);
    }
  }

  /** The tilt bar under the timer: steering -1..1 from straight ahead, or null to hide it. Only writes on change. */
  tilt(v: number | null): void {
    if (!this.tiltBar) return;
    const x = v === null ? '' : Math.max(-1, Math.min(1, v)).toFixed(2);
    if (x === this.tiltX) return;
    if ((x === '') !== (this.tiltX === '')) this.tiltBar.classList.toggle('hidden', x === '');
    this.tiltX = x;
    if (x) this.tiltBar.style.setProperty('--x', x);
  }

  setCheckpoints(taken: number, total: number): void {
    this.cp.textContent = total ? `CP ${taken}/${total}` : '';
  }

  frame(timeMs: number, speedKmh: number, boost: number): void {
    const t = formatTime(timeMs);
    if (t !== this.lastTime) {
      this.time.textContent = t;
      this.lastTime = t;
    }
    const s = String(Math.round(speedKmh));
    if (s !== this.lastSpeed) {
      this.speed.textContent = s;
      this.lastSpeed = s;
    }
    // Written only on change: an unchanged inline style still costs a style recalc on some WebViews.
    const b = Math.round(Math.min(1, Math.max(0, boost)) * 100);
    if (b !== this.lastBoost) {
      this.boost.style.width = `${b}%`;
      this.lastBoost = b;
    }
  }

  countdown(text: string): void {
    this.count.textContent = text;
    this.count.classList.remove('pop');
    void this.count.offsetWidth;
    this.count.classList.add('pop');
  }

  showSplit(time: number, diff: number | null): void {
    const d =
      diff === null
        ? ''
        : ` <span class="${diff <= 0 ? 'ahead' : 'behind'}">${esc(formatTime(diff, true))}</span>`;
    this.split.innerHTML = `${esc(formatTime(time))}${d}`;
    this.split.classList.add('show');
    window.clearTimeout(this.splitTimer);
    this.splitTimer = window.setTimeout(() => this.split.classList.remove('show'), 2600);
  }

  message(text: string, ms = 1800): void {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.msg.classList.remove('show'), ms);
  }

  clearMessages(): void {
    this.split.classList.remove('show');
    this.msg.classList.remove('show');
    this.count.classList.remove('pop');
    this.flipWarning(null);
  }

  /** Flipped-car warning: bar fill 0..1, or null to hide. Called every frame, so it only writes on change. */
  flipWarning(progress: number | null, toStart = false): void {
    if (progress === null) {
      if (this.flipShown) {
        this.flip.classList.remove('show');
        this.flipShown = false;
      }
      return;
    }
    const label = toStart ? 'Flipped! Restarting' : 'Flipped! Respawning';
    if (label !== this.flipLabel) {
      this.flipText.textContent = label;
      this.flipLabel = label;
    }
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (pct !== this.flipPct) {
      this.flipFill.style.transform = `scaleX(${pct / 100})`;
      this.flipPct = pct;
    }
    if (!this.flipShown) {
      this.flip.classList.add('show');
      this.flipShown = true;
    }
  }
}
