import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../src/core/constants';
import {
  DEFAULT_CAR_COLOR,
  DEFAULT_NAME,
  DEFAULT_SETTINGS,
  migrateProfile,
  migrateSettings,
  PROFILE_VERSION,
  sanitizeColor,
  sanitizeName,
  Store,
} from '../src/game/storage';
import { cropRect } from '../src/ui/photo';

/** localStorage stand-in; `failSet` makes setItem throw for matching keys (quota). */
class MapStorage {
  readonly map = new Map<string, string>();
  failSet: (key: string) => boolean = () => false;
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet(k)) throw new Error('QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function useStorage(init: Record<string, string> = {}): MapStorage {
  const ls = new MapStorage();
  for (const [k, v] of Object.entries(init)) ls.map.set(k, v);
  vi.stubGlobal('localStorage', ls);
  return ls;
}

const photo = (c: string) => `data:image/jpeg;base64,${c.repeat(40)}==`;
const A = photo('A');
const B = photo('B');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeName('  Max   the\tDriver ')).toBe('Max the Driver');
  });

  it('strips control characters and bidi overrides', () => {
    expect(sanitizeName('Ma\u0000x\u0007')).toBe('Max');
    expect(sanitizeName('‮evil‬')).toBe('evil');
    expect(sanitizeName('a​b⁦c﻿')).toBe('abc');
  });

  it('falls back to the default name', () => {
    expect(sanitizeName('')).toBe(DEFAULT_NAME);
    expect(sanitizeName('   ')).toBe(DEFAULT_NAME);
    expect(sanitizeName(undefined)).toBe(DEFAULT_NAME);
    expect(sanitizeName(42)).toBe(DEFAULT_NAME);
  });

  it('keeps at most 20 code points and never splits an emoji', () => {
    expect(sanitizeName('x'.repeat(30))).toBe('x'.repeat(20));
    const s = sanitizeName('\u{1F3CE}'.repeat(25));
    expect(Array.from(s)).toHaveLength(20);
    expect(s).toBe('\u{1F3CE}'.repeat(20));
  });

  it('keeps zero-width joiners, which emoji sequences and some scripts need', () => {
    const astronaut = String.fromCodePoint(0x1f469, 0x200d, 0x1f680) + ' Asha';
    expect(sanitizeName(astronaut)).toBe(astronaut);
    const zwnj = 'mi' + String.fromCharCode(0x200c) + 'kh';
    expect(sanitizeName(zwnj)).toBe(zwnj);
  });
});

describe('sanitizeColor', () => {
  it('accepts #rrggbb and lower-cases it', () => {
    expect(sanitizeColor('#2F6FD6')).toBe('#2f6fd6');
  });

  it('falls back on anything else', () => {
    for (const v of ['red', '#fff', '#12345g', 'url(x)', null, 7]) expect(sanitizeColor(v)).toBe(DEFAULT_CAR_COLOR);
    expect(sanitizeColor('nope', '#000000')).toBe('#000000');
  });
});

