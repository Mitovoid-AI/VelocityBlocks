// Browser-build ads: the network-agnostic Ads wrapper (input blocking, pause/mute, timeouts,
// a throwing SDK), the campaign unlock rules for the rewarded offer, and the stored unlocks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AD_INIT_TIMEOUT_MS,
  AD_PLAY_TIMEOUT_MS,
  AD_REQUEST_TIMEOUT_MS,
  Ads,
  bannerSize,
  noAds,
  type AdProvider,
} from '../src/ads/ads';
import { Store } from '../src/game/storage';
import { campaignLocks } from '../src/game/unlocks';

/** An ad request the test starts and finishes by hand. */
function manualAd<T>() {
  let started: (() => void) | null = null;
  let finish: ((v: T) => void) | null = null;
  return {
    request: (s: () => void) => {
      started = s;
      return new Promise<T>((r) => (finish = r));
    },
    start: () => started!(),
    finish: (v: T) => finish!(v),
  };
}

function withLog(provider: Partial<AdProvider>): { ads: Ads; log: string[] } {
  const log: string[] = [];
  const ads = new Ads({ ...noAds, ...provider });
  ads.hooks = { block: (on) => void log.push(`block:${on}`), playing: (on) => void log.push(`playing:${on}`) };
  return { ads, log };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('Ads', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('blocks input for the whole request and pauses only while the ad plays', async () => {
    const ad = manualAd<void>();
    const { ads, log } = withLog({ interstitial: ad.request });
    const done = ads.interstitial();
    expect(ads.busy).toBe(true);
    await tick();
    expect(log).toEqual(['block:true']); // requested, not playing yet
    ad.start();
    ad.finish();
    await done;
    expect(log).toEqual(['block:true', 'playing:true', 'playing:false', 'block:false']);
    expect(ads.busy).toBe(false);
  });

  it('ignores a second request while one is running', async () => {
    const ad = manualAd<void>();
    const second = vi.fn(() => Promise.resolve());
    const { ads } = withLog({ interstitial: ad.request, rewarded: second as never });
    const first = ads.interstitial();
    await tick();
    await expect(ads.rewarded()).resolves.toBe(false);
    expect(second).not.toHaveBeenCalled();
    ad.finish();
    await first;
  });

  it('reports only gameplay changes, and stops gameplay before an ad', async () => {
    const calls: string[] = [];
    const { ads } = withLog({ gameplayStart: () => void calls.push('start'), gameplayStop: () => void calls.push('stop') });
    ads.gameplay(false); // already stopped at launch
    ads.gameplay(true);
    ads.gameplay(true);
    await ads.interstitial();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('carries on when no ad starts within the request timeout', async () => {
    const { ads, log } = withLog({ interstitial: () => new Promise(() => {}) });
    const done = ads.interstitial();
    await tick(AD_REQUEST_TIMEOUT_MS - 1);
    expect(ads.busy).toBe(true);
    await tick(1);
    await done;
    expect(ads.busy).toBe(false);
    expect(log).toEqual(['block:true', 'block:false']);
  });

  it('still pauses and mutes for an ad that starts after the request timed out', async () => {
    const ad = manualAd<void>();
    const { ads, log } = withLog({ interstitial: ad.request });
    const done = ads.interstitial();
    await tick(AD_REQUEST_TIMEOUT_MS);
    await done;
    ad.start();
    expect(log.at(-1)).toBe('playing:true');
    ad.finish();
    await tick();
    expect(log).toEqual(['block:true', 'block:false', 'playing:true', 'playing:false']);
  });

  it('takes the screen back from an ad that never ends', async () => {
    const ad = manualAd<void>();
    const { ads, log } = withLog({ interstitial: ad.request });
    const done = ads.interstitial();
    await tick();
    ad.start();
    await tick(AD_PLAY_TIMEOUT_MS);
    await done;
    expect(log).toEqual(['block:true', 'playing:true', 'playing:false', 'block:false']);
    ad.finish(); // a very late end changes nothing
    await tick();
    expect(log).toHaveLength(4);
  });

  it('grants a reward only when the network says it was earned', async () => {
    const earned = withLog({ rewarded: () => Promise.resolve(true) }).ads;
    const skipped = withLog({ rewarded: () => Promise.resolve(false) }).ads;
    const failed = withLog({ rewarded: () => Promise.reject(new Error('unfilled')) }).ads;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(earned.rewarded()).resolves.toBe(true);
    await expect(skipped.rewarded()).resolves.toBe(false);
    await expect(failed.rewarded()).resolves.toBe(false);
    expect(failed.busy).toBe(false);
  });

  it('keeps the game running when the SDK throws (CrazyGames off its own domains)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = () => {
      throw new Error('disabled');
    };
    const { ads, log } = withLog({
      gameplayStart: boom,
      happytime: boom,
      interstitial: boom,
      canReward: boom,
      showBanner: boom,
      clearBanner: boom,
      watchMute: boom,
    });
    expect(() => ads.gameplay(true)).not.toThrow();
    expect(() => ads.happytime()).not.toThrow();
    await expect(ads.interstitial()).resolves.toBeUndefined();
    expect(log).toEqual(['block:true', 'block:false']);
    expect(ads.canReward()).toBe(false);
    await expect(ads.showBanner({} as HTMLElement, 320, 50)).resolves.toBe(false);
    expect(() => ads.clearBanner({} as HTMLElement)).not.toThrow();
    expect(() => ads.watchMute(() => {})).not.toThrow();
  });

  it('starts the game when the SDK never finishes loading or fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hung = new Ads({ ...noAds, init: () => new Promise(() => {}) });
    let ready = false;
    void hung.init().then(() => (ready = true));
    await tick(AD_INIT_TIMEOUT_MS - 1);
    expect(ready).toBe(false);
    await tick(1);
    expect(ready).toBe(true);
    await expect(new Ads({ ...noAds, init: () => Promise.reject(new Error('blocked')) }).init()).resolves.toBeUndefined();
  });

  it('defaults to no ads', async () => {
    const ads = new Ads();
    expect(ads.network).toBe('none');
    expect(ads.banners).toBe(false);
    expect(ads.canReward()).toBe(false);
    await expect(ads.rewarded()).resolves.toBe(false);
  });
});

