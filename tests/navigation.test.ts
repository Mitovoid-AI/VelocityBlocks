// Navigation bugs: "New track" reopened the editor draft, quitting a My-tracks race went to the
// campaign menu, and Enter on a focused results button restarted the race instead of pressing it.
// App needs the DOM and WebGL, so its methods run on an unconstructed App (Object.create).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, AttractMode, WALLS_ROUTE_NOTE, type Mode } from '../src/app/app';
import { EditorMode } from '../src/app/editorMode';
import { RaceMode, type RaceEntry } from '../src/app/raceMode';
import { entryKey } from '../src/core/vehicles';
import { formatTime } from '../src/game/race';
import { layoutHash, Store, type SavedTrack } from '../src/game/storage';
import { Input, type Action } from '../src/input/input';
import { buildTrack } from '../src/track/builder';
import type { TrackData } from '../src/track/track';
import { showScreen } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  showScreen: vi.fn(() => ({ scrollTop: 0, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) })),
  toast: vi.fn(),
}));

// The Bike's and Truck's tables may not be generated yet, and a miss runs the autopilot on all 12
// tracks: fixed author times per class keep these tests fast.
const AUTHOR = vi.hoisted(() => ({ car: 20000, bike: 24000, truck: 26000 }) as const);
vi.mock('../src/game/medals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/game/medals')>()),
  campaignAuthorTime: vi.fn((_id: string, v: keyof typeof AUTHOR = 'car') => AUTHOR[v]),
}));

class MapStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Start block followed by straights northwards, `n` blocks in all. */
const track = (name: string, n = 2): TrackData => ({
  name,
  author: 'Tester',
  blocks: Array.from({ length: n }, (_, m) => ({ type: m ? 'straight' : 'start', i: 5, j: 5 + m, k: 0, dir: 0 as const })),
});
const saved = (id: string, data: TrackData): SavedTrack => ({ id, data, updated: 1 });

/** The App members these tests use, private ones included. */
type Shell = {
  store: Store;
  editor: EditorMode | null;
  mode: Mode | null;
  openEditor: App['openEditor'];
  unsavedDraft(): SavedTrack | null;
};

/** An App with a real Store over in-memory storage; the editor's scene and UI hookup is skipped. */
function shell(): Shell {
  vi.stubGlobal('localStorage', new MapStorage());
  vi.spyOn(EditorMode.prototype, 'enter').mockImplementation(() => {});
  const app = Object.create(App.prototype) as Shell;
  Object.assign(app, { store: new Store(), audio: { unlock() {} }, editor: null, mode: null });
  return app;
}

const opened = (app: Shell) => app.editor as unknown as { id: string; data: TrackData };

describe('App.openEditor', () => {
  it('My tracks > New track opens an empty track, not the draft', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('draft1', track('Half built', 4)));
    app.openEditor(null);
    expect(opened(app).data.blocks).toEqual([]);
    expect(opened(app).data.name).toBe('My track');
    expect(opened(app).id).not.toBe('draft1');
  });

  it('Track editor resumes the draft', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('draft1', track('Half built', 4)));
    app.openEditor();
    expect(opened(app).id).toBe('draft1');
    expect(opened(app).data.blocks).toHaveLength(4);
  });

  it('Edit opens the chosen track', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('draft1', track('Half built', 4)));
    app.openEditor(saved('t2', track('Loop', 3)));
    expect(opened(app).id).toBe('t2');
    expect(opened(app).data.name).toBe('Loop');
  });

  it('coming back from a test drive keeps the open editor', () => {
    const app = shell();
    app.openEditor(saved('t2', track('Loop', 3)));
    const ed = app.editor;
    app.openEditor();
    expect(app.editor).toBe(ed);
  });

  it('reads the draft after the previous mode has exited', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('old', track('Old')));
    app.mode = { update() {}, exit: () => app.store.saveEditorDraft(saved('new', track('Written on exit'))) };
    app.openEditor();
    expect(opened(app).id).toBe('new');
  });
});