describe('migrateProfile', () => {
  it('takes name and colour from legacy settings', () => {
    expect(migrateProfile(null, { playerName: 'Max', carColor: '#2f6fd6' })).toEqual({
      name: 'Max',
      carColor: '#2f6fd6',
      carBody: 'racer',
      vehicle: 'car',
      models: {},
      showBadge: true,
      setupDone: false,
    });
  });

  it('prefers the stored profile over legacy values', () => {
    const p = migrateProfile(
      { name: 'Ana', carColor: '#ff4fa3', carBody: 'buggy', showBadge: false, setupDone: true },
      { playerName: 'Max', carColor: '#2f6fd6' },
    );
    expect(p).toEqual({ name: 'Ana', carColor: '#ff4fa3', carBody: 'buggy', vehicle: 'car', models: {}, showBadge: false, setupDone: true });
  });

  it('sanitises tampered values', () => {
    const p = migrateProfile({ name: '<b>', carColor: 'red', carBody: 'tank', vehicle: 'boat', showBadge: 'no', setupDone: 'yes' }, {});
    expect(p).toEqual({ name: '<b>', carColor: DEFAULT_CAR_COLOR, carBody: 'racer', vehicle: 'car', models: {}, showBadge: true, setupDone: false });
  });

  it('keeps a realistic model per class and drops unknown or mismatched ones', () => {
    const p = migrateProfile({ models: { car: 'coupe', bike: 'cafe', truck: 'lct3000' } }, {});
    expect(p.models).toEqual({ car: 'coupe', bike: 'cafe', truck: 'lct3000' });
    // A removed model, a car model on the bike, junk: back to Classic.
    const q = migrateProfile({ models: { car: 'tank', bike: 'sport', truck: 7, boat: 'cafe' } }, {});
    expect(q.models).toEqual({});
    expect(migrateProfile({ models: ['sport'] }, {}).models).toEqual({});
  });

  it('survives non-object input', () => {
    for (const raw of [null, 5, 'x', [1, 2]]) expect(migrateProfile(raw, {}).name).toBe(DEFAULT_NAME);
  });
});

describe('migrateSettings', () => {
  it('gives the defaults for nothing stored', () => {
    expect(migrateSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ steerMode: 'buttons', pedals: 'bars', tiltSensitivity: 0.5, tiltCenter: 0, tilt: false });
  });

  it('turns the old tilt switch into tilt steering', () => {
    expect(migrateSettings({ tilt: true })).toMatchObject({ steerMode: 'tilt', tilt: true });
    expect(migrateSettings({ tilt: false })).toMatchObject({ steerMode: 'buttons', tilt: false });
  });

  it('keeps a saved steering mode, with `tilt` (written by every build) deciding tilt', () => {
    expect(migrateSettings({ steerMode: 'wheel', tilt: false }).steerMode).toBe('wheel');
    expect(migrateSettings({ steerMode: 'wheel' }).steerMode).toBe('wheel');
    expect(migrateSettings({ steerMode: 'tilt', tilt: true }).steerMode).toBe('tilt');
    // An older APK turned tilt off, or on, after a downgrade.
    expect(migrateSettings({ steerMode: 'tilt', tilt: false }).steerMode).toBe('buttons');
    expect(migrateSettings({ steerMode: 'wheel', tilt: true }).steerMode).toBe('tilt');
  });

  it('keeps traction control and the racing line, with off and normal for anything else', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ tractionControl: 'normal', racingLine: false });
    expect(migrateSettings({ tractionControl: 'low', racingLine: true })).toMatchObject({ tractionControl: 'low', racingLine: true });
    // An unknown level (a future 'off', say) or a tampered flag falls back.
    expect(migrateSettings({ tractionControl: 'off', racingLine: 'yes' })).toMatchObject({ tractionControl: 'normal', racingLine: false });
  });

  it('falls back on or clamps tampered values', () => {
    const s = migrateSettings({
      steerMode: 'x',
      pedals: 7,
      tiltSensitivity: Number.NaN,
      tiltCenter: 99,
      autoAccelerate: 'yes',
      controlsTipShown: 1,
      tiltCenterSet: 'yes',
    });
    expect(s).toMatchObject({ steerMode: 'buttons', pedals: 'bars', tiltSensitivity: 0.5, tiltCenter: 30, autoAccelerate: false, controlsTipShown: false, tiltCenterSet: false });
    expect(migrateSettings({ tiltCenter: 8, tiltCenterSet: true })).toMatchObject({ tiltCenter: 8, tiltCenterSet: true });
    expect(migrateSettings({ tiltSensitivity: -3, tiltCenter: -99, pedals: 'buttons' })).toMatchObject({
      tiltSensitivity: 0,
      tiltCenter: -30,
      pedals: 'buttons',
    });
    expect(migrateSettings({ tiltSensitivity: '0.9' }).tiltSensitivity).toBe(0.5);
  });

  it('keeps legacy and other keys', () => {
    const s = migrateSettings({ playerName: 'Max', carColor: '#2f6fd6', quality: 'low', autoAccelerate: true }) as unknown as Record<string, unknown>;
    expect(s).toMatchObject({ playerName: 'Max', carColor: '#2f6fd6', quality: 'low', autoAccelerate: true });
  });
});

