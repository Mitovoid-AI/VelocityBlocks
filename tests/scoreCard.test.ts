// The results card: what it says for each kind of finish, when each part appears, that a secret
// author time never reaches the markup before its reveal, and the clock that plays the timeline.

import { describe, expect, it, vi } from 'vitest';
import { medalTimes, type MedalTimes } from '../src/game/medals';
import { formatTime } from '../src/game/race';
import {
  AUTHOR_CONFETTI,
  CONFETTI,
  confettiSpecs,
  COUNT_MS,
  countUp,
  FX_MS,
  QUIET_COUNT_MS,
  revealTime,
  ScoreClock,
  scoreCardHtml,
  scoreModel,
  type Cue,
  type ScoreInput,
  type ScoreModel,
  type ScoreView,
} from '../src/ui/scoreCard';
import { SECRET_TIME } from '../src/ui/medalUi';

const AUTHOR = 13900;
const M = medalTimes(AUTHOR); // gold 15000, silver 17000, bronze 21000

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  label: 'A01 Warm-up',
  tags: [],
  time: 15800,
  previous: 16500,
  improved: true,
  medals: M,
  newAuthor: null,
  note: '',
  respawns: 0,
  hasNext: true,
  fromEditor: false,
  ...over,
});

const kinds = (sm: ScoreModel) => sm.cues.map((c) => (c.kind === 'medal' ? `medal${c.n}` : c.kind));
const at = (sm: ScoreModel, k: string) => sm.cues.find((c) => (c.kind === 'medal' ? `medal${c.n}` : c.kind) === k)!.at;

