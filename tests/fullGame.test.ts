// The Full Game (one Google Play in-app purchase): which builds sell it, the entitlement and its local
// copy, the lock rules on every path a premium track, class or model could be started by, the profile
// fallback, and the billing wrapper's flows (purchase, pending, cancel, restore, offline, no plugin).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, vehicleSegHtml } from '../src/app/app';
import {
  campaignSets,
  detectBuildKind,
  effectiveModel,
  effectiveVehicle,
  entryLock,
  FullGame,
  fullGame,
  modelLocked,
  premiumTrackIds,
  setFullGame,
  trackLocked,
  trackTheme,
  vehicleLocked,
  type FullGamePersist,
} from '../src/app/fullGame';
import { freeLine, fullGameHtml, idRange, includedLines, storeView } from '../src/app/fullGameScreen';
import { RaceMode, type RaceEntry } from '../src/app/raceMode';
import { VEHICLE_MODELS } from '../src/core/vehicleModels';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { loadDevFullGame, loadFullGame, saveDevFullGame, saveFullGame, Store, type DevFullGame, type FullGameRecord } from '../src/game/storage';
import { Purchases, type CdvError, type CdvNamespace, type CdvProduct, type CdvTransaction } from '../src/platform/purchases';
import { campaign } from '../src/track/campaign';
import type { TrackData } from '../src/track/track';
import { scoreCardHtml, scoreModel } from '../src/ui/scoreCard';
import { showScreen } from '../src/ui/dom';

vi.mock('../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/dom')>()),
  showScreen: vi.fn(() => ({ scrollTop: 0, isConnected: true, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) })),
  toast: vi.fn(),
}));

// Fixed author times: a table miss would run the autopilot on every campaign track.
vi.mock('../src/game/medals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/game/medals')>()),
  campaignAuthorTime: vi.fn(() => 20000),
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

/** An entitlement kept in memory. */
function memory(owned = false, dev: DevFullGame = null) {
  const state = { rec: { owned, checked: 0 } as FullGameRecord, dev, saves: 0 };
  const persist: FullGamePersist = {
    load: () => state.rec,
    save: (r) => {
      state.rec = r;
      state.saves++;
    },
    loadDev: () => state.dev,
    saveDev: (v) => (state.dev = v),
  };
  return { state, persist };
}

/** Install an Android release build's entitlement (not owned unless said). */
function android(owned = false, kind: 'android-release' | 'android-debug' = 'android-release', dev: DevFullGame = null) {
  const m = memory(owned, dev);
  const fg = new FullGame(kind, m.persist);
  setFullGame(fg);
  return { fg, ...m };
}

