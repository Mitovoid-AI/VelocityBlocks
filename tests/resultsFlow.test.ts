// The results card wiring in RaceMode: the HUD hides under it, a secret author time never reaches
// its markup, Esc/P/Start and a tap skip it, every button works at once, and an editor test drive
// sets or lowers the author time (walls off only) while the card judges the run against the old one.
// RaceMode needs the DOM and WebGL, so its methods run on stand-ins.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RaceMode, type RaceEntry } from '../src/app/raceMode';
import { AUTHOR_WALLS_NOTE } from '../src/app/authorTime';
import { medalTimes, type MedalTimes } from '../src/game/medals';
import { formatTime } from '../src/game/race';
import { showScreen, toast } from '../src/ui/dom';
import { ScoreClock } from '../src/ui/scoreCard';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  showScreen: vi.fn(() => ({})),
  clearScreen: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../src/ui/scoreCardView', () => ({
  ScoreCardView: class {
    time = vi.fn();
    authorTime = vi.fn();
    cue = vi.fn();
    finish = vi.fn();
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showScreen).mockClear();
  vi.mocked(toast).mockClear();
});

type RaceProto = {
  showResults(): void;
  onFinish(time: number): void;
  onAction(a: string, src?: string): void;
  update(dt: number): void;
};
const proto = RaceMode.prototype as unknown as RaceProto;

const AUTHOR = 13900;

const entry = (over: Partial<RaceEntry> = {}): RaceEntry => ({
  key: 'c:A01',
  base: 'c:A01',
  vehicle: 'car',
  walls: false,
  data: { name: 'A01 Warm-up', author: 'Velocity', blocks: [] },
  label: 'A01 Warm-up',
  authorTime: AUTHOR,
  campaignIndex: 0,
  ...over,
});

/** The fields showResults uses. */
function results(e: RaceEntry, finish: { time: number; previous: number | null; improved?: boolean; medals?: MedalTimes | null; newAuthor?: number | null }) {
  const app = {
    showTouch: vi.fn(),
    hud: { show: vi.fn(), message: vi.fn() },
    audio: { silence: vi.fn(), scoreCue: vi.fn(), click: vi.fn() },
    nextCampaignEntry: vi.fn(() => (e.campaignIndex !== undefined ? entry({ key: 'c:A02', base: 'c:A02', campaignIndex: 1 }) : null)),
    store: { settings: { racingLine: false, quality: 'high', showGhost: true }, saveSettings: vi.fn() },
    setMode: vi.fn(),
    playRace: vi.fn(),
    startRace: vi.fn(),
    // Web builds: nothing needs the Full Game (tests/fullGame.test.ts covers the locks).
    entryLock: vi.fn(() => null),
    blockLocked: vi.fn(() => false),
  };
  return {
    app,
    entry: e,
    finishInfo: { improved: true, medals: medalTimes(AUTHOR), newAuthor: null, ...finish },
    race: { respawns: 2, ghost: { time: finish.time } },
    card: null as ScoreClock | null,
    resultsShown: false,
    paused: false,
    phaseSince: 0,
    restart: vi.fn(),
    quit: vi.fn(),
    setPaused: vi.fn(),
    toggleGhost: vi.fn(),
  };
}

describe('RaceMode.showResults', () => {
  it('hides the HUD and the controls, and keeps a secret author time out of the card', () => {
    const r = results(entry(), { time: 14500, previous: 16000 });
    proto.showResults.call(r);
    expect(r.resultsShown).toBe(true);
    expect(r.app.hud.show).toHaveBeenCalledWith(false);
    expect(r.app.showTouch).toHaveBeenCalledWith(false);
    const [html, cls, handlers] = vi.mocked(showScreen).mock.calls[0];
    expect(cls).toContain('score-screen');
    expect(html).not.toContain(formatTime(AUTHOR));
    expect(html).toContain('?:??.??');
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(['skip', 'retry', 'replay', 'next', 'menu']));
    expect(r.card).toBeInstanceOf(ScoreClock);
    expect(r.card!.done).toBe(false);
  });

  it('every button works from the first frame', () => {
    const r = results(entry(), { time: 14500, previous: 16000 });
    proto.showResults.call(r);
    const handlers = vi.mocked(showScreen).mock.calls[0][2];
    const el = {} as HTMLElement;
    handlers.retry(el);
    expect(r.restart).toHaveBeenCalled();
    handlers.menu(el);
    expect(r.quit).toHaveBeenCalled();
    handlers.next(el);
    expect(r.app.playRace).toHaveBeenCalledWith(expect.objectContaining({ key: 'c:A02' }));
    handlers.replay(el);
    expect(r.app.setMode).toHaveBeenCalled();
    handlers.skip(el);
    expect(r.card!.done).toBe(true);
  });

  it('shows the vehicle and wall mode, and the walls note on a walls-on test drive', () => {
    const e = entry({ key: 'u:x@bike1|w', base: 'u:x', vehicle: 'bike', walls: true, fromEditor: true, campaignIndex: undefined, authorTime: null });
    const r = results(e, { time: 14500, previous: null, medals: null });
    proto.showResults.call(r);
    const html = vi.mocked(showScreen).mock.calls[0][0];
    expect(html).toContain('Bike');
    expect(html).toContain('Walls on');
    expect(html).toContain(AUTHOR_WALLS_NOTE);
    expect(html).not.toContain('data-act="next"');
    expect(html).toContain('data-act="menu">Editor<');
  });

  it('with reduced motion: the final state at once and one sound', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const r = results(entry(), { time: 13800, previous: 14500 });
    proto.showResults.call(r);
    expect(r.card!.done).toBe(true);
    expect(r.app.audio.scoreCue).toHaveBeenCalledTimes(1);
    expect(r.app.audio.scoreCue).toHaveBeenCalledWith('author');
    expect(vi.mocked(showScreen).mock.calls[0][0]).not.toContain('sc-anim');
  });
});

