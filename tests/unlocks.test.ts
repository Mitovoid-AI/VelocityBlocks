import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHYSICS_VERSION } from '../src/core/constants';
import { entryKey } from '../src/core/vehicles';
import { Store } from '../src/game/storage';
import { campaignLocks } from '../src/game/unlocks';

/** A fresh in-memory localStorage holding `records` under this physics version's key. */
function storeWith(records: Record<string, unknown>, raw: Record<string, string> = {}): Store {
  const map = new Map<string, string>(Object.entries(raw));
  vi.stubGlobal('localStorage', {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  });
  const st = new Store();
  for (const k of Object.keys(records)) st.addFinish(k, 30000, []);
  return st;
}

afterEach(() => vi.unstubAllGlobals());

describe('shared campaign unlocks', () => {
  const keys = ['c:A01', 'c:A02', 'c:A03'];

  it('finishing a track with any class, in either wall mode, opens the next one for everyone', () => {
    for (const done of [entryKey('c:A01', 'bike', false), entryKey('c:A01', 'truck', true), 'c:A01|w', 'c:A01']) {
      const st = storeWith({ [done]: 1 });
      const locks = campaignLocks(keys, (k) => st.hasFinished(k), () => false);
      expect(locks.map((l) => l.locked), done).toEqual([false, false, true]);
      expect(locks[2].unlockable).toBe(true);
    }
    const none = storeWith({});
    expect(campaignLocks(keys, (k) => none.hasFinished(k), () => false).map((l) => l.locked)).toEqual([false, true, true]);
  });

  it('keeps a track open after a class retune: a finish under an older revision still counts', () => {
    // Records of a bike revision this build no longer uses ('@bike0'), with no finished list yet.
    const st = storeWith({}, { [`vb.records.v${PHYSICS_VERSION}`]: JSON.stringify({ 'c:A01@bike0|w': { best: 1, cpTimes: [], finishes: 1 } }) });
    expect(campaignLocks(keys, (k) => st.hasFinished(k), () => false).map((l) => l.locked)).toEqual([false, false, true]);
  });
});
