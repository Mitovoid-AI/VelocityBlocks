// In-race heads-up display.

import { formatTime } from '../game/race';
import { MEDAL_COLORS, MEDAL_NAMES, type MedalTimes } from '../game/medals';
import { $, esc } from './dom';

export class Hud {
  private el = $('#hud');
  private time = $('#hud-time');
  private speed = $('#hud-speed');
  private cp = $('#hud-cp');
  private pb = $('#hud-pb');
  private track = $('#hud-track');
  private target = $('#hud-target');
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

  show(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  setTrack(name: string, best: number | null, medals: MedalTimes | null, checkpoints: number): void {
    this.track.textContent = name;
    const m = medals;
    this.target.innerHTML = m
      ? [4, 3, 2, 1]
          .map((n) => {
            const t = n === 4 ? m.author : n === 3 ? m.gold : n === 2 ? m.silver : m.bronze;
            return `<span class="medal" style="background:${MEDAL_COLORS[n]}" title="${MEDAL_NAMES[n]}"></span>${formatTime(t)}`;
          })
          .join('&nbsp;&nbsp;')
      : '<span class="muted">No author time yet</span>';
    this.pb.textContent = best !== null ? `PB ${formatTime(best)}` : 'No personal best';
    this.setCheckpoints(0, checkpoints);
    this.split.classList.remove('show');
    this.msg.classList.remove('show');
    this.flipWarning(null);
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
    this.boost.style.width = `${Math.round(Math.min(1, boost) * 100)}%`;
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