describe('Store settings', () => {
  it('writes tilt for older APKs from the steering mode', () => {
    const ls = useStorage({ 'vb.settings': JSON.stringify({ tilt: true, playerName: 'Max' }) });
    const st = new Store();
    expect(st.settings.steerMode).toBe('tilt');
    st.settings.steerMode = 'wheel';
    st.saveSettings();
    const saved = JSON.parse(ls.getItem('vb.settings')!);
    expect(saved).toMatchObject({ steerMode: 'wheel', tilt: false, playerName: 'Max' });
    st.settings.steerMode = 'tilt';
    st.saveSettings();
    expect(JSON.parse(ls.getItem('vb.settings')!).tilt).toBe(true);
    expect(new Store().settings.steerMode).toBe('tilt');
  });
});

describe('migrateSettings: tilt tuning', () => {
  it('defaults to the feel of earlier builds, with the analog steering assist on', () => {
    expect(migrateSettings({})).toMatchObject({ tiltDeadzone: 1.5, tiltSmoothing: 0.5, tiltCurve: 0, analogSteer: true });
  });

  it('keeps a continuous sensitivity (the slider) and clamps tampered tuning', () => {
    expect(migrateSettings({ tiltSensitivity: 0.5125 }).tiltSensitivity).toBe(0.5125);
    expect(migrateSettings({ tiltDeadzone: -3, tiltSmoothing: 'x', tiltCurve: 2 })).toMatchObject({ tiltDeadzone: 0, tiltSmoothing: 0.5, tiltCurve: 1 });
    expect(migrateSettings({ tiltDeadzone: 9 }).tiltDeadzone).toBe(6);
    expect(migrateSettings({ tiltDeadzone: 3.5, tiltSmoothing: 0.8, tiltCurve: 0.25 })).toMatchObject({ tiltDeadzone: 3.5, tiltSmoothing: 0.8, tiltCurve: 0.25 });
    expect(migrateSettings({ analogSteer: false }).analogSteer).toBe(false);
    expect(migrateSettings({ analogSteer: 'no' }).analogSteer).toBe(true);
  });
});

describe('cropRect', () => {
  it('centres landscape crops', () => {
    expect(cropRect(4000, 3000)).toEqual({ sx: 500, sy: 0, s: 3000 });
  });

  it('biases portrait crops towards the top', () => {
    expect(cropRect(3000, 4000)).toEqual({ sx: 0, sy: 300, s: 3000 });
  });

  it('leaves squares alone', () => {
    expect(cropRect(500, 500)).toEqual({ sx: 0, sy: 0, s: 500 });
  });
});