describe('scoreModel', () => {
  it('a first finish without a medal: FIRST FINISH, no confetti, the bronze target next', () => {
    const sm = scoreModel(input({ time: 25000, previous: null }));
    expect(sm.banner).toBe('first');
    expect(sm.confetti).toBe(0);
    expect(sm.headline).toBe('No medal');
    expect(sm.hint).toBe(`Next: Bronze ${formatTime(M.bronze)}`);
    expect(kinds(sm)).not.toContain('medal1');
  });

  it('silver over a bronze PB: only the silver slot is new', () => {
    const sm = scoreModel(input({ time: 16000, previous: 20000 }));
    expect(sm.slots.map((s) => s.fresh)).toEqual([false, true, false, false]);
    expect(sm.slots.map((s) => s.hit)).toEqual([true, true, false, false]);
    expect(sm.headline).toBe('Silver medal earned!');
    expect(sm.banner).toBe('record');
    expect(sm.confetti).toBe(1);
  });

  it('gold: next is the secret author time, with no author digits anywhere', () => {
    const sm = scoreModel(input({ time: 14500, previous: 16000 }));
    expect(sm.headline).toBe('Gold medal earned!');
    expect(sm.hint).toBe('Next: beat the secret author time');
    expect(sm.slots[3]).toMatchObject({ secret: true, hit: false });
    const html = scoreCardHtml(sm, true);
    expect(html).not.toContain(formatTime(AUTHOR));
    expect(html).toContain(SECRET_TIME);
    expect(html).toContain('Secret author medal');
  });

  it('the first author medal plays the reveal in order, and the markup still keeps the secret', () => {
    const sm = scoreModel(input({ time: 13800, previous: 14500 }));
    expect(sm.authorNew).toBe(true);
    expect(sm.revealTime).toBe(formatTime(AUTHOR));
    expect(sm.confetti).toBe(2);
    expect(sm.headline).toBe('Author medal!');
    const order = ['medal1', 'medal2', 'medal3', 'charge', 'author', 'headline', 'banner'];
    for (let k = 1; k < order.length; k++) expect(at(sm, order[k])).toBeGreaterThan(at(sm, order[k - 1]));
    expect(sm.cues.find((c) => c.kind === 'confetti')).toMatchObject({ big: true });
    expect(kinds(sm)).not.toContain('medal4');
    expect(scoreCardHtml(sm, true)).not.toContain(formatTime(AUTHOR));
    expect(scoreCardHtml(sm, false)).not.toContain(formatTime(AUTHOR));
  });

  it('an author medal held from before: shown, and a gold run is quiet with the author slot outlined', () => {
    const sm = scoreModel(input({ time: 14700, previous: 13850, improved: false }));
    expect(sm.slots[3]).toMatchObject({ secret: false, hit: false, best: true });
    expect(sm.hint).toBe('Your best: Author medal');
    expect(sm.quiet).toBe(true);
    expect(sm.countMs).toBe(QUIET_COUNT_MS);
    expect(sm.confetti).toBe(0);
    expect(kinds(sm).some((k) => k.startsWith('medal'))).toBe(false);
    const html = scoreCardHtml(sm, true);
    expect(html).toContain(formatTime(AUTHOR));
    expect(html).toContain('sc-quiet');
    // The medals of a quiet run are on from the start.
    expect(html).toMatch(/sc-slot m3 hit[^"]* on"/);
  });

  it('a slower repeat run on a known author time hints the author time once it is shown', () => {
    const sm = scoreModel(input({ time: 14700, previous: 13850, improved: false }));
    expect(sm.hint).not.toContain('secret');
    const g = scoreModel(input({ time: 14700, previous: 14600, improved: false }));
    expect(g.hint).toBe('Next: beat the secret author time');
  });

  it('no author time: no slots and no medal cues', () => {
    const sm = scoreModel(input({ medals: null }));
    expect(sm.slots).toEqual([]);
    expect(sm.headline).toBe('Finished');
    expect(sm.hint).toBe('No author time yet');
    expect(kinds(sm).some((k) => k.startsWith('medal') || k === 'author' || k === 'charge')).toBe(false);
    expect(scoreCardHtml(sm, true)).not.toContain('sc-medals');
  });

  it('the first editor finish sets the author time: a SET tag, no secret reveal', () => {
    const sm = scoreModel(input({ medals: null, previous: null, time: 14200, newAuthor: 14200, fromEditor: true }));
    expect(sm.headline).toBe('Author time set');
    expect(sm.authorNew).toBe(false);
    expect(sm.slots[3]).toMatchObject({ set: true, secret: false, hit: true, fresh: false, time: 14200 });
    expect(kinds(sm)).toEqual(expect.arrayContaining(['medal1', 'medal2', 'medal3', 'medal4']));
    expect(kinds(sm)).not.toContain('charge');
    expect(kinds(sm)).not.toContain('author');
    expect(sm.confetti).toBe(0);
    expect(scoreCardHtml(sm, true)).toContain('SET');
  });

  it('an own track lowered with PB == author: the new time is set, the old one is not "revealed"', () => {
    const old = medalTimes(14000);
    const sm = scoreModel(input({ medals: old, previous: 14000, time: 13800, newAuthor: 13800, fromEditor: true }));
    expect(sm.headline).toBe('New author time');
    expect(sm.hint).toBe(`Was ${formatTime(14000)}`);
    expect(sm.authorNew).toBe(false);
    expect(sm.slots[3]).toMatchObject({ set: true, secret: false, time: 13800 });
    expect(kinds(sm)).not.toContain('charge');
  });

  it("an imported track's secret author time beaten in a test drive: the creator's time is revealed, then the new one", () => {
    const old: MedalTimes = medalTimes(14000);
    const sm = scoreModel(input({ medals: old, previous: 15000, time: 13900, newAuthor: 13900, fromEditor: true }));
    expect(sm.authorNew).toBe(true);
    expect(sm.revealTime).toBe(formatTime(14000));
    expect(sm.authorLine).toBe(`New author time ${formatTime(13900)}`);
    const html = scoreCardHtml(sm, true);
    expect(html).not.toContain(formatTime(14000));
    expect(html).toContain('New author time');
  });

  it('a walls-on test drive says the author time is set with walls off', () => {
    const sm = scoreModel(input({ fromEditor: true, note: 'Author time is set with walls off', tags: ['Walls on'] }));
    const html = scoreCardHtml(sm, true);
    expect(html).toContain('Author time is set with walls off');
    expect(html).toContain('Walls on');
  });

  it('keeps the timeline short: cue times never go back, the sequence is over by 3.6 s and the particles by 4.5 s', () => {
    const cases = [
      input({ time: 13800, previous: 14500 }),
      input({ time: 13800, previous: null }),
      input({ time: 25000, previous: null }),
      input({ time: 16000, previous: 20000 }),
      input({ medals: null, previous: null, time: 14200, newAuthor: 14200, fromEditor: true }),
      input({ time: 14700, previous: 14600, improved: false }),
    ];
    for (const i of cases) {
      const sm = scoreModel(i);
      for (let k = 1; k < sm.cues.length; k++) expect(sm.cues[k].at).toBeGreaterThanOrEqual(sm.cues[k - 1].at);
      expect(sm.cues[sm.cues.length - 1].at).toBeLessThanOrEqual(3600);
      expect(sm.endMs).toBeLessThanOrEqual(4500);
      expect(sm.endMs).toBeGreaterThan(sm.cues[sm.cues.length - 1].at);
    }
  });
});

describe('scoreCardHtml', () => {
  it('always has Retry, Replay and Menu, never disabled; Next only with a next track', () => {
    const html = scoreCardHtml(scoreModel(input()), true);
    for (const a of ['retry', 'replay', 'menu', 'skip']) expect(html).toContain(`data-act="${a}"`);
    expect(html).toContain('data-act="next"');
    expect(html).not.toContain('disabled');
    expect(scoreCardHtml(scoreModel(input({ hasNext: false })), true)).not.toContain('data-act="next"');
  });

  it('escapes the track name and says Editor for a test drive', () => {
    const html = scoreCardHtml(scoreModel(input({ label: '<b>x</b>', fromEditor: true })), false);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('data-act="menu">Editor<');
  });

  it('starts at 0:00.00 when animating and at the time otherwise', () => {
    const sm = scoreModel(input());
    expect(scoreCardHtml(sm, true)).toContain('class="sc-time">0:00.00<');
    expect(scoreCardHtml(sm, false)).toContain(`class="sc-time">${formatTime(15800)}<`);
    expect(scoreCardHtml(sm, true)).toContain('sc-anim');
    expect(scoreCardHtml(sm, false)).not.toContain('sc-anim');
  });
});

describe('countUp and revealTime', () => {
  it('counts up monotonically on the 10 ms grid and lands exactly', () => {
    let last = -1;
    for (let p = 0; p <= 1.2; p += 0.01) {
      const v = countUp(15830, p);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v % 10).toBe(0);
      last = v;
    }
    expect(countUp(15830, 1)).toBe(15830);
    expect(countUp(15830, 2)).toBe(15830);
    expect(countUp(15830, -1)).toBe(0);
  });

  it('locks the author time in from the left, never showing a wrong digit', () => {
    const final = '0:13.90';
    expect(revealTime(final, 0)).toBe(SECRET_TIME);
    expect(revealTime(final, 0.25)).toBe('0:??.??');
    expect(revealTime(final, 0.5)).toBe('0:1?.??');
    expect(revealTime(final, 0.6)).toBe('0:13.??');
    expect(revealTime(final, 1)).toBe(final);
    for (let p = 0; p < 1; p += 0.05) {
      const s = revealTime(final, p);
      expect(s).toHaveLength(final.length);
      [...s].forEach((c, k) => expect(c === '?' || c === final[k]).toBe(true));
    }
  });
});