describe('bannerSize', () => {
  it('uses a leaderboard on large screens, a mobile banner on phones, none on short screens', () => {
    expect(bannerSize(1280, 720)).toEqual({ width: 728, height: 90 });
    expect(bannerSize(900, 500)).toEqual({ width: 320, height: 50 });
    expect(bannerSize(800, 360)).toBeNull(); // landscape phone: the menus need the height
  });
});

describe('campaignLocks', () => {
  const keys = ['c:A01', 'c:A02', 'c:A03', 'c:A04'];
  const set = (...k: string[]) => (key: string) => k.includes(key);

  it('opens a track when the previous one was finished, and offers an ad on the first locked one', () => {
    expect(campaignLocks(keys, set('c:A01'), set())).toEqual([
      { locked: false, unlockable: false },
      { locked: false, unlockable: false },
      { locked: true, unlockable: true },
      { locked: true, unlockable: false },
    ]);
  });

  it('keeps an ad-unlocked track open; the next one still needs a finish or another ad', () => {
    expect(campaignLocks(keys, set('c:A01'), set('c:A03'))).toEqual([
      { locked: false, unlockable: false },
      { locked: false, unlockable: false },
      { locked: false, unlockable: false },
      { locked: true, unlockable: true },
    ]);
  });

  it('never locks the first track', () => {
    expect(campaignLocks(keys, set(), set())[0]).toEqual({ locked: false, unlockable: false });
  });
});

describe('Store ad unlocks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('persists ad unlocks, ignores junk, and clears them with the rest of the progress', () => {
    const map = new Map<string, string>([['vb.unlocks.ad', JSON.stringify(['c:A02', 7, null])]]);
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
    expect(st.adUnlocked('c:A02')).toBe(true);
    st.unlockWithAd('c:A05');
    expect(new Store().adUnlocked('c:A05')).toBe(true);
    st.resetProgress();
    expect(new Store().adUnlocked('c:A02')).toBe(false);
    expect(JSON.parse(map.get('vb.unlocks.ad')!)).toEqual([]);
  });
});
