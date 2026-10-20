// Store with vehicle classes and wall modes: records and ghosts per entry key, campaign unlocks
// shared by every key of a track, and PB ghosts evicting the least recently used ones when
// localStorage is full.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { entryKey, type VehicleClass } from '../src/core/vehicles';
import { encodeGhost, type Ghost } from '../src/game/ghost';
import { Store } from '../src/game/storage';

/** localStorage stand-in with a quota on the total characters stored (keys and values). */
class QuotaStorage {
  readonly map = new Map<string, string>();
  constructor(public quota = Infinity) {}
  get length(): number {
    return this.map.size;
  }
  private size(skip?: string): number {
    let n = 0;
    for (const [k, v] of this.map) if (k !== skip) n += k.length + v.length;
    return n;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.size(k) + k.length + String(v).length > this.quota) throw new Error('QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function useStorage(quota = Infinity): QuotaStorage {
  const ls = new QuotaStorage(quota);
  vi.stubGlobal('localStorage', ls);
  return ls;
}

afterEach(() => vi.unstubAllGlobals());

/** A ghost of `samples` poses (8 floats each, about 43 base64 characters per pose). */
const ghost = (vehicle: VehicleClass = 'car', samples = 50): Ghost => ({
  physics: PHYSICS_VERSION,
  vehicle,
  rev: VEHICLE_REV[vehicle],
  time: 12340,
  interval: 2,
  cpTimes: [],
  samples: new Float32Array(samples * 8).map((_, i) => i * 0.25),
});

const gk = (key: string) => `vb.ghost.v${PHYSICS_VERSION}.${key}`;

describe('Store keys per vehicle and wall mode', () => {
  it('keeps records apart but unlocks the track for every key', () => {
    useStorage();
    const st = new Store();
    const bike = entryKey('c:A01', 'bike', false);
    st.addFinish(bike, 30000, []);
    expect(st.record(bike)?.best).toBe(30000);
    expect(st.record('c:A01')).toBeUndefined();
    expect(st.hasFinished('c:A01')).toBe(true);
    st.addFinish(entryKey('c:A02', 'car', true), 30000, []);
    expect(st.hasFinished('c:A02')).toBe(true);
    expect(st.record('c:A02')).toBeUndefined();
    // Kept across launches.
    expect(new Store().hasFinished('c:A01')).toBe(true);
    expect(new Store().hasFinished('c:A03')).toBe(false);
  });

  it('keeps unlocks through a class retune: the finished set holds track keys', () => {
    const ls = useStorage();
    // A bike finish saved under an older bike revision.
    ls.setItem('vb.finished', JSON.stringify(['c:A05']));
    const st = new Store();
    expect(st.hasFinished('c:A05')).toBe(true);
    expect(st.hasFinished(entryKey('c:A05', 'bike', true))).toBe(true);
    expect(st.hasFinished(entryKey('c:A05', 'truck', false))).toBe(true);
    expect(st.hasFinished('c:A06')).toBe(false);
  });

  it('seeds the finished tracks from the records of any key once', () => {
    const ls = useStorage();
    ls.setItem(`vb.records.v${PHYSICS_VERSION}`, JSON.stringify({ [entryKey('c:A04', 'truck', true)]: { best: 1, cpTimes: [], finishes: 1 } }));
    const st = new Store();
    expect(st.hasFinished('c:A04')).toBe(true);
    expect(JSON.parse(ls.getItem('vb.finished')!)).toEqual(['c:A04']);
  });

  it("loads a ghost only for the class and revision its key names", () => {
    const ls = useStorage();
    const st = new Store();
    const bike = entryKey('c:A01', 'bike', false);
    expect(st.saveGhost(bike, ghost('bike'))).toBe(true);
    expect(st.ghost(bike)?.vehicle).toBe('bike');
    // A car ghost under the bike's key (or a bike ghost of an older revision) never races.
    ls.setItem(gk(bike), encodeGhost(ghost('car')));
    expect(st.ghost(bike)).toBeNull();
    ls.setItem(gk(bike), encodeGhost({ ...ghost('bike'), rev: VEHICLE_REV.bike + 1 }));
    expect(st.ghost(bike)).toBeNull();
    st.saveGhost('c:A01|w', ghost('car'));
    expect(st.ghost('c:A01|w')?.vehicle).toBe('car');
  });

  it('clears the other classes\' custom author times with the car\'s after a physics bump', () => {
    const ls = useStorage();
    const track = { id: 't', updated: 1, data: { name: 'x', author: 'y', blocks: [], authorTime: 5000, authorTimes: { bike1: 6000 } } };
    ls.setItem('vb.tracks', JSON.stringify([track]));
    ls.setItem('vb.tracks.physics', JSON.stringify(PHYSICS_VERSION - 1));
    const st = new Store();
    const d = st.customTracks()[0].data as unknown as Record<string, unknown>;
    expect(d.authorTime).toBeUndefined();
    expect(d.authorTimes).toBeUndefined();
  });
});

describe('PB ghosts when storage is full', () => {
  /** A store whose quota leaves room for the base data and about `n` ghosts. */
  function full(n: number) {
    const ls = useStorage();
    const st = new Store();
    const one = gk('c:A01').length + encodeGhost(ghost()).length;
    let used = 0;
    for (const [k, v] of ls.map) used += k.length + v.length;
    ls.quota = used + n * one + 400; // room for the use list too
    return { ls, st };
  }

  it('evicts the least recently used ghost to save a new PB ghost', () => {
    const { ls, st } = full(3);
    expect(st.saveGhost('c:A01', ghost())).toBe(true);
    expect(st.saveGhost('c:A02', ghost())).toBe(true);
    expect(st.saveGhost('c:A03', ghost())).toBe(true);
    // Racing A01 again makes A02 the oldest.
    expect(st.ghost('c:A01')).not.toBeNull();
    expect(st.saveGhost('c:A04', ghost())).toBe(true);
    expect(ls.getItem(gk('c:A02'))).toBeNull();
    for (const k of ['c:A01', 'c:A03', 'c:A04']) expect(st.ghost(k)).not.toBeNull();
  });

  it('evicts ghosts this build never used (older saves) first', () => {
    const { ls, st } = full(2);
    ls.setItem(gk('c:A09'), encodeGhost(ghost()));
    expect(st.saveGhost('c:A01', ghost())).toBe(true);
    expect(st.saveGhost('c:A02', ghost())).toBe(true);
    expect(ls.getItem(gk('c:A09'))).toBeNull();
    expect(st.ghost('c:A01')).not.toBeNull();
  });

  it('replaces its own key in place and gives up when nothing can be evicted', () => {
    const { ls, st } = full(1);
    expect(st.saveGhost('c:A01', ghost())).toBe(true);
    expect(st.saveGhost('c:A01', ghost('car', 50))).toBe(true);
    // Far too big even for an empty store: nothing else is lost trying.
    expect(st.saveGhost('c:A02', ghost('car', 5000))).toBe(false);
    expect(ls.getItem(gk('c:A02'))).toBeNull();
    expect(st.ghost('c:A01')).not.toBeNull();
  });

  it('drops the older, slower ghost under the same key when the new PB ghost does not fit', () => {
    const { ls, st } = full(3);
    for (const k of ['c:A01', 'c:A02']) expect(st.saveGhost(k, ghost())).toBe(true);
    // A new A01 PB whose ghost is too big even with every other ghost evicted.
    expect(st.saveGhost('c:A01', ghost('car', 5000))).toBe(false);
    // Not the old run, which the record no longer matches; the other ghosts are put back.
    expect(ls.getItem(gk('c:A01'))).toBeNull();
    expect(st.ghost('c:A01')).toBeNull();
    expect(st.ghost('c:A02')).not.toBeNull();
  });

  it('puts the evicted ghosts back when the new one does not fit after all', () => {
    const { ls, st } = full(4);
    const keys = ['c:A01', 'c:A02', 'c:A03', 'c:A04'];
    for (const k of keys) expect(st.saveGhost(k, ghost())).toBe(true);
    const lru = ls.getItem('vb.ghost.lru');
    expect(st.saveGhost('u:long', ghost('car', 5000))).toBe(false);
    for (const k of keys) expect(ls.getItem(gk(k))).not.toBeNull();
    expect(ls.getItem(gk('u:long'))).toBeNull();
    expect(ls.getItem('vb.ghost.lru')).toBe(lru);
  });

  it('keeps the newest ghosts with no room to spare for the use list', () => {
    const ls = useStorage();
    const st = new Store();
    const one = gk('c:A01').length + encodeGhost(ghost()).length;
    let used = 0;
    for (const [k, v] of ls.map) used += k.length + v.length;
    ls.quota = used + 3 * one; // the list itself costs part of a ghost's room
    const keys = ['c:A01', 'c:A02', 'c:A03', 'c:A04', 'c:A05'];
    for (const k of keys) expect(st.saveGhost(k, ghost())).toBe(true);
    expect(ls.getItem(gk('c:A04'))).not.toBeNull();
    expect(ls.getItem(gk('c:A05'))).not.toBeNull();
    expect(ls.getItem(gk('c:A01'))).toBeNull();
    expect(ls.getItem(gk('c:A02'))).toBeNull();
    // Every stored ghost is in the use list, the newest last.
    const lru = JSON.parse(ls.getItem('vb.ghost.lru')!) as string[];
    expect(lru.slice(-2)).toEqual([gk('c:A04'), gk('c:A05')]);
    for (const k of ls.map.keys()) if (k.startsWith(gk(''))) expect(lru).toContain(k);
  });

  it('shortens the use list rather than leave a loaded ghost out of it', () => {
    const { ls, st } = full(3);
    for (const k of ['c:A01', 'c:A02']) st.saveGhost(k, ghost());
    // A ghost an older build saved (not in the list), then fill the rest so the list cannot grow.
    ls.setItem(gk('c:A09'), encodeGhost(ghost()));
    let used = 0;
    for (const [k, v] of ls.map) used += k.length + v.length;
    ls.setItem('vb.pad', 'x'.repeat(ls.quota - used - 'vb.pad'.length));
    expect(st.ghost('c:A09')).not.toBeNull();
    expect(JSON.parse(ls.getItem('vb.ghost.lru')!)).toEqual([gk('c:A02'), gk('c:A09')]);
  });

  it('evicts ghosts to keep a new record and its unlock, never the other way round', () => {
    const { ls, st } = full(3);
    for (const k of ['c:A01', 'c:A02', 'c:A03']) expect(st.saveGhost(k, ghost())).toBe(true);
    // Fill what is left: not even the record list fits any more.
    let used = 0;
    for (const [k, v] of ls.map) used += k.length + v.length;
    ls.setItem('vb.pad', 'x'.repeat(ls.quota - used - 'vb.pad'.length));
    const key = entryKey('c:A07', 'bike', true);
    expect(st.addFinish(key, 30000, [1, 2]).saved).toBe(true);
    // The least recently used ghost made room; the newest stays.
    expect(ls.getItem(gk('c:A01'))).toBeNull();
    expect(ls.getItem(gk('c:A03'))).not.toBeNull();
    // Both survive a relaunch.
    const again = new Store();
    expect(again.record(key)?.best).toBe(30000);
    expect(again.hasFinished('c:A07')).toBe(true);
  });

  it('says so when a record cannot be stored even without ghosts', () => {
    const ls = useStorage();
    const st = new Store();
    let used = 0;
    for (const [k, v] of ls.map) used += k.length + v.length;
    ls.quota = used;
    const r = st.addFinish('c:A01', 30000, []);
    expect(r.saved).toBe(false);
    // Still in memory for this session.
    expect(st.record('c:A01')?.best).toBe(30000);
    expect(st.hasFinished('c:A01')).toBe(true);
    expect(st.saveCustomTrack({ id: 't', data: { name: 'x', author: 'y', blocks: [] } as never, updated: 1 })).toBe(false);
  });

  it('resetProgress drops the use list with the ghosts', () => {
    const { ls, st } = full(2);
    st.saveGhost('c:A01', ghost());
    expect(ls.getItem('vb.ghost.lru')).not.toBeNull();
    st.resetProgress();
    expect(ls.getItem('vb.ghost.lru')).toBeNull();
    expect(ls.getItem(gk('c:A01'))).toBeNull();
  });
});
