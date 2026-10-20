// The results card after a finish: what it says (the model), when each part appears (the cue
// timeline), its markup, and the clock that plays the timeline. Pure: no DOM access, so all of it
// is unit-tested; src/ui/scoreCardView.ts applies the cues to the page.
//
// The card counts the time up, fills the medal slots (bronze, silver, gold, author) one after
// another, then shows the headline and a record banner, with confetti for a new best or a new
// medal tier. The author slot stays a "?" with ?:??.?? until the author time is beaten on that
// track; the run that beats it plays the reveal (charge, flip, the time locking in from the left
// and a bigger burst). A plain repeat run (no new best, no new medal) gets the quiet version.

import { formatTime } from '../game/race';
import { medalFor, medalTimes, MEDAL_COLORS, MEDAL_NAMES, type MedalTimes } from '../game/medals';
import { esc } from './dom';
import { medalTime, SECRET_TIME } from './medalUi';

export interface ScoreInput {
  label: string;
  /** Read-only tags under the track name: the vehicle class, "Walls on". */
  tags: readonly string[];
  time: number;
  /** The best before this run; null on a first finish. */
  previous: number | null;
  improved: boolean;
  /**
   * The medal times as they were BEFORE this finish (null: no author time yet). An editor test drive
   * may have just set or lowered the author time; the card judges the run against the old one.
   */
  medals: MedalTimes | null;
  /** An editor test drive set the author time (first one) or lowered it, to this. */
  newAuthor: number | null;
  /** A line under the hint (a walls-on test drive: AUTHOR_WALLS_NOTE), or ''. */
  note: string;
  respawns: number;
  hasNext: boolean;
  fromEditor: boolean;
}

export type CueKind = 'delta' | 'medal' | 'charge' | 'author' | 'confetti' | 'headline' | 'banner';

/** One step of the reveal, `at` ms after the card appears. */
export interface Cue {
  at: number;
  kind: CueKind;
  /** Medal slot (1 bronze .. 4 author) of a 'medal' cue. */
  n?: number;
  /** The author reveal's burst (bigger, cyan, from the author slot). */
  big?: boolean;
}

export interface Slot {
  n: 1 | 2 | 3 | 4;
  time: number;
  /** This run's time is inside the slot's target. */
  hit: boolean;
  /** Won for the first time by this run (NEW tag). */
  fresh: boolean;
  /** Held from an earlier run but missed by this one (outlined, not filled). */
  best: boolean;
  /** The author slot before the author time is beaten: "?" and ?:??.??. */
  secret: boolean;
  /** The author slot of a test drive that set the author time (SET tag, no reveal). */
  set: boolean;
}

export interface ScoreModel {
  input: ScoreInput;
  /** Medal of this run and of the best before it, against the medals the card shows. */
  medal: number;
  prevMedal: number;
  slots: Slot[];
  /** The secret author medal is won by this run: the reveal plays. */
  authorNew: boolean;
  /** The author time the reveal locks in (formatted), '' without a reveal. */
  revealTime: string;
  headline: string;
  hint: string;
  /** "New author time 0:13.90" when a test drive lowered a time it also revealed, else ''. */
  authorLine: string;
  banner: 'record' | 'first' | null;
  /** 0 none, 1 a burst from the banner (new best, new medal tier), 2 the author reveal's. */
  confetti: 0 | 1 | 2;
  /** A repeat run with nothing new: a short count-up, no medal fanfare. */
  quiet: boolean;
  /** Length of the time's count-up (ms). */
  countMs: number;
  cues: Cue[];
  /** When the card is settled and its particles are gone (ms). */
  endMs: number;
  /** Read out once at the end (aria-live). */
  summary: string;
}

/** Timeline, in ms. The visible sequence of an author reveal ends near 3.4 s, its particles near 4.3 s. */
export const COUNT_MS = 800;
export const QUIET_COUNT_MS = 250;
export const MEDAL_GAP = 320;
export const REVEAL_MS = 360;
/** Longest life of a confetti particle (delay + flight): the clock keeps the burst on screen this long. */
export const FX_MS = 1700;

