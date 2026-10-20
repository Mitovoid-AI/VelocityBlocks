// The results card on the page: applies ScoreClock's cues to the markup from scoreCardHtml.
// Thin on purpose (tests mock it); what to show and when lives in scoreCard.ts. Everything that
// leaves its box (the ring, the confetti) goes in .sc-fx, which is clipped to the screen, so the
// effects can never make the screen scroll.

import {
  AUTHOR_CONFETTI,
  CONFETTI,
  confettiSpecs,
  type Cue,
  type ScoreModel,
  type ScoreView,
} from './scoreCard';

export class ScoreCardView implements ScoreView {
  private lastTime = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly m: ScoreModel,
    /** Quality low or medium: half the confetti. */
    private readonly opts: { lowFx: boolean },
  ) {}

  private q(sel: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(sel);
  }

  time(text: string): void {
    if (text === this.lastTime) return;
    this.lastTime = text;
    const el = this.q('.sc-time');
    if (el) el.textContent = text;
  }

  authorTime(text: string): void {
    const el = this.q('.sc-slot.m4 .sc-t');
    if (el) el.textContent = text;
  }

  cue(c: Cue, instant: boolean): void {
    if (instant) this.q('.score')?.classList.add('sc-done');
    switch (c.kind) {
      case 'delta':
      case 'banner':
        this.q(`.sc-${c.kind}`)?.classList.add('on');
        break;
      case 'headline':
        this.root.querySelectorAll('.sc-headline, .sc-hint').forEach((x) => x.classList.add('on'));
        break;
      case 'medal':
        this.q(`.sc-slot.m${c.n}`)?.classList.add('on');
        break;
      case 'charge':
        this.q('.sc-slot.m4')?.classList.add('charge');
        break;
      case 'author': {
        const s = this.q('.sc-slot.m4');
        if (!s) break;
        s.classList.remove('secret');
        s.classList.add('on');
        s.setAttribute('aria-label', `Author ${this.m.revealTime}, earned`);
        if (!instant) {
          this.burst(s.querySelector<HTMLElement>('.sc-disc') ?? s, 'ring');
          navigator.vibrate?.([30, 60, 30]);
        }
        break;
      }
      case 'confetti':
        if (instant) break;
        if (c.big) this.burst(this.q('.sc-slot.m4 .sc-disc'), 'author');
        else this.burst(this.q('.sc-banner') ?? this.q('.sc-time'), 'confetti');
        break;
    }
  }

  /** From the centre of `anchor`: the author reveal's ring, or a confetti burst (the author's is bigger and cyan). */
  private burst(anchor: HTMLElement | null, kind: 'ring' | 'confetti' | 'author'): void {
    const fx = this.q('.sc-fx');
    if (!anchor || !fx) return;
    const a = anchor.getBoundingClientRect();
    const f = fx.getBoundingClientRect();
    const x = Math.round(a.left + a.width / 2 - f.left);
    const y = Math.round(a.top + a.height / 2 - f.top);
    if (kind === 'ring') {
      // .sc-fx is outside the slot, so the slot's --s is set on the ring itself.
      fx.insertAdjacentHTML('beforeend', `<i class="ring" style="left:${x}px;top:${y}px;--s:${Math.round(a.width)}px"></i>`);
      return;
    }
    const big = kind === 'author';
    const count = big ? 44 : 28;
    const n = this.opts.lowFx ? Math.ceil(count / 2) : count;
    const spread = Math.min(innerWidth, innerHeight) * 0.45;
    const html = confettiSpecs(n, Date.now() | 0, big ? AUTHOR_CONFETTI : CONFETTI, spread)
      .map(
        (p) =>
          `<i style="left:${x}px;top:${y}px;--dx:${p.dx.toFixed(0)}px;--up:${p.up.toFixed(0)}px;--fall:${p.fall.toFixed(0)}px;--r:${p.r.toFixed(0)}deg;--c:${p.c};--d:${p.d}ms;--t:${p.t}ms"></i>`,
      )
      .join('');
    fx.insertAdjacentHTML('beforeend', html);
  }

  finish(skipped: boolean): void {
    if (skipped) this.q('.score')?.classList.add('sc-done');
    const fx = this.q('.sc-fx');
    if (fx) fx.textContent = '';
    const live = this.q('.sr-only');
    if (live) live.textContent = this.m.summary;
  }
}