describe('Store profile', () => {
  it('migrates legacy settings and keeps the legacy keys', () => {
    const ls = useStorage({ 'vb.settings': JSON.stringify({ playerName: 'Max', carColor: '#2f6fd6', quality: 'low' }) });
    const st = new Store();
    expect(st.profile.name).toBe('Max');
    expect(st.profile.carColor).toBe('#2f6fd6');
    expect(st.returningPlayer).toBe(true);
    const saved = JSON.parse(ls.getItem('vb.profile')!);
    expect(saved).toMatchObject({ v: PROFILE_VERSION, name: 'Max', carColor: '#2f6fd6', carBody: 'racer', setupDone: false });
    st.settings.camera = 'hood';
    st.saveSettings();
    const settings = JSON.parse(ls.getItem('vb.settings')!);
    expect(settings).toMatchObject({ playerName: 'Max', carColor: '#2f6fd6', quality: 'low', camera: 'hood' });
  });

  it('keeps returningPlayer stable across a relaunch on the setup page', () => {
    useStorage({ 'vb.settings': JSON.stringify({ quality: 'low' }) });
    expect(new Store().returningPlayer).toBe(true);
    // 'vb.profile' now exists with setupDone false.
    expect(new Store().returningPlayer).toBe(true);
  });

  it('starts a fresh install with defaults', () => {
    useStorage();
    const st = new Store();
    expect(st.returningPlayer).toBe(false);
    expect(st.profile).toEqual({ name: DEFAULT_NAME, carColor: DEFAULT_CAR_COLOR, carBody: 'racer', vehicle: 'car', models: {}, showBadge: true, setupDone: false });
    expect(st.profilePhoto()).toBeNull();
    // Its own writes (profile, finished) do not make the next launch a returning player.
    expect(new Store().returningPlayer).toBe(false);
  });

  it('counts old records as a returning player', () => {
    useStorage({ 'vb.records.v3': JSON.stringify({ 'c:A01': { best: 1, cpTimes: [], finishes: 1 } }) });
    expect(new Store().returningPlayer).toBe(true);
  });

  it('migrates again next launch when the profile write failed', () => {
    const ls = useStorage({ 'vb.settings': JSON.stringify({ playerName: 'Max' }) });
    ls.failSet = (k) => k === 'vb.profile';
    const st = new Store();
    expect(st.saveProfile()).toBe(false);
    st.saveSettings();
    expect(ls.getItem('vb.profile')).toBeNull();
    ls.failSet = () => false;
    expect(new Store().profile.name).toBe('Max');
  });

  it('saves the profile with setupDone', () => {
    const ls = useStorage();
    const st = new Store();
    st.profile.setupDone = true;
    st.profile.carBody = 'muscle';
    st.profile.showBadge = false;
    expect(st.saveProfile()).toBe(true);
    const again = new Store();
    expect(again.profile).toMatchObject({ setupDone: true, carBody: 'muscle', showBadge: false });
    expect(JSON.parse(ls.getItem('vb.profile')!).v).toBe(PROFILE_VERSION);
  });

  it('does not throw on null or number JSON', () => {
    for (const v of ['null', '5', '"x"', '[1]', '{bad']) {
      useStorage({ 'vb.settings': v, 'vb.profile': v, [`vb.records.v${PHYSICS_VERSION}`]: v, 'vb.finished': v });
      const st = new Store();
      expect(st.profile.name).toBe(DEFAULT_NAME);
      expect(st.settings.volume).toBe(0.7);
      vi.unstubAllGlobals();
    }
  });

  it('works without any storage', () => {
    vi.stubGlobal('localStorage', undefined);
    const st = new Store();
    expect(st.returningPlayer).toBe(false);
    expect(st.saveProfile()).toBe(false);
    expect(st.profilePhoto()).toBeNull();
    expect(st.saveProfilePhoto(A)).toBe(false);
    expect(st.profilePhoto()).toBe(A);
  });
});

describe('Store photo', () => {
  it('saves, reads back and removes a photo', () => {
    const ls = useStorage();
    const st = new Store();
    expect(st.saveProfilePhoto(A)).toBe(true);
    expect(ls.getItem('vb.profile.photo')).toBe(A);
    expect(new Store().profilePhoto()).toBe(A);
    expect(st.saveProfilePhoto(null)).toBe(true);
    expect(ls.getItem('vb.profile.photo')).toBeNull();
    expect(st.profilePhoto()).toBeNull();
  });

  it('keeps the stored photo when a new one hits the quota', () => {
    const ls = useStorage({ 'vb.profile.photo': A });
    const st = new Store();
    expect(st.profilePhoto()).toBe(A);
    ls.failSet = () => true;
    expect(st.saveProfilePhoto(B)).toBe(false);
    expect(st.profilePhoto()).toBe(B);
    expect(ls.getItem('vb.profile.photo')).toBe(A);
  });

  it('rejects unsafe values', () => {
    const ls = useStorage({ 'vb.profile.photo': A });
    const st = new Store();
    expect(st.saveProfilePhoto('javascript:x')).toBe(false);
    expect(st.saveProfilePhoto(`${A}" onerror="x`)).toBe(false);
    expect(st.profilePhoto()).toBe(A);
    expect(ls.getItem('vb.profile.photo')).toBe(A);
  });

  it('ignores a tampered stored photo', () => {
    useStorage({ 'vb.profile.photo': 'http://example.com/a.png' });
    expect(new Store().profilePhoto()).toBeNull();
  });
});