describe('My tracks > New track: unsaved draft check', () => {
  it('is quiet with no draft or an empty one', () => {
    const app = shell();
    expect(app.unsavedDraft()).toBeNull();
    app.store.saveEditorDraft(saved('d', track('Empty', 0)));
    expect(app.unsavedDraft()).toBeNull();
  });

  it('is quiet when the draft is saved in My tracks as it is', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('d', track('Same', 3)));
    app.store.saveCustomTrack(saved('d', track('Same', 3)));
    expect(app.unsavedDraft()).toBeNull();
  });

  it('reports a draft never saved, renamed or rebuilt since saving', () => {
    const app = shell();
    app.store.saveEditorDraft(saved('d', track('Fresh', 3)));
    expect(app.unsavedDraft()?.id).toBe('d');
    app.store.saveCustomTrack(saved('d', track('Old name', 3)));
    expect(app.unsavedDraft()?.id).toBe('d');
    app.store.saveCustomTrack(saved('d', track('Fresh', 2)));
    expect(app.unsavedDraft()?.id).toBe('d');
  });
});

describe('RaceMode quit (Pause > Quit to menu, results > Menu)', () => {
  const quit = (entry: RaceEntry) => {
    const app = { openEditor: vi.fn(), campaignMenu: vi.fn(), myTracks: vi.fn() };
    (RaceMode.prototype as unknown as { quit(this: unknown): void }).quit.call({ app, entry });
    return app;
  };
  // Entries read the profile's vehicle and the Walls setting.
  const entries = Object.assign(Object.create(App.prototype), {
    store: { profile: { vehicle: 'car' }, settings: { walls: false } },
  }) as App;

  it('a My tracks race goes back to My tracks', () => {
    const app = quit(entries.customEntry(track('Mine')));
    expect(app.myTracks).toHaveBeenCalledTimes(1);
    expect(app.campaignMenu).not.toHaveBeenCalled();
  });

  it('a campaign race goes back to the campaign menu', () => {
    const app = quit(entries.campaignEntry(0));
    expect(app.campaignMenu).toHaveBeenCalledTimes(1);
    expect(app.myTracks).not.toHaveBeenCalled();
  });

  it('a test drive goes back to the editor', () => {
    const app = quit(entries.customEntry(track('Mine'), true));
    expect(app.openEditor).toHaveBeenCalledWith();
    expect(app.myTracks).not.toHaveBeenCalled();
  });
});

/** An App over a real Store for the menu screens (the menu car and the ads are stubbed). */
function menus(): App {
  const app = shell();
  Object.assign(app, { ensureAttract: vi.fn(), ads: { canReward: () => false } });
  return app as unknown as App;
}
const lastScreen = () => vi.mocked(showScreen).mock.calls[vi.mocked(showScreen).mock.calls.length - 1];
const authorText = (t: number) => `Author ${formatTime(t)}`;