export function scoreModel(i: ScoreInput): ScoreModel {
  const old = i.medals;
  // A test drive that sets the first author time, or lowers one the player could already see:
  // there is no secret to reveal, so the slots show the new time with a SET tag.
  const setting = i.newAuthor !== null && (old === null || medalFor(i.previous, old) === 4);
  const m = setting ? medalTimes(i.newAuthor!) : old;
  const medal = medalFor(i.time, m);
  const prevMedal = setting ? 0 : medalFor(i.previous, m);
  const authorShown = prevMedal >= 4;
  const authorNew = !setting && medal === 4 && !authorShown;
  const slots: Slot[] = m
    ? ([1, 2, 3, 4] as const).map((n) => ({
        n,
        time: medalTime(m, n),
        hit: medal >= n,
        fresh: !setting && n > prevMedal && n <= medal,
        best: n <= prevMedal && n > medal,
        secret: n === 4 && !setting && !authorShown,
        set: setting && n === 4,
      }))
    : [];
  const quiet = !setting && i.previous !== null && !i.improved && medal <= prevMedal;
  const banner = i.previous === null ? 'first' : i.improved ? 'record' : null;
  const confetti: 0 | 1 | 2 = authorNew ? 2 : !quiet && ((i.improved && i.previous !== null) || (!setting && medal > prevMedal)) ? 1 : 0;

  let headline: string;
  let hint = '';
  if (setting) {
    headline = old ? 'New author time' : 'Author time set';
    hint = old ? `Was ${formatTime(old.author)}` : 'Others see it once they beat it';
  } else if (!m) {
    headline = 'Finished';
    hint = 'No author time yet';
  } else if (medal === 4) {
    headline = authorNew ? 'Author medal!' : 'Author medal';
    hint = authorNew ? 'You beat the author time' : '';
  } else {
    headline = medal ? `${MEDAL_NAMES[medal]} medal${medal > prevMedal ? ' earned!' : ''}` : 'No medal';
    const next = medal + 1;
    // Never the author time unless it is already shown.
    hint =
      medal < prevMedal
        ? `Your best: ${MEDAL_NAMES[prevMedal]} medal`
        : next === 4
          ? authorShown
            ? `Next: Author ${formatTime(m.author)}`
            : 'Next: beat the secret author time'
          : `Next: ${MEDAL_NAMES[next]} ${formatTime(medalTime(m, next))}`;
  }
  const authorLine = !setting && i.newAuthor !== null ? `New author time ${formatTime(i.newAuthor)}` : '';
  const revealTime = authorNew ? formatTime(m!.author) : '';

  const countMs = quiet ? QUIET_COUNT_MS : COUNT_MS;
  const cues: Cue[] = [];
  let t = countMs + 50;
  let fxEnd = 0;
  cues.push({ at: t, kind: 'delta' });
  t += 150;
  if (!quiet) {
    // Bronze, silver, gold (and a held or just-set author medal) land one after another.
    const plain = Math.min(medal, authorNew ? 3 : 4);
    for (let n = 1; n <= plain; n++) {
      cues.push({ at: t, kind: 'medal', n });
      t += MEDAL_GAP;
    }
    if (authorNew) {
      cues.push({ at: t + 60, kind: 'charge' });
      t += 620;
      cues.push({ at: t, kind: 'author' }, { at: t + 60, kind: 'confetti', big: true });
      fxEnd = t + 60 + FX_MS;
      t += 520;
    }
  }
  cues.push({ at: t, kind: 'headline' });
  t += 150;
  if (banner) {
    cues.push({ at: t, kind: 'banner' });
    if (confetti === 1) {
      cues.push({ at: t + 60, kind: 'confetti' });
      fxEnd = t + 60 + FX_MS;
    }
    t += 200;
  }
  const summary = `${formatTime(i.time)}. ${headline}.${banner === 'record' ? ' New record.' : ''}${
    authorNew ? ` Author time ${revealTime}.` : ''
  }${authorLine ? ` ${authorLine}.` : ''}`;
  return {
    input: i,
    medal,
    prevMedal,
    slots,
    authorNew,
    revealTime,
    headline,
    hint,
    authorLine,
    banner,
    confetti,
    quiet,
    countMs,
    cues,
    endMs: Math.max(t + (quiet ? 200 : 600), fxEnd),
    summary,
  };
}

