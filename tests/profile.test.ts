import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../src/core/constants';
import {
  DEFAULT_CAR_COLOR,
  DEFAULT_NAME,
  migrateProfile,
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
      showBadge: true,
      setupDone: false,
    });
  });

  it('prefers the stored profile over legacy values', () => {
    const p = migrateProfile(
      { name: 'Ana', carColor: '#ff4fa3', carBody: 'buggy', showBadge: false, setupDone: true },
      { playerName: 'Max', carColor: '#2f6fd6' },
    );
    expect(p).toEqual({ name: 'Ana', carColor: '#ff4fa3', carBody: 'buggy', showBadge: false, setupDone: true });
  });

  it('sanitises tampered values', () => {
    const p = migrateProfile({ name: '<b>', carColor: 'red', carBody: 'tank', showBadge: 'no', setupDone: 'yes' }, {});
    expect(p).toEqual({ name: '<b>', carColor: DEFAULT_CAR_COLOR, carBody: 'racer', showBadge: true, setupDone: false });
  });

  it('survives non-object input', () => {
    for (const raw of [null, 5, 'x', [1, 2]]) expect(migrateProfile(raw, {}).name).toBe(DEFAULT_NAME);
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
    expect(st.profile).toEqual({ name: DEFAULT_NAME, carColor: DEFAULT_CAR_COLOR, carBody: 'racer', showBadge: true, setupDone: false });
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