describe('Campaign cards: secret author times, per vehicle and wall mode', () => {
  it('stay secret until beaten with that vehicle in that wall mode', () => {
    const app = menus();
    app.campaignMenu();
    let html = lastScreen()[0];
    expect(html).toContain('?:??.??');
    expect(html).not.toContain(authorText(AUTHOR.car));

    app.store.addFinish('c:A01', AUTHOR.car - 100, []);
    app.campaignMenu();
    html = lastScreen()[0];
    // A01 revealed; A02 (now unlocked) still secret.
    expect(html.match(/Author 0:20\.00/g)).toHaveLength(1);
    expect(html).toContain('?:??.??');

    // The same run with walls on is another record: secret again there.
    app.store.settings.walls = true;
    app.campaignMenu();
    html = lastScreen()[0];
    expect(html).not.toContain(authorText(AUTHOR.car));
    expect(html).toContain('Walls on');
  });

  it('the Car / Bike / Truck switch saves the vehicle and shows its own times and medals', () => {
    const app = menus();
    app.store.addFinish('c:A01', AUTHOR.car - 100, []);
    app.campaignMenu();
    const [html, , handlers] = lastScreen();
    expect(html).toMatch(/data-act="veh" data-v="car" aria-pressed="true"/);
    handlers.veh({ dataset: { v: 'bike' } } as unknown as HTMLElement);
    expect(app.store.profile.vehicle).toBe('bike');
    const bike = lastScreen()[0];
    expect(bike).toMatch(/data-act="veh" data-v="bike" aria-pressed="true"/);
    // The car's PB and revealed time are not the bike's, but A02 stays unlocked (shared unlocks).
    expect(bike).not.toContain(authorText(AUTHOR.car));
    expect(bike).not.toContain(`PB ${formatTime(AUTHOR.car - 100)}`);
    expect(bike).not.toMatch(/data-act="locked" data-i="1"/);
    app.store.addFinish(entryKey('c:A01', 'bike', false), AUTHOR.bike, []);
    app.campaignMenu();
    expect(lastScreen()[0]).toContain(authorText(AUTHOR.bike));
  });

  it('race entries carry the vehicle and wall mode, and Next track keeps them', () => {
    const app = menus();
    app.store.profile.vehicle = 'truck';
    app.store.settings.walls = true;
    const e = app.campaignEntry(0);
    expect(e).toMatchObject({ base: 'c:A01', vehicle: 'truck', walls: true, key: entryKey('c:A01', 'truck', true), authorTime: AUTHOR.truck });
    app.store.profile.vehicle = 'car';
    app.store.settings.walls = false;
    expect(app.nextCampaignEntry(e)).toMatchObject({ base: 'c:A02', vehicle: 'truck', walls: true, key: entryKey('c:A02', 'truck', true) });
  });
});

describe('My tracks: secret author times', () => {
  it('an imported track keeps its author time secret until beaten, per vehicle', () => {
    const app = menus();
    const data: TrackData = { ...track('Imported', 3), authorTime: 14000 };
    app.store.saveCustomTrack(saved('imp-1', data));
    app.myTracks();
    expect(lastScreen()[0]).not.toContain(authorText(14000));
    expect(lastScreen()[0]).toContain('?:??.??');
    app.store.addFinish(`u:${layoutHash(data)}`, 13990, []);
    app.myTracks();
    expect(lastScreen()[0]).toContain(authorText(14000));
    // The bike has no author time on it yet.
    app.store.profile.vehicle = 'bike';
    app.myTracks();
    expect(lastScreen()[0]).toContain('Author --');
    expect(lastScreen()[0]).toContain('Bike');
  });

  it('with walls on, warns about a track whose road is not joined from Start to a Finish', () => {
    const app = menus();
    const joined = buildTrack('Joined', 'St Sx2 F', 'Tester');
    app.store.saveCustomTrack(saved('a', track('No finish', 3)));
    app.store.saveCustomTrack(saved('b', joined));
    app.myTracks();
    expect(lastScreen()[0]).not.toContain(WALLS_ROUTE_NOTE);
    app.store.settings.walls = true;
    app.myTracks();
    expect(lastScreen()[0].split(WALLS_ROUTE_NOTE)).toHaveLength(2);
  });
});