describe('Store progress', () => {
  const rec = (best: number) => ({ best, cpTimes: [], finishes: 1 });

  it('keeps campaign unlocks from older physics versions', () => {
    const ls = useStorage({
      'vb.records.v2': JSON.stringify({ 'c:A01': rec(1) }),
      'vb.records.v3': JSON.stringify({ 'c:A02': rec(2) }),
    });
    const st = new Store();
    expect(st.hasFinished('c:A01')).toBe(true);
    expect(st.hasFinished('c:A02')).toBe(true);
    expect(st.hasFinished('c:A03')).toBe(false);
    expect(st.record('c:A02')).toBeUndefined();
    expect(JSON.parse(ls.getItem('vb.finished')!).sort()).toEqual(['c:A01', 'c:A02']);
    st.addFinish('c:A03', 30000, [10000]);
    expect(st.hasFinished('c:A03')).toBe(true);
    expect(new Store().hasFinished('c:A03')).toBe(true);
  });

  it('clears custom-track author times set under older physics, once, and keeps the tracks', () => {
    const track = (id: string, authorTime?: number) => ({ id, updated: 1, data: { name: id, author: 'Max', blocks: [], authorTime } });
    const ls = useStorage({
      'vb.tracks': JSON.stringify([track('a', 12345), track('b')]),
      'vb.editor.draft': JSON.stringify(track('d', 999)),
    });
    const st = new Store();
    expect(st.customTracks().map((t) => [t.id, t.data.authorTime])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
    expect(st.editorDraft()?.data.authorTime).toBeUndefined();
    expect(JSON.parse(ls.getItem('vb.tracks.physics')!)).toBe(PHYSICS_VERSION);
    // A time set under this version survives the next launch.
    st.saveCustomTrack(track('a', 4321));
    expect(new Store().customTracks().find((t) => t.id === 'a')?.data.authorTime).toBe(4321);
  });

  it('resetProgress keeps the profile and photo but clears unlocks for good', () => {
    const ls = useStorage({
      'vb.settings': JSON.stringify({ playerName: 'Max' }),
      'vb.records.v3': JSON.stringify({ 'c:A01': rec(1) }),
      [`vb.ghost.v${PHYSICS_VERSION}.c:A01`]: 'ghost',
    });
    const st = new Store();
    st.saveProfilePhoto(A);
    st.addFinish('c:A02', 1, []);
    st.resetProgress();
    expect(st.hasFinished('c:A01')).toBe(false);
    expect(st.hasFinished('c:A02')).toBe(false);
    expect(ls.getItem('vb.profile')).not.toBeNull();
    expect(ls.getItem('vb.profile.photo')).toBe(A);
    expect(ls.getItem(`vb.ghost.v${PHYSICS_VERSION}.c:A01`)).toBeNull();
    // The old records are still there but must not re-seed the unlocks.
    expect(ls.getItem('vb.records.v3')).not.toBeNull();
    const again = new Store();
    expect(again.hasFinished('c:A01')).toBe(false);
    expect(again.profile.name).toBe('Max');
    expect(again.profilePhoto()).toBe(A);
  });

  it('prunes ghosts of older physics versions only', () => {
    const cur = `vb.ghost.v${PHYSICS_VERSION}.c:A01`;
    const ls = useStorage({
      'vb.ghost.v1.c:A01': 'old',
      [`vb.ghost.v${PHYSICS_VERSION - 1}.c:A01`]: 'old',
      [`vb.ghost.v${PHYSICS_VERSION}0.c:A01`]: 'other',
      [cur]: 'current',
      'vb.records.v3': JSON.stringify({}),
      'vb.profile.photo': A,
    });
    new Store();
    expect(ls.getItem('vb.ghost.v1.c:A01')).toBeNull();
    expect(ls.getItem(`vb.ghost.v${PHYSICS_VERSION - 1}.c:A01`)).toBeNull();
    expect(ls.getItem(`vb.ghost.v${PHYSICS_VERSION}0.c:A01`)).toBeNull();
    expect(ls.getItem(cur)).toBe('current');
    expect(ls.getItem('vb.records.v3')).not.toBeNull();
    expect(ls.getItem('vb.profile.photo')).toBe(A);
  });
});

describe('home card', () => {
  it('escapes the name and only puts validated values into attributes', async () => {
    const { homeCardHtml } = await import('../src/app/profileScreen');
    const app = {
      store: {
        profile: { name: '<img src=x onerror=alert(1)>', carColor: '#2f6fd6', carBody: 'buggy', showBadge: true, setupDone: true },
        profilePhoto: () => A,
      },
    } as unknown as Parameters<typeof homeCardHtml>[0];
    const html = homeCardHtml(app);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain(`src="${A}"`);
    expect(html).toContain('border-color:#2f6fd6');
    expect(html).toContain('Buggy');
    expect(html).toContain('data-act="profile"');
    // Not a .btn, so the home screen's auto-focus still lands on Play.
    expect(html).not.toMatch(/class="[^"]*\bbtn\b/);
  });
});

