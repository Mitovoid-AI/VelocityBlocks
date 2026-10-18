// Navigation bugs: "New track" reopened the editor draft, quitting a My-tracks race went to the
// campaign menu, and Enter on a focused results button restarted the race instead of pressing it.
// App needs the DOM and WebGL, so its methods run on an unconstructed App (Object.create).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type Mode } from '../src/app/app';
import { EditorMode } from '../src/app/editorMode';
import { RaceMode, type RaceEntry } from '../src/app/raceMode';
import { Store, type SavedTrack } from '../src/game/storage';
import { Input, type Action } from '../src/input/input';
import type { TrackData } from '../src/track/track';

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
  const entries = Object.create(App.prototype) as App;

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