describe('Settings: Walls on all roads', () => {
  it('is a pair of buttons that saves the setting', () => {
    const app = menus();
    Object.assign(app, { setGarageView: vi.fn() });
    const saveSettings = vi.spyOn(app.store, 'saveSettings');
    vi.useFakeTimers();
    try {
      app.settingsMenu(() => {});
      const [html, , handlers] = lastScreen();
      expect(html).toMatch(/data-act="walls" data-v="off" aria-pressed="true"/);
      handlers.walls({ dataset: { v: 'on' } } as unknown as HTMLElement);
      expect(app.store.settings.walls).toBe(true);
      expect(saveSettings).toHaveBeenCalled();
      vi.runAllTimers(); // the menu track rebuild (none here: no menu car)
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('App.profileChanged', () => {
  it('a vehicle change rebuilds the menu car with its physics in place, other changes as before', () => {
    const m = Object.create(AttractMode.prototype) as AttractMode;
    const setVehicle = vi.spyOn(m, 'setVehicle').mockImplementation(() => {});
    const refreshCar = vi.spyOn(m, 'refreshCar').mockImplementation(() => {});
    const setMode = vi.fn();
    const preloadModel = vi.fn();
    const requestWarm = vi.fn();
    const app = { mode: m, store: { profile: { vehicle: 'bike', carColor: '#ffffff' } }, setMode, preloadModel, world: { requestWarm }, effectiveVehicle: () => 'bike' };
    App.prototype.profileChanged.call(app as unknown as App, 'vehicle');
    expect(setVehicle).toHaveBeenCalledWith('bike');
    expect(refreshCar).not.toHaveBeenCalled();
    // A realistic model of the new class starts loading (the classic one shows meanwhile).
    expect(preloadModel).toHaveBeenCalledTimes(1);
    App.prototype.profileChanged.call(app as unknown as App, 'body');
    expect(refreshCar).toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    expect(preloadModel).toHaveBeenCalledTimes(1);
    // Classic <-> Realistic: rebuilt in place, its programs built before the next frame, the model loaded.
    App.prototype.profileChanged.call(app as unknown as App, 'model');
    expect(refreshCar).toHaveBeenCalledTimes(2);
    expect(requestWarm).toHaveBeenCalled();
    expect(preloadModel).toHaveBeenCalledTimes(2);
  });
});

describe('Input keyboard actions', () => {
  function keys() {
    const on = new Map<string, (e: unknown) => void>();
    vi.stubGlobal('window', { addEventListener: (t: string, fn: (e: unknown) => void) => on.set(t, fn) });
    const input = new Input();
    const actions: Action[] = [];
    input.onAction((a) => actions.push(a));
    const down = (code: string, focused = 'BODY', repeat = false) => {
      const e = { code, repeat, target: { tagName: focused, isContentEditable: false }, preventDefault: vi.fn() };
      on.get('keydown')!(e);
      return e.preventDefault;
    };
    const up = (code: string) => on.get('keyup')!({ code });
    return { actions, down, up };
  }

  it('Enter with no button focused restarts', () => {
    const k = keys();
    expect(k.down('Enter')).toHaveBeenCalled();
    expect(k.actions).toEqual(['restart']);
  });

  it('Enter on a focused button or link is left to the browser to click', () => {
    const k = keys();
    expect(k.down('Enter', 'BUTTON')).not.toHaveBeenCalled();
    k.up('Enter');
    expect(k.down('Enter', 'A')).not.toHaveBeenCalled();
    expect(k.actions).toEqual([]);
  });

  it("a held Enter doesn't restart the next race once the button is gone", () => {
    const k = keys();
    k.down('Enter', 'BUTTON'); // clicks Next track; the new race clears the screen
    k.down('Enter', 'BODY', true); // auto-repeat
    expect(k.actions).toEqual([]);
    k.up('Enter');
    k.down('Enter');
    expect(k.actions).toEqual(['restart']);
  });

  it('Esc still pauses and resumes with the Resume button focused', () => {
    const k = keys();
    expect(k.down('Escape', 'BUTTON')).toHaveBeenCalled();
    expect(k.actions).toEqual(['pause']);
  });

  it('a focused drop-down keeps Enter and the arrow keys', () => {
    const k = keys();
    expect(k.down('Enter', 'SELECT')).not.toHaveBeenCalled();
    expect(k.down('ArrowDown', 'SELECT')).not.toHaveBeenCalled();
    expect(k.actions).toEqual([]);
  });
});