describe('RaceMode actions on the results', () => {
  it('Esc / P / Start skip the reveal and never pause', () => {
    const r = results(entry(), { time: 14500, previous: 16000 });
    proto.showResults.call(r);
    proto.onAction.call(r, 'pause', 'key');
    expect(r.card!.done).toBe(true);
    expect(r.setPaused).not.toHaveBeenCalled();
  });

  it('the ghost toggle answers with a toast, since the HUD is hidden', () => {
    const r = { ...results(entry(), { time: 14500, previous: 16000 }), resultsShown: true };
    proto.onAction.call(r, 'ghost');
    expect(r.toggleGhost).toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
    expect(r.app.hud.message).not.toHaveBeenCalled();
  });
});

/** The fields onFinish uses: a store with `prev` as the best before this run. */
function finishing(e: RaceEntry, prev: number | null, saved = true) {
  const app = {
    store: {
      addFinish: vi.fn((_k: string, t: number) => ({ improved: prev === null || t < prev, previous: prev, saved })),
      saveGhost: vi.fn(),
      record: vi.fn(() => (prev === null ? undefined : { best: prev })),
    },
    ads: { happytime: vi.fn() },
    audio: { finish: vi.fn() },
    hud: { countdown: vi.fn() },
  };
  return {
    app,
    entry: e,
    medals: e.authorTime ? medalTimes(e.authorTime) : null,
    race: { cpTimes: [1000], ghost: null },
    finishInfo: null as null | { medals: MedalTimes | null; newAuthor: number | null; previous: number | null },
  };
}

describe('RaceMode.onFinish', () => {
  it("an editor test drive's first finish sets the author time", () => {
    const onAuthorTime = vi.fn();
    const e = entry({ fromEditor: true, authorTime: null, campaignIndex: undefined, onAuthorTime });
    const r = finishing(e, null);
    proto.onFinish.call(r, 15000);
    expect(e.authorTime).toBe(15000);
    expect(r.medals).toEqual(medalTimes(15000));
    expect(onAuthorTime).toHaveBeenCalledWith(15000);
    expect(r.finishInfo).toMatchObject({ medals: null, newAuthor: 15000 });
    expect(r.app.ads.happytime).not.toHaveBeenCalled();
    // A first run says FINISH at the line (the card says FIRST FINISH).
    expect(r.app.hud.countdown).toHaveBeenCalledWith('FINISH');
  });

  it('a faster test drive lowers it, judged against the time it beat', () => {
    const onAuthorTime = vi.fn();
    const e = entry({ fromEditor: true, authorTime: 15000, campaignIndex: undefined, onAuthorTime });
    const r = finishing(e, 15000);
    proto.onFinish.call(r, 14800);
    expect(e.authorTime).toBe(14800);
    expect(r.medals).toEqual(medalTimes(14800));
    expect(r.finishInfo).toMatchObject({ medals: medalTimes(15000), newAuthor: 14800 });
    expect(onAuthorTime).toHaveBeenCalledWith(14800);
    expect(r.app.hud.countdown).toHaveBeenCalledWith('RECORD!');
  });

  it('a slower test drive, or any walls-on one, leaves it alone', () => {
    const onAuthorTime = vi.fn();
    const slow = finishing(entry({ fromEditor: true, authorTime: 15000, onAuthorTime }), 15000);
    proto.onFinish.call(slow, 15200);
    expect(slow.entry.authorTime).toBe(15000);
    const walls = finishing(entry({ fromEditor: true, walls: true, key: 'u:x|w', authorTime: null, onAuthorTime }), null);
    proto.onFinish.call(walls, 15200);
    expect(walls.entry.authorTime).toBeNull();
    expect(walls.medals).toBeNull();
    expect(onAuthorTime).not.toHaveBeenCalled();
  });

  it("never sets a campaign track's author time, and calls happy time only on a first author medal", () => {
    const first = finishing(entry(), 14500);
    proto.onFinish.call(first, 13800);
    expect(first.entry.authorTime).toBe(AUTHOR);
    expect(first.finishInfo).toMatchObject({ newAuthor: null });
    expect(first.app.ads.happytime).toHaveBeenCalledTimes(1);
    const again = finishing(entry(), 13800);
    proto.onFinish.call(again, 13700);
    expect(again.app.ads.happytime).not.toHaveBeenCalled();
    const editor = finishing(entry({ fromEditor: true }), 14500);
    proto.onFinish.call(editor, 13800);
    expect(editor.app.ads.happytime).not.toHaveBeenCalled();
  });

  it('saves the record and the ghost under the entry key', () => {
    const e = entry({ key: 'c:A01@bike1|w', vehicle: 'bike', walls: true });
    const r = finishing(e, null);
    (r.race as { ghost: unknown }).ghost = { time: 1 };
    proto.onFinish.call(r, 20000);
    expect(r.app.store.addFinish).toHaveBeenCalledWith('c:A01@bike1|w', 20000, [1000]);
    expect(r.app.store.saveGhost).toHaveBeenCalledWith('c:A01@bike1|w', { time: 1 });
    expect(toast).not.toHaveBeenCalled();
  });

  it('says when storage is full, and spends no room on a ghost the record could not keep', () => {
    const r = finishing(entry(), null, false);
    (r.race as { ghost: unknown }).ghost = { time: 1 };
    proto.onFinish.call(r, 20000);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Storage is full'), 4000);
    expect(r.app.store.saveGhost).not.toHaveBeenCalled();
    // The card still shows the run.
    expect(r.finishInfo).toMatchObject({ previous: null });
  });
});