function slotHtml(s: Slot, quiet: boolean): string {
  const name = MEDAL_NAMES[s.n];
  const cls = `sc-slot m${s.n}${s.hit ? ' hit' : ''}${s.fresh ? ' fresh' : ''}${s.best ? ' best' : ''}${s.secret ? ' secret' : ''}${
    s.set ? ' set' : ''
  }${quiet && s.hit ? ' on' : ''}`;
  const label = s.secret ? 'Secret author medal' : `${name} ${formatTime(s.time)}${s.hit ? ', earned' : s.best ? ', your best' : ''}`;
  const tag = s.fresh ? '<span class="sc-new">NEW</span>' : s.set ? '<span class="sc-new">SET</span>' : '';
  return `<div class="${cls}" style="--c:${MEDAL_COLORS[s.n]}" role="listitem" aria-label="${label}">
      <div class="sc-disc"><div class="sc-fill"></div>${s.n === 4 ? '<div class="sc-q">?</div>' : ''}</div>
      <div class="sc-t">${s.secret ? SECRET_TIME : formatTime(s.time)}</div>${tag}
    </div>`;
}

/**
 * The card's markup. With `animate` the parts that cues bring in start hidden (.sc-anim) and the
 * time starts at 0:00.00; without it, it is the final state apart from the author reveal (which
 * ScoreClock.skip applies). A secret author time is never in it: the view writes it at the reveal.
 * Every button exists and works from the first frame; a tap anywhere else on the card skips.
 */
export function scoreCardHtml(sm: ScoreModel, animate: boolean): string {
  const i = sm.input;
  const delta =
    i.previous === null
      ? '<div class="sc-delta ahead">First finish!</div>'
      : `<div class="sc-delta ${i.time <= i.previous ? 'ahead' : 'behind'}">${esc(formatTime(i.time - i.previous, true))} vs PB ${esc(formatTime(i.previous))}</div>`;
  const banner = sm.banner ? `<div class="sc-banner ${sm.banner}">${sm.banner === 'record' ? 'NEW RECORD' : 'FIRST FINISH'}</div>` : '';
  const tags = i.tags.map((t) => ` <span class="chip">${esc(t)}</span>`).join('');
  const lines = [
    sm.hint && `<div class="sc-hint muted">${esc(sm.hint)}</div>`,
    sm.authorLine && `<div class="sc-hint sc-author-line">${esc(sm.authorLine)}</div>`,
    i.note && `<div class="sc-hint muted">${esc(i.note)}</div>`,
  ].join('');
  const gold = sm.medal === 4 || sm.slots.some((s) => s.set);
  return `<div class="sc-wrap" data-act="skip">
    <div class="sc-fx" aria-hidden="true"></div>
    <div class="panel score${animate ? ' sc-anim' : ''}${sm.quiet ? ' sc-quiet' : ''}">
      ${banner}
      <div class="sc-track muted">${esc(i.label)}${tags}</div>
      <div class="sc-main">
        <div class="sc-left">
          <div class="sc-time">${formatTime(animate ? 0 : i.time)}</div>
          ${delta}
          <div class="sc-headline${gold ? ' author' : ''}">${esc(sm.headline)}</div>
          ${lines}
          ${i.respawns ? `<div class="sc-resp muted">Respawns: ${i.respawns}</div>` : ''}
        </div>
        ${sm.slots.length ? `<div class="sc-medals" role="list">${sm.slots.map((s) => slotHtml(s, sm.quiet)).join('')}</div>` : ''}
      </div>
      <div class="row sc-actions">
        <button class="btn primary center" data-act="retry">Retry</button>
        <button class="btn center" data-act="replay">Watch replay</button>
        ${i.hasNext ? '<button class="btn center" data-act="next">Next track</button>' : ''}
        <button class="btn center" data-act="menu">${i.fromEditor ? 'Editor' : 'Menu'}</button>
      </div>
      <div class="sr-only" aria-live="polite"></div>
    </div>
  </div>`;
}

/** The time counting up: fast at first, easing into the final value, always on the 10 ms grid. */
export function countUp(time: number, p: number): number {
  if (p >= 1) return time;
  const q = Math.max(0, p);
  return Math.round((time * (1 - (1 - q) ** 3)) / 10) * 10;
}