describe('confettiSpecs', () => {
  it('is deterministic per seed, finite, from the palette and inside the effects budget', () => {
    const a = confettiSpecs(44, 1234, AUTHOR_CONFETTI, 160);
    expect(a).toHaveLength(44);
    expect(confettiSpecs(44, 1234, AUTHOR_CONFETTI, 160)).toEqual(a);
    expect(confettiSpecs(44, 99, AUTHOR_CONFETTI, 160)).not.toEqual(a);
    for (const p of [...a, ...confettiSpecs(28, 7, CONFETTI, 300)]) {
      for (const v of [p.dx, p.up, p.fall, p.r, p.d, p.t]) expect(Number.isFinite(v)).toBe(true);
      expect([...AUTHOR_CONFETTI, ...CONFETTI]).toContain(p.c);
      expect(p.up).toBeLessThanOrEqual(0);
      expect(p.d + p.t).toBeLessThanOrEqual(FX_MS);
    }
    expect(confettiSpecs(0, 1, CONFETTI, 100)).toEqual([]);
  });
});

/** A recording view. */
function recorder() {
  const log: { kind: string; instant?: boolean; text?: string }[] = [];
  const times: string[] = [];
  const authors: string[] = [];
  const view: ScoreView = {
    time: (t) => void times.push(t),
    authorTime: (t) => void authors.push(t),
    cue: (c: Cue, instant) => void log.push({ kind: c.kind === 'medal' ? `medal${c.n}` : c.kind, instant }),
    finish: (skipped) => void log.push({ kind: skipped ? 'finish:skipped' : 'finish' }),
  };
  return { view, log, times, authors };
}