describe('Vehicle tab', () => {
  const profile = (vehicle: string) => migrateProfile({ vehicle, carBody: 'muscle' }, {});

  it('picks Car, Bike or Truck; the body styles are the car only', async () => {
    const { carHtml } = await import('../src/app/profileScreen');
    const car = carHtml(profile('car'));
    expect(car.match(/data-act="vehicle"/g)).toHaveLength(3);
    expect(car).toMatch(/data-act="vehicle" data-v="car" role="radio" aria-checked="true"/);
    expect(car.match(/data-act="body"/g)).toHaveLength(4);
    expect(car).toMatch(/data-b="muscle" role="radio" aria-checked="true"/);
    const bike = carHtml(profile('bike'));
    expect(bike).toMatch(/data-act="vehicle" data-v="bike" role="radio" aria-checked="true"/);
    expect(bike).not.toContain('data-act="body"');
    expect(bike).toContain('Own records and medals');
    // The colour is shared by every vehicle.
    expect(bike).toContain('data-act="color"');
  });

  it("keeps a realistic bike's or truck's note whole (it may wrap); only the car's is cut to one line", async () => {
    const { carHtml } = await import('../src/app/profileScreen');
    const real = (vehicle: string) => carHtml(migrateProfile({ vehicle, models: { car: 'sport', bike: 'cafe', truck: 'lct3000' } }, {}));
    expect(real('bike')).toMatch(/<div class="body-note" title="/);
    expect(real('bike')).toContain('Factory paint: the rider wears your colour');
    expect(real('truck')).toMatch(/<div class="body-note" title="/);
    expect(real('car')).toMatch(/<div class="body-note one-line" title="/);
    expect(carHtml(profile('car'))).toMatch(/<div class="body-note one-line"/);
    expect(carHtml(profile('bike'))).toMatch(/<div class="body-note" title="/);
  });

  it('the home card names the Bike or Truck instead of a car body', async () => {
    const { homeCardHtml } = await import('../src/app/profileScreen');
    const card = (vehicle: string) =>
      homeCardHtml({ store: { profile: profile(vehicle), profilePhoto: () => null } } as unknown as Parameters<typeof homeCardHtml>[0]);
    expect(card('truck')).toContain('Truck');
    expect(card('car')).toContain('Muscle');
  });
});