afterEach(() => {
  setFullGame(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(showScreen).mockClear();
});

const lastScreen = () => vi.mocked(showScreen).mock.calls[vi.mocked(showScreen).mock.calls.length - 1];
const idOf = (id: string) => campaign().findIndex((c) => c.id === id);

describe('builds', () => {
  it('portal builds and the web build are not sold anything: everything is unlocked', () => {
    for (const ads of ['crazygames', 'poki', 'adtest']) expect(detectBuildKind({ ads, platform: 'web', debug: false })).toBe('portal');
    // A portal mode wins even if the bundle somehow ran in the app.
    expect(detectBuildKind({ ads: 'poki', platform: 'android', debug: false })).toBe('portal');
    expect(detectBuildKind({ ads: 'none', platform: 'web', debug: true })).toBe('web');
    expect(detectBuildKind({ ads: 'none', platform: 'ios', debug: false })).toBe('ios');
    for (const kind of ['web', 'portal', 'ios'] as const) {
      const fg = new FullGame(kind, memory(false).persist);
      expect(fg.billing).toBe(false);
      expect(fg.unlocked).toBe(true);
      // A stray dev switch or a "not owned" record changes nothing there.
      fg.setDev('free');
      fg.storeSays(false);
      expect(fg.unlocked).toBe(true);
    }
  });

  it('Android: debug builds get billing and the dev switch, release builds billing only', () => {
    expect(detectBuildKind({ ads: 'none', platform: 'android', debug: true })).toBe('android-debug');
    expect(detectBuildKind({ ads: 'none', platform: 'android', debug: false })).toBe('android-release');
    const rel = new FullGame('android-release', memory(false, 'owned').persist);
    expect(rel.billing).toBe(true);
    expect(rel.devTools).toBe(false);
    // A dev switch value left in storage is ignored by a release build, and cannot be set there.
    expect(rel.unlocked).toBe(false);
    rel.setDev('owned');
    expect(rel.unlocked).toBe(false);
    const dbg = new FullGame('android-debug', memory(false, 'owned').persist);
    expect(dbg.devTools).toBe(true);
    expect(dbg.unlocked).toBe(true);
  });

  it('tests and `npm run dev` run as the web build: unlocked', () => {
    setFullGame(null);
    expect(fullGame().kind).toBe('web');
    expect(fullGame().unlocked).toBe(true);
  });
});

describe('entitlement', () => {
  it('a purchase unlocks, is stored, and tells the listeners once', () => {
    const { fg, state } = android(false);
    const heard = vi.fn();
    fg.onChange(heard);
    expect(fg.unlocked).toBe(false);
    fg.storeSays(true, 1234);
    expect(fg.unlocked).toBe(true);
    expect(state.rec).toEqual({ owned: true, checked: 1234 });
    expect(heard).toHaveBeenCalledTimes(1);
    // The check at the next start says the same: no change to announce.
    fg.storeSays(true, 2000);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(state.rec.checked).toBe(2000);
  });

  it('the stored copy unlocks at start, offline included, until the store says otherwise (a refund)', () => {
    const { fg } = android(true);
    expect(fg.unlocked).toBe(true);
    const heard = vi.fn();
    fg.onChange(heard);
    fg.storeSays(false);
    expect(fg.unlocked).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('debug builds: the dev switch simulates owning or not, and "follow store" goes back', () => {
    const { fg, state } = android(false, 'android-debug');
    const heard = vi.fn();
    fg.onChange(heard);
    fg.setDev('owned');
    expect(fg.unlocked).toBe(true);
    expect(state.dev).toBe('owned');
    fg.storeSays(true);
    fg.setDev('free');
    expect(fg.unlocked).toBe(false);
    fg.setDev(null);
    expect(fg.unlocked).toBe(true); // the store owns it
    // Owned, the store's purchase (Settings shows what the store says), not owned, follow the store.
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it('a listener that throws does not stop the others', () => {
    const { fg } = android(false);
    const ok = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fg.onChange(() => {
      throw new Error('boom');
    });
    fg.onChange(ok);
    fg.storeSays(true);
    expect(ok).toHaveBeenCalled();
  });

  it('storage: the record round-trips, junk reads as not owned, and Reset records keeps it', () => {
    vi.stubGlobal('localStorage', new MapStorage());
    expect(loadFullGame()).toEqual({ owned: false, checked: 0 });
    saveFullGame({ owned: true, checked: 99 });
    expect(loadFullGame()).toEqual({ owned: true, checked: 99 });
    localStorage.setItem('vb.fullgame', '"owned"');
    expect(loadFullGame().owned).toBe(false);
    localStorage.setItem('vb.fullgame', '{"owned":"yes","checked":"x"}');
    expect(loadFullGame()).toEqual({ owned: false, checked: 0 });
    saveFullGame({ owned: true, checked: 5 });
    saveDevFullGame('free');
    new Store().resetProgress();
    expect(loadFullGame().owned).toBe(true);
    expect(loadDevFullGame()).toBe('free');
    saveDevFullGame(null);
    expect(loadDevFullGame()).toBeNull();
    localStorage.setItem('vb.fullgame.dev', '"hacked"');
    expect(loadDevFullGame()).toBeNull();
  });

  it('storage unavailable: nothing throws, and the store result still counts for the session', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      key: () => null,
      length: 0,
    });
    const fg = new FullGame('android-release');
    expect(fg.unlocked).toBe(false);
    fg.storeSays(true);
    expect(fg.unlocked).toBe(true);
  });
});

describe('lock rules', () => {
  it('free: all Stadium tracks and the first of every other set; premium: the rest of each set', () => {
    const list = campaign();
    const premium = premiumTrackIds(list);
    for (const ct of list) {
      const theme = trackTheme(ct);
      const first = list.find((c) => trackTheme(c) === theme) === ct;
      expect(premium.has(ct.id), ct.id).toBe(theme !== 'stadium' && !first);
    }
    // The sets the builder is adding: D01 and W01 free, the rest premium (when present).
    for (const id of ['A01', 'A12', 'D01', 'W01']) if (idOf(id) >= 0) expect(premium.has(id), id).toBe(false);
    for (const id of ['D02', 'D06', 'W02', 'W06']) if (idOf(id) >= 0) expect(premium.has(id), id).toBe(true);
  });

  it('is data-driven: the theme field, else the id letter; an explicit premium flag wins; a new theme works too', () => {
    const list = [
      { id: 'A01' },
      { id: 'A02' },
      { id: 'D01' },
      { id: 'D02' },
      { id: 'X01', theme: 'snow' },
      { id: 'X02', theme: 'snow' },
      { id: 'W01', theme: 'water' },
      { id: 'W02', theme: 'water', premium: false },
      { id: 'A03', premium: true },
    ];
    expect([...premiumTrackIds(list)].sort()).toEqual(['A03', 'D02', 'X02']);
    expect(campaignSets(list).map((s) => [s.theme, s.label, s.indices])).toEqual([
      ['stadium', 'Stadium', [0, 1, 8]],
      ['desert', 'Desert', [2, 3]],
      ['snow', 'Snow', [4, 5]],
      ['water', 'Water', [6, 7]],
    ]);
    expect(trackLocked('D02', list, false)).toBe(true);
    expect(trackLocked('D02', list, true)).toBe(false);
    expect(trackLocked('D01', list, false)).toBe(false);
  });

  it('classes and realistic models: the Car is free, Bike and Truck and every realistic model need it', () => {
    expect(VEHICLE_CLASSES.filter((v) => vehicleLocked(v, false))).toEqual(['bike', 'truck']);
    expect(VEHICLE_CLASSES.filter((v) => vehicleLocked(v, true))).toEqual([]);
    for (const m of VEHICLE_MODELS) {
      expect(modelLocked(m.id, false), m.id).toBe(true);
      expect(modelLocked(m.id, true), m.id).toBe(false);
    }
    expect(modelLocked('nonsense', false)).toBe(false);
  });

  it('a saved premium choice falls back to the Car / Classic, and comes back once bought', () => {
    const p = { vehicle: 'bike' as const, models: { bike: 'cafe' as const, car: 'sport' as const } };
    expect(effectiveVehicle(p, false)).toBe('car');
    expect(effectiveModel(p, 'car', false)).toBeNull();
    expect(effectiveModel(p, 'bike', false)).toBeNull();
    expect(effectiveVehicle(p, true)).toBe('bike');
    expect(effectiveModel(p, 'bike', true)).toBe('cafe');
    // The profile itself is untouched.
    expect(p).toEqual({ vehicle: 'bike', models: { bike: 'cafe', car: 'sport' } });
  });

  it('entryLock: class first, then a premium campaign track; custom tracks only by class', () => {
    const list = [{ id: 'A01' }, { id: 'D01' }, { id: 'D02' }];
    expect(entryLock({ vehicle: 'car', base: 'c:D02' }, list, false)).toBe('track');
    expect(entryLock({ vehicle: 'bike', base: 'c:A01' }, list, false)).toBe('vehicle');
    expect(entryLock({ vehicle: 'car', base: 'c:D01' }, list, false)).toBeNull();
    expect(entryLock({ vehicle: 'car', base: 'u:abc' }, list, false)).toBeNull();
    expect(entryLock({ vehicle: 'truck', base: 'u:abc' }, list, false)).toBe('vehicle');
    expect(entryLock({ vehicle: 'truck', base: 'c:D02' }, list, true)).toBeNull();
  });
});

// ------------------------------------------------------------------ Every path into a race

type Shell = App;

/** An App over a real Store (in-memory storage), with the menu car and the 3D world stubbed. */
function shell(): Shell {
  vi.stubGlobal('localStorage', new MapStorage());
  const app = Object.create(App.prototype) as Shell;
  Object.assign(app, {
    store: new Store(),
    audio: { unlock() {} },
    ads: { busy: false, canReward: () => false, interstitial: vi.fn(() => Promise.resolve()) },
    hud: { show: vi.fn() },
    mode: null,
    editor: null,
    purchases: null,
    pendingStart: null,
    campaignSet: null,
    ensureAttract: vi.fn(),
    setGarageView: vi.fn(),
    showTouch: vi.fn(),
    setMode: vi.fn(),
  });
  return app;
}

/** Every campaign track finished once (with the Car, walls off): every set's unlock chain is open. */
function finishAll(app: App): void {
  for (const ct of campaign()) app.store.addFinish(`c:${ct.id}`, 30000, []);
}

const track = (name: string): TrackData => ({
  name,
  author: 'Tester',
  blocks: [
    { type: 'start', i: 5, j: 5, k: 0, dir: 0 },
    { type: 'straight', i: 5, j: 6, k: 0, dir: 0 },
  ],
});

/** The Full Game screen is what showScreen drew last. */
const storeShown = () => /<h2>Full Game<\/h2>/.test(lastScreen()?.[0] ?? '');

describe('locked content cannot be started', () => {
  it('startRace (every start goes through it): a premium track opens the Full Game screen instead', () => {
    if (idOf('D02') < 0) return;
    android(false);
    const app = shell();
    const e = app.campaignEntry(idOf('D02'));
    expect(app.startRace(e)).toBe(false);
    expect(app.setMode).not.toHaveBeenCalled();
    expect(storeShown()).toBe(true);
    // Back goes to the campaign.
    const campaignMenu = vi.spyOn(app, 'campaignMenu').mockImplementation(() => {});
    lastScreen()[2].back({} as HTMLElement);
    expect(campaignMenu).toHaveBeenCalled();
  });

  it('startRace: a free track starts; a premium class never does, even on a free or custom track', () => {
    android(false);
    const app = shell();
    expect(app.startRace(app.campaignEntry(0))).toBe(true);
    expect(app.setMode).toHaveBeenCalledTimes(1);
    if (idOf('D01') >= 0) expect(app.startRace(app.campaignEntry(idOf('D01')))).toBe(true);
    expect(app.startRace(app.campaignEntry(0, 'bike'))).toBe(false);
    expect(app.startRace(app.customEntry(track('Mine'), false, undefined, 'truck'))).toBe(false);
    // An editor test drive with a premium class: Back returns to the editor.
    expect(app.startRace(app.customEntry(track('Mine'), true, undefined, 'bike'))).toBe(false);
    const openEditor = vi.spyOn(app, 'openEditor').mockImplementation(() => {});
    lastScreen()[2].back({} as HTMLElement);
    expect(openEditor).toHaveBeenCalledWith();
  });

  it('playRace (menus, Next track): blocked before any ad or model load', async () => {
    if (idOf('D02') < 0) return;
    android(false);
    const app = shell();
    const startRace = vi.spyOn(app, 'startRace');
    await app.playRace(app.campaignEntry(idOf('D02')));
    expect(app.ads.interstitial).not.toHaveBeenCalled();
    expect(startRace).not.toHaveBeenCalled();
    expect(storeShown()).toBe(true);
  });

  it('with the Full Game every track and class starts (once its set chain is open)', () => {
    android(true);
    const app = shell();
    finishAll(app);
    for (let i = 0; i < campaign().length; i++) expect(app.startRace(app.campaignEntry(i, 'truck')), campaign()[i].id).toBe(true);
  });

  it('web and portal builds: everything starts (once its set chain is open)', () => {
    setFullGame(new FullGame('portal', memory(false).persist));
    const app = shell();
    finishAll(app);
    for (let i = 0; i < campaign().length; i++) expect(app.startRace(app.campaignEntry(i, 'bike'))).toBe(true);
    setFullGame(new FullGame('web', memory(false).persist));
    expect(app.startRace(app.customEntry(track('Mine'), true, undefined, 'truck'))).toBe(true);
  });

  it('Retry / Restart replay the entry only while it is allowed (refund, dev switch)', () => {
    const { fg } = android(true);
    const blockLocked = vi.fn((e: RaceEntry) => App.prototype.blockLocked.call(app, e));
    const app = shell();
    const r = {
      app: Object.assign(app, { blockLocked }),
      entry: app.campaignEntry(0, 'bike'),
      resultsShown: true,
      race: { phase: 'finished', restart: vi.fn(), assists: null },
    };
    fg.storeSays(false);
    (RaceMode.prototype as unknown as { restart(): void }).restart.call(r);
    expect(blockLocked).toHaveBeenCalled();
    expect(r.race.restart).not.toHaveBeenCalled();
    expect(storeShown()).toBe(true);
  });

  it('the results card marks a locked Next track, and pressing it goes through playRace (blocked)', () => {
    const html = (nextLocked: boolean) =>
      scoreCardHtml(
        scoreModel({
          label: 'D01 Dune Road',
          tags: [],
          time: 30000,
          previous: null,
          improved: true,
          medals: null,
          newAuthor: null,
          note: '',
          respawns: 0,
          hasNext: true,
          nextLocked,
          fromEditor: false,
        }),
        false,
      );
    expect(html(true)).toContain('&#128274; Next track');
    expect(html(false)).not.toContain('&#128274;');
    if (idOf('D02') < 0) return;
    android(false);
    const app = shell();
    const next = app.nextCampaignEntry(app.campaignEntry(idOf('D01')))!;
    expect(next.base).toBe('c:D02');
    expect(app.entryLock(next)).toBe('track');
  });

  it('a saved Bike races as the Car (menus, entries, test drives, the menu car) and keeps the choice', () => {
    android(false);
    const app = shell();
    app.store.profile.vehicle = 'bike';
    app.store.profile.models = { bike: 'cafe', car: 'sport' };
    expect(app.effectiveVehicle()).toBe('car');
    expect(app.campaignEntry(0).vehicle).toBe('car');
    expect(app.customEntry(track('Mine'), true).vehicle).toBe('car');
    expect(app.playerCarOptions().vehicle).toBe('car');
    expect(app.playerCarOptions().model).toBeNull();
    expect(app.playerCarOptions('bike').model).toBeNull();
    expect(app.store.profile.vehicle).toBe('bike');
    // Bought: the saved Bike and its Cafe Racer are back without touching the profile.
    fullGame().storeSays(true);
    expect(app.effectiveVehicle()).toBe('bike');
    expect(app.campaignEntry(0).vehicle).toBe('bike');
    expect(app.playerCarOptions().model).toBe('cafe');
  });

  it('setVehicle refuses a locked class (the switch then opens the store)', () => {
    android(false);
    const app = shell();
    expect(app.setVehicle('truck')).toBe(false);
    expect(app.store.profile.vehicle).toBe('car');
    fullGame().storeSays(true);
    vi.spyOn(app, 'profileChanged').mockImplementation(() => {});
    expect(app.setVehicle('truck')).toBe(true);
    expect(app.store.profile.vehicle).toBe('truck');
  });
});

describe('menus', () => {
  it('Campaign: premium cards and classes carry locks and open the Full Game screen', () => {
    android(false);
    const app = shell();
    app.campaignMenu();
    let [html, , handlers] = lastScreen();
    expect(html).toMatch(/data-act="veh" data-v="bike"[^>]*>.*?&#128274;/);
    expect(html).not.toMatch(/data-act="veh" data-v="car"[^>]*>.*?&#128274;.*?Car</);
    handlers.veh({ dataset: { v: 'bike' } } as unknown as HTMLElement);
    expect(app.store.profile.vehicle).toBe('car');
    expect(storeShown()).toBe(true);
    if (idOf('D02') < 0) return;
    app.campaignMenu();
    [html, , handlers] = lastScreen();
    // More than one set: the Stadium / Desert / Water switch.
    expect(html).toContain('data-act="set" data-v="desert"');
    handlers.set({ dataset: { v: 'desert' } } as unknown as HTMLElement);
    html = lastScreen()[0];
    expect(html).toMatch(new RegExp(`data-act="race" data-i="${idOf('D01')}"`));
    expect(html).toMatch(new RegExp(`data-act="premium" data-i="${idOf('D02')}"`));
    expect(html).not.toContain('data-i="0"'); // A01 is on the Stadium tab
    lastScreen()[2].premium({ dataset: { i: String(idOf('D02')) } } as unknown as HTMLElement);
    expect(storeShown()).toBe(true);
  });

  it('Campaign: owned, nothing is locked; a race opens its own set when the player comes back', () => {
    android(true);
    const app = shell();
    if (idOf('W03') < 0) return;
    finishAll(app);
    app.startRace(app.campaignEntry(idOf('W03')));
    app.campaignMenu();
    const html = lastScreen()[0];
    expect(html).toMatch(/data-act="set" data-v="water" aria-pressed="true"/);
    expect(html).not.toContain('data-act="premium"');
    expect(html).not.toContain('&#128274; Full Game');
  });

  it('Home and Settings show "Get Full Game" only where it is sold and not owned', () => {
    const settingsHtml = (app: App) => (app as unknown as { fullGameSettingsHtml(): string }).fullGameSettingsHtml();
    android(false);
    const app = shell();
    expect(settingsHtml(app)).toContain('Get Full Game');
    fullGame().storeSays(true);
    expect(settingsHtml(app)).toContain('Unlocked');
    setFullGame(new FullGame('web', memory(false).persist));
    expect(settingsHtml(app)).toBe('');
  });

  it('the vehicle switch has no locks where everything is unlocked', () => {
    expect(vehicleSegHtml('car', true)).not.toContain('&#128274;');
    expect(vehicleSegHtml('car', false).match(/&#128274;/g)).toHaveLength(2);
  });

  it('the profile: locked classes and the Realistic look carry locks; the saved Bike shows as the Car', async () => {
    const { carHtml, homeCardHtml } = await import('../src/app/profileScreen');
    android(false);
    const { migrateProfile } = await import('../src/game/storage');
    const p = migrateProfile({ vehicle: 'bike', models: { bike: 'cafe', car: 'sport' }, carBody: 'muscle' }, {});
    const html = carHtml(p);
    expect(html).toMatch(/data-act="vehicle" data-v="car" role="radio" aria-checked="true"/);
    expect(html).toMatch(/veh-opt +locked" data-act="vehicle" data-v="bike"/);
    expect(html).toMatch(/look-opt  locked" data-act="look" data-v="realistic"/);
    expect(html).toContain('data-act="body"'); // the Car's procedural bodies stay free
    const card = homeCardHtml({ store: { profile: p, profilePhoto: () => null } } as unknown as Parameters<typeof homeCardHtml>[0]);
    expect(card).toContain('Muscle');
    fullGame().storeSays(true);
    expect(carHtml(p)).toMatch(/data-act="vehicle" data-v="bike" role="radio" aria-checked="true"/);
    expect(carHtml(p)).not.toContain('&#128274;');
  });
});

describe('the Full Game screen', () => {
  it('lists what the purchase adds and what stays free, from the data', () => {
    const list = [{ id: 'A01' }, { id: 'A02' }, { id: 'D01' }, { id: 'D02' }, { id: 'D03' }, { id: 'W01' }, { id: 'W02' }];
    const lines = includedLines(list).join('\n');
    expect(lines).toContain('<b>Desert</b>: 2 more tracks (D02&ndash;D03)');
    expect(lines).toContain('<b>Water</b>: 1 more track (W02)');
    expect(lines).toContain('Bike and Truck');
    expect(lines).toContain("LCT 3000 &#39;95");
    expect(freeLine(list)).toContain('the Stadium campaign');
    expect(freeLine(list)).toContain('(D01, W01)');
    expect(idRange(['D02', 'D04'])).toBe('D02, D04');
  });

  it('shows the store price, a pending payment, an error, and the thank-you', () => {
    android(false);
    const list = campaign();
    const base = storeView(null);
    expect(base.status).toBe('unavailable');
    const ready = { ...base, status: 'ready' as const, price: '€2.99' };
    expect(fullGameHtml(ready, list)).toContain('Buy for €2.99');
    expect(fullGameHtml(ready, list)).toMatch(/data-act="buy" >/);
    expect(fullGameHtml({ ...ready, pending: true }, list)).toContain('Payment pending');
    expect(fullGameHtml({ ...ready, pending: true }, list)).toMatch(/data-act="buy" disabled/);
    expect(fullGameHtml({ ...base, status: 'connecting' }, list)).toMatch(/data-act="buy" disabled/);
    expect(fullGameHtml({ ...base, error: 'Offline!' }, list)).toContain('Offline!');
    expect(fullGameHtml(ready, list)).toContain('data-act="restore"');
    const thanks = fullGameHtml({ ...ready, unlocked: true, thanks: true }, list);
    expect(thanks).toContain('Thank you! The Full Game is unlocked.');
    expect(thanks).not.toContain('data-act="buy"');
    expect(thanks).toContain('data-act="back"'); // Android Back
  });
});

// ------------------------------------------------------------------ The billing wrapper

const CANCELLED = 6777006;
const BLOCKED = 6777033;

/** A stand-in for the plugin's CdvPurchase global. */
function fakePlugin(opts: { owned?: boolean; listed?: boolean; initErrors?: CdvError[]; receipts?: boolean } = {}) {
  let owned = opts.owned ?? false;
  const listed = opts.listed ?? true;
  const cb: Record<string, ((x: never) => void)[]> = {};
  const on = (k: string) => (f: (x: never) => void) => ((cb[k] ??= []).push(f), when);
  const fire = (k: string, x?: unknown) => (cb[k] ?? []).forEach((f) => f(x as never));
  const when = {
    productUpdated: on('productUpdated'),
    approved: on('approved'),
    pending: on('pending'),
    finished: on('finished'),
    receiptsReady: on('receiptsReady'),
  };
  const finish = vi.fn(() => Promise.resolve());
  const tx = (state: string, id = 'full_game'): CdvTransaction => ({ state, products: [{ id }], finish });
  let orderResult: () => Promise<CdvError | undefined> = async () => {
    owned = true;
    fire('approved', tx('approved'));
    return undefined;
  };
  const product: CdvProduct = {
    id: 'full_game',
    get owned() {
      return owned;
    },
    pricing: { price: '€2.99' },
    getOffer: () => ({ order: () => orderResult() }),
  };
  const restorePurchases = vi.fn(async (): Promise<CdvError | undefined> => undefined);
  const register = vi.fn();
  const ns: CdvNamespace = {
    ProductType: { NON_CONSUMABLE: 'non consumable' },
    Platform: { GOOGLE_PLAY: 'android-playstore' },
    ErrorCode: { PAYMENT_CANCELLED: CANCELLED, STORE_BLOCKED: BLOCKED },
    LogLevel: { WARNING: 2 },
    store: {
      verbosity: 0,
      register,
      initialize: async () => {
        if (opts.initErrors?.length) return opts.initErrors;
        if (listed) fire('productUpdated', product);
        if (opts.receipts !== false) fire('receiptsReady');
        fire('ready');
        return [];
      },
      when: () => when,
      ready: (f) => void on('ready')(f as never),
      error: (f) => void on('error')(f as never),
      get: () => (listed ? product : undefined),
      owned: () => owned,
      update: vi.fn(async () => {}),
      restorePurchases,
    },
  };
  return {
    ns,
    fire,
    tx,
    finish,
    register,
    restorePurchases,
    setOwned: (v: boolean) => (owned = v),
    setOrder: (f: () => Promise<CdvError | undefined>) => (orderResult = f),
  };
}

function wrapper(plugin: ReturnType<typeof fakePlugin> | null, verdictMs = 30) {
  const events = { owned: vi.fn(), notOwned: vi.fn(), changed: vi.fn() };
  const p = new Purchases(events, () => plugin?.ns, 30, verdictMs);
  return { p, events };
}

describe('Purchases (cordova-plugin-purchase wrapper)', () => {
  it('registers full_game as a non-consumable Google Play product and reads the price', async () => {
    const f = fakePlugin();
    const { p, events } = wrapper(f);
    await p.init();
    expect(f.register).toHaveBeenCalledWith({ id: 'full_game', type: 'non consumable', platform: 'android-playstore' });
    expect(p.status).toBe('ready');
    expect(p.price).toBe('€2.99');
    // Loaded, not owned: the start check reports it (a refund would take the local copy away).
    expect(events.notOwned).toHaveBeenCalledTimes(1);
    expect(events.owned).not.toHaveBeenCalled();
  });

  it('owned at start: reported as owned, never as not owned', async () => {
    const f = fakePlugin({ owned: true });
    const { p, events } = wrapper(f);
    await p.init();
    expect(events.owned).toHaveBeenCalled();
    expect(events.notOwned).not.toHaveBeenCalled();
  });

  it('purchase: approved is acknowledged (finish) and reported owned', async () => {
    const f = fakePlugin();
    const { p, events } = wrapper(f);
    await p.init();
    expect(await p.buy()).toEqual({ kind: 'owned' });
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(events.owned).toHaveBeenCalled();
    expect(p.buying).toBe(false);
    // Buying again: already owned, no second sheet.
    expect(await p.buy()).toEqual({ kind: 'owned' });
  });

  it('a failed acknowledgement does not crash or undo the purchase', async () => {
    const f = fakePlugin();
    f.finish.mockImplementation(() => Promise.reject(new Error('FINISH')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p, events } = wrapper(f);
    await p.init();
    expect((await p.buy()).kind).toBe('owned');
    await new Promise((r) => setTimeout(r, 0));
    expect(events.owned).toHaveBeenCalled();
  });

  it('cancelled: nothing changes and no error is shown', async () => {
    const f = fakePlugin();
    f.setOrder(async () => ({ code: CANCELLED, message: 'USER_CANCELED' }));
    const { p, events } = wrapper(f);
    await p.init();
    expect(await p.buy()).toEqual({ kind: 'cancelled' });
    expect(p.lastError).toBeNull();
    expect(events.owned).not.toHaveBeenCalled();
  });

  it('pending payment: reported as pending, not owned, and the start check does not take anything away', async () => {
    const f = fakePlugin();
    f.setOrder(async () => {
      f.fire('pending', f.tx('pending'));
      return undefined;
    });
    const { p, events } = wrapper(f);
    await p.init();
    events.notOwned.mockClear();
    expect(await p.buy()).toEqual({ kind: 'pending' });
    expect(p.pending).toBe(true);
    expect(events.owned).not.toHaveBeenCalled();
    f.fire('receiptsReady');
    expect(events.notOwned).not.toHaveBeenCalled();
    // The payment clears later: approved, acknowledged, owned.
    f.setOwned(true);
    f.fire('approved', f.tx('approved'));
    expect(events.owned).toHaveBeenCalled();
    expect(p.pending).toBe(false);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.finish).toHaveBeenCalled();
  });

  it('no verdict yet after the sheet closes: "processing"', async () => {
    const f = fakePlugin();
    f.setOrder(async () => undefined);
    const { p } = wrapper(f, 20);
    await p.init();
    expect(await p.buy()).toEqual({ kind: 'processing' });
  });

  it('other products and errors from order() are handled', async () => {
    const f = fakePlugin();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p, events } = wrapper(f);
    await p.init();
    f.fire('approved', f.tx('approved', 'something_else'));
    expect(events.owned).not.toHaveBeenCalled();
    f.setOrder(async () => ({ code: 6777003, message: 'Service disconnected' }));
    const r = await p.buy();
    expect(r.kind).toBe('error');
    expect((r as { message: string }).message).toMatch(/can't be reached/);
    f.setOrder(async () => {
      throw new Error('native crash');
    });
    expect((await p.buy()).kind).toBe('error');
  });

  it('"already owned" from Play counts as owned', async () => {
    const f = fakePlugin();
    f.setOrder(async () => {
      f.setOwned(true);
      return { code: 6777003, message: 'ITEM_ALREADY_OWNED' };
    });
    const { p } = wrapper(f);
    await p.init();
    expect(await p.buy()).toEqual({ kind: 'owned' });
  });

  it('restore: owned, nothing found (which may take a refunded copy away), or an error', async () => {
    const f = fakePlugin({ receipts: false });
    const { p, events } = wrapper(f);
    await p.init();
    expect(events.notOwned).not.toHaveBeenCalled(); // purchases never loaded: no verdict
    expect(await p.restore()).toEqual({ kind: 'none' });
    expect(events.notOwned).toHaveBeenCalledTimes(1);
    f.setOwned(true);
    expect(await p.restore()).toEqual({ kind: 'owned' });
    expect(events.owned).toHaveBeenCalled();
    const g = fakePlugin({ receipts: false });
    g.restorePurchases.mockResolvedValue({ code: 6777004, message: 'network error' });
    const w = wrapper(g);
    await w.p.init();
    expect((await w.p.restore()).kind).toBe('error');
    expect(w.events.notOwned).not.toHaveBeenCalled();
  });

  it('offline at start: unavailable, the local copy stands, Buy and Restore say why and retry', async () => {
    const f = fakePlugin({ initErrors: [{ code: 6777001, message: 'Billing service unavailable on device' }] });
    const { p, events } = wrapper(f);
    await p.init();
    expect(p.status).toBe('unavailable');
    expect(p.lastError).toMatch(/can't be reached/);
    expect(events.notOwned).not.toHaveBeenCalled();
    expect(events.owned).not.toHaveBeenCalled();
    expect((await p.buy()).kind).toBe('unavailable');
    expect((await p.restore()).kind).toBe('unavailable');
    expect(f.ns.store.update).toHaveBeenCalled();
    // The plugin's own retry gets through later.
    f.fire('productUpdated', f.ns.store.get('full_game'));
    f.fire('receiptsReady');
    f.fire('ready');
    expect(p.status).toBe('ready');
  });

  it('a store blocked by parental controls says so', async () => {
    const f = fakePlugin({ initErrors: [{ code: BLOCKED, message: 'Play Store is blocked' }] });
    const { p } = wrapper(f);
    await p.init();
    expect(p.lastError).toMatch(/blocked on this device/);
  });

  it('product not set up in the Play Console: Buy explains, nothing is taken away', async () => {
    const f = fakePlugin({ listed: false });
    const { p, events } = wrapper(f);
    await p.init();
    expect(events.notOwned).not.toHaveBeenCalled();
    const r = await p.buy();
    expect(r).toEqual({ kind: 'unavailable', message: expect.stringMatching(/not available in the store/) });
  });

  it('no plugin (web, an old APK): unavailable after the wait, never throws', async () => {
    const { p, events } = wrapper(null);
    await expect(p.init()).resolves.toBeUndefined();
    expect(p.status).toBe('unavailable');
    expect((await p.buy()).kind).toBe('unavailable');
    expect((await p.restore()).kind).toBe('unavailable');
    expect(events.owned).not.toHaveBeenCalled();
  });

  it('a plugin that throws while starting does not crash the game', async () => {
    const f = fakePlugin();
    f.register.mockImplementation(() => {
      throw new Error('bad plugin');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { p } = wrapper(f);
    await expect(p.init()).resolves.toBeUndefined();
    expect(p.status).toBe('unavailable');
  });

  it('wired to the entitlement: buy unlocks, a refund found at start locks again', async () => {
    const { fg } = android(true);
    const f = fakePlugin(); // the store does not have it (refunded)
    const p = new Purchases({ owned: () => fg.storeSays(true), notOwned: () => fg.storeSays(false) }, () => f.ns, 30, 30);
    await p.init();
    expect(fg.unlocked).toBe(false);
    await p.buy();
    expect(fg.unlocked).toBe(true);
  });
});

// ------------------------------------------------------------------ Campaign sets: chains, Next track, card taps

describe('campaign sets: each set has its own unlock chain, and nothing locked starts', () => {
  const finish = (app: App, id: string) => app.store.addFinish(`c:${id}`, 30000, []);
  const ids = (set: string) => campaign().filter((c) => c.id.startsWith(set)).map((c) => c.id);

  it('the first track of every set is open from the start; the rest wait for the one before (Stadium unchanged)', () => {
    setFullGame(new FullGame('web', memory(false).persist));
    const app = shell();
    for (const id of ['A01', 'D01', 'W01']) expect(app.chainLocked(idOf(id)), id).toBe(false);
    for (const id of ['A02', 'A12', 'D02', 'D06', 'W02', 'W06']) expect(app.chainLocked(idOf(id)), id).toBe(true);
    // Finishing the last Stadium track opens nothing in the other sets.
    for (const id of ids('A')) finish(app, id);
    expect(app.chainLocked(idOf('D02'))).toBe(true);
    expect(app.chainLocked(idOf('W02'))).toBe(true);
    finish(app, 'D01');
    expect(app.chainLocked(idOf('D02'))).toBe(false);
    expect(app.chainLocked(idOf('D03'))).toBe(true);
    expect(app.chainLocked(idOf('W02'))).toBe(true);
  });

  it('startRace and playRace refuse a chain-locked track (campaign menu instead, no ad, no race)', async () => {
    setFullGame(new FullGame('web', memory(false).persist));
    const app = shell();
    expect(app.startRace(app.campaignEntry(idOf('D02')))).toBe(false);
    expect(app.startRace(app.campaignEntry(idOf('A02')))).toBe(false);
    expect(app.setMode).not.toHaveBeenCalled();
    expect(lastScreen()[1]).toContain('campaign');
    await app.playRace(app.campaignEntry(idOf('W03')));
    expect(app.ads.interstitial).not.toHaveBeenCalled();
    expect(app.setMode).not.toHaveBeenCalled();
    // D01 and W01 start on a fresh profile.
    expect(app.startRace(app.campaignEntry(idOf('D01')))).toBe(true);
    expect(app.startRace(app.campaignEntry(idOf('W01')))).toBe(true);
    finish(app, 'D01');
    expect(app.startRace(app.campaignEntry(idOf('D02')))).toBe(true);
  });

  it('without the Full Game a finished D01 still leaves D02 behind the Full Game lock', () => {
    android(false);
    const app = shell();
    finish(app, 'D01');
    finish(app, 'W01');
    expect(app.chainLocked(idOf('D02'))).toBe(false);
    expect(app.entryLock(app.campaignEntry(idOf('D02')))).toBe('track');
    expect(app.startRace(app.campaignEntry(idOf('D02')))).toBe(false);
    expect(app.startRace(app.campaignEntry(idOf('W02')))).toBe(false);
    expect(app.setMode).not.toHaveBeenCalled();
    expect(storeShown()).toBe(true);
  });

  it('Next track stays in the set: A12, D06 and W06 have none, D01 leads to D02', () => {
    setFullGame(new FullGame('web', memory(false).persist));
    const app = shell();
    const next = (id: string) => app.nextCampaignEntry(app.campaignEntry(idOf(id)))?.base ?? null;
    expect(next('A01')).toBe('c:A02');
    expect(next('A11')).toBe('c:A12');
    expect(next('A12')).toBeNull();
    expect(next('D01')).toBe('c:D02');
    expect(next('D06')).toBeNull();
    expect(next('W05')).toBe('c:W06');
    expect(next('W06')).toBeNull();
    // It keeps the run's vehicle and wall mode.
    expect(app.nextCampaignEntry(app.campaignEntry(idOf('W01'), 'truck', true))).toMatchObject({ base: 'c:W02', vehicle: 'truck', walls: true });
  });

  it('a card tap starts the track the card shows, never one of another set', () => {
    setFullGame(new FullGame('web', memory(false).persist));
    const app = shell();
    const playRace = vi.spyOn(app, 'playRace').mockResolvedValue();
    app.campaignMenu();
    lastScreen()[2].set({ dataset: { v: 'desert' } } as unknown as HTMLElement);
    const [html, , handlers] = lastScreen();
    expect(html).toContain(`data-act="race" data-i="${idOf('D01')}" data-id="D01"`);
    // A stale tap (the Stadium tab's A01 card at the same spot) does nothing on the Desert tab.
    handlers.race({ dataset: { i: '0', id: 'A01' } } as unknown as HTMLElement);
    expect(playRace).not.toHaveBeenCalled();
    handlers.race({ dataset: { i: String(idOf('D01')), id: 'D01' } } as unknown as HTMLElement);
    expect(playRace).toHaveBeenCalledTimes(1);
    expect(playRace.mock.calls[0][0]).toMatchObject({ base: 'c:D01', campaignIndex: idOf('D01') });
  });
});