describe('ScoreClock', () => {
  it('plays every cue once, in order, with a sound each, then settles', () => {
    const sm = scoreModel(input({ time: 13800, previous: 14500 }));
    const r = recorder();
    const sfx = vi.fn();
    const clock = new ScoreClock(sm, r.view, sfx);
    for (let k = 0; k < 400 && !clock.done; k++) clock.update(1 / 60);
    expect(clock.done).toBe(true);
    expect(r.log.map((l) => l.kind)).toEqual([...kinds(sm), 'finish']);
    expect(r.log.every((l) => !l.instant)).toBe(true);
    expect(sfx).toHaveBeenCalledTimes(sm.cues.length);
    expect(r.times[r.times.length - 1]).toBe(formatTime(13800));
    expect(r.authors[0]).toBe(SECRET_TIME);
    expect(r.authors[r.authors.length - 1]).toBe(formatTime(AUTHOR));
    // After the end: nothing more.
    const n = r.log.length;
    clock.update(1);
    clock.skip();
    expect(r.log).toHaveLength(n);
  });

  it('reaches the final time when the count-up ends', () => {
    const sm = scoreModel(input());
    const r = recorder();
    const clock = new ScoreClock(sm, r.view);
    for (let t = 0; t < COUNT_MS + 20; t += 10) clock.update(0.01);
    expect(r.times[r.times.length - 1]).toBe(formatTime(sm.input.time));
  });

  it('skip: the rest of the cues at once, silently, with the final texts', () => {
    const sm = scoreModel(input({ time: 13800, previous: 14500 }));
    const r = recorder();
    const sfx = vi.fn();
    const clock = new ScoreClock(sm, r.view, sfx);
    clock.update(0.5);
    const played = sfx.mock.calls.length;
    clock.skip();
    expect(sfx).toHaveBeenCalledTimes(played);
    expect(r.log.filter((l) => l.kind !== 'finish:skipped').every((l, k) => (k < played ? !l.instant : l.instant))).toBe(true);
    expect(r.log[r.log.length - 1].kind).toBe('finish:skipped');
    expect(r.log.filter((l) => l.kind.startsWith('finish'))).toHaveLength(1);
    expect(r.times[r.times.length - 1]).toBe(formatTime(13800));
    expect(r.authors[r.authors.length - 1]).toBe(formatTime(AUTHOR));
    expect(clock.done).toBe(true);
  });

  it('a skip in the particle tail still ends the animations (finish is always called)', () => {
    const sm = scoreModel(input({ time: 13800, previous: 14500 }));
    const r = recorder();
    const clock = new ScoreClock(sm, r.view);
    // Past the last cue, before endMs.
    const last = sm.cues[sm.cues.length - 1].at;
    for (let t = 0; t < last + 50; t += 50) clock.update(0.05);
    expect(clock.done).toBe(false);
    clock.skip();
    expect(r.log[r.log.length - 1].kind).toBe('finish:skipped');
  });

  it('caps a long frame at 0.1 s', () => {
    const sm = scoreModel(input());
    const r = recorder();
    const clock = new ScoreClock(sm, r.view);
    clock.update(5);
    expect(r.log).toEqual([]);
    expect(r.times[0]).toBe(formatTime(countUp(sm.input.time, 100 / COUNT_MS)));
  });
});