describe('RaceMode PB ghost for Retry', () => {
  it('keeps a new PB ghost storage could not keep in memory, and none once storage has it', () => {
    const r = finishing(entry(), 16000) as ReturnType<typeof finishing> & { sessionGhost?: unknown };
    (r.race as { ghost: unknown }).ghost = { time: 1 };
    r.app.store.saveGhost.mockReturnValue(false);
    proto.onFinish.call(r, 15000);
    expect(r.sessionGhost).toEqual({ time: 1 });
    r.app.store.saveGhost.mockReturnValue(true);
    (r.race as { ghost: unknown }).ghost = { time: 2 };
    proto.onFinish.call(r, 14000);
    expect(r.sessionGhost).toBeNull();
  });

  /** The fields restart() uses; `phase` the race's, `resultsShown` whether the card is up. */
  function restarting(phase: string, resultsShown: boolean, sessionGhost: unknown = null) {
    return {
      resultsShown,
      sessionGhost,
      pbGhost: { time: 'old' } as unknown,
      pbSplits: [1] as number[] | null,
      entry: entry(),
      race: { phase, restart: vi.fn(), assists: null },
      app: {
        store: { ghost: vi.fn(() => ({ time: 'new' })), record: vi.fn(() => ({ best: 1, cpTimes: [2] })) },
        input: { clearNitroPress: vi.fn() },
        rig: { reset: vi.fn() },
        hud: { clearMessages: vi.fn(), show: vi.fn() },
        showTouch: vi.fn(),
        blockLocked: vi.fn(() => false),
      },
      assists: vi.fn(() => ({})),
      makeGhostCar: vi.fn(),
      snapPrev: vi.fn(),
      refreshHud: vi.fn(),
      smoke: { clear: vi.fn() },
      lineView: null,
      progress: { reset: vi.fn() },
    };
  }
  const restart = (r: object) => (RaceMode.prototype as unknown as { restart(): void }).restart.call(r);

  it('a Restart in the 1.4 s between the finish and the card races the new PB ghost and splits too', () => {
    const r = restarting('finished', false);
    restart(r);
    expect(r.pbGhost).toEqual({ time: 'new' });
    expect(r.pbSplits).toEqual([2]);
    expect(r.makeGhostCar).toHaveBeenCalled();
    // Mid-run restarts keep the ghost they had.
    const mid = restarting('racing', false);
    restart(mid);
    expect(mid.pbGhost).toEqual({ time: 'old' });
    expect(mid.makeGhostCar).not.toHaveBeenCalled();
  });

  it('Retry races the in-memory PB ghost when storage could not keep it', () => {
    const r = restarting('finished', true, { time: 'memory' });
    restart(r);
    expect(r.pbGhost).toEqual({ time: 'memory' });
  });
});