/** The author time locking in from the left: ?:??.?? -> 0:??.?? -> 0:1?.?? -> ... -> 0:13.90 (never a wrong digit). */
export function revealTime(final: string, p: number): string {
  if (p >= 1) return final;
  const digits = [...final].filter((c) => c >= '0' && c <= '9').length;
  let k = Math.floor(Math.max(0, p) * digits);
  return [...final].map((c) => (c < '0' || c > '9' ? c : k-- > 0 ? c : '?')).join('');
}

export interface Particle {
  /** Sideways travel, rise (negative is up) and fall (px), spin (deg). */
  dx: number;
  up: number;
  fall: number;
  r: number;
  /** Colour from the palette. */
  c: string;
  /** Delay and duration (ms); d + t <= FX_MS. */
  d: number;
  t: number;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A burst of `count` confetti pieces thrown upwards and outwards over `spread` px (deterministic per seed). */
export function confettiSpecs(count: number, seed: number, palette: readonly string[], spread: number): Particle[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, () => {
    const a = Math.PI * (0.1 + rnd() * 0.8);
    const v = spread * (0.45 + rnd() * 0.55);
    return {
      dx: Math.cos(a) * v,
      up: -Math.sin(a) * v * 0.8,
      fall: spread * (0.6 + rnd() * 0.6),
      r: (rnd() * 2 - 1) * 540,
      c: palette[Math.floor(rnd() * palette.length)] ?? '#ffffff',
      d: Math.round(rnd() * 120),
      t: Math.round(900 + rnd() * 500),
    };
  });
}

export const CONFETTI = ['#ff6a3d', '#ffcf3f', '#3fe0ff', '#ffffff', '#7dff9a'] as const;
export const AUTHOR_CONFETTI = ['#3fe0ff', '#bff6ff', '#ffffff', '#7f9bff'] as const;

/** What ScoreClock drives: the page (ScoreCardView) or a test's recorder. */
export interface ScoreView {
  /** The counting time. */
  time(text: string): void;
  /** The author slot's time while it locks in. */
  authorTime(text: string): void;
  /** Apply a cue; `instant` (a skip) means its final state with no motion, sound or particles. */
  cue(c: Cue, instant: boolean): void;
  /** The card has settled (naturally, or `skipped`): stop every animation, drop particles, read the summary out. */
  finish(skipped: boolean): void;
}

/**
 * Plays a model's timeline on a view. Driven from RaceMode.update, so it pauses with the game loop
 * (under an ad, in the background). `sfx` is called for each cue played in time, never on a skip.
 */
export class ScoreClock {
  private t = 0;
  private next = 0;
  private revealAt = -1;
  private ended = false;

  constructor(
    private readonly m: ScoreModel,
    private readonly view: ScoreView,
    private readonly sfx: (c: Cue) => void = () => {},
  ) {}

  /** The timeline has finished or was skipped. */
  get done(): boolean {
    return this.ended;
  }

  update(dt: number): void {
    if (this.ended) return;
    // Capped like the game loop's dt, so a long frame cannot jump the whole reveal.
    this.t += Math.min(Math.max(0, dt), 0.1) * 1000;
    const { m, view } = this;
    view.time(formatTime(countUp(m.input.time, this.t / m.countMs)));
    while (this.next < m.cues.length && m.cues[this.next].at <= this.t) {
      const c = m.cues[this.next++];
      view.cue(c, false);
      this.sfx(c);
      if (c.kind === 'author') this.revealAt = this.t;
    }
    if (this.revealAt >= 0) {
      const p = (this.t - this.revealAt) / REVEAL_MS;
      view.authorTime(revealTime(m.revealTime, p));
      if (p >= 1) this.revealAt = -1;
    }
    if (this.t >= m.endMs) {
      this.ended = true;
      view.finish(false);
    }
  }

  /** A tap on the card, Esc/P or the controller's Start: straight to the final state, silently. */
  skip(): void {
    if (this.ended) return;
    const { m, view } = this;
    while (this.next < m.cues.length) view.cue(m.cues[this.next++], true);
    view.time(formatTime(m.input.time));
    if (m.authorNew) view.authorTime(m.revealTime);
    this.revealAt = -1;
    this.ended = true;
    view.finish(true);
  }
}
