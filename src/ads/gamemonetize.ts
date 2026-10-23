// GameMonetize HTML5 SDK (https://github.com/MonetizeGame/GameMonetize.com-SDK). The SDK reads
// window.SDK_OPTIONS when it loads; sdk.showBanner() asks for a video ad, and the SDK answers with
// SDK_GAME_PAUSE when one starts and SDK_GAME_START when it is over. It has no rewarded ads and no
// in-game banners, and it says nothing when no ad comes, so a request gives up after a short wait.

import { loadScript, type AdProvider } from './ads';

const SDK_URL = 'https://api.gamemonetize.com/sdk.js';
/** The game's id in the GameMonetize control panel (.env.gamemonetize). */
const GAME_ID: string = import.meta.env.VITE_GM_GAME_ID ?? '';
/** How long to wait for SDK_GAME_PAUSE before carrying on with no ad. */
const NO_AD_MS = 4000;
/** At most one interstitial in this time; the first race of a visit may have one. */
const COOLDOWN_MS = 180_000;

interface GmEvent {
  name: string;
}

interface GmSdk {
  showBanner(): void;
}

interface Pending {
  started: () => void;
  done: () => void;
  playing: boolean;
  timer: number;
}

export function gameMonetizeAds(): AdProvider {
  let ready = false;
  let pending: Pending | null = null;
  let lastAd = -Infinity;

  const settle = () => {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    p.done();
  };

  const onEvent = (e: GmEvent) => {
    if (e.name === 'SDK_READY') ready = true;
    else if (e.name === 'SDK_GAME_PAUSE' && pending && !pending.playing) {
      pending.playing = true;
      clearTimeout(pending.timer);
      lastAd = Date.now();
      pending.started();
    } else if (e.name === 'SDK_GAME_START') settle();
  };

  const sdk = () => (window as unknown as { sdk?: GmSdk }).sdk;

  return {
    network: 'gamemonetize',
    banners: false,

    async init() {
      if (!GAME_ID) throw new Error('VITE_GM_GAME_ID is not set');
      (window as unknown as { SDK_OPTIONS: unknown }).SDK_OPTIONS = { gameId: GAME_ID, onEvent };
      await loadScript(SDK_URL);
    },

    loadingFinished() {},
    gameplayStart() {},
    gameplayStop() {},
    happytime() {},

    interstitial(started) {
      const s = sdk();
      if (!ready || !s || pending || Date.now() - lastAd < COOLDOWN_MS) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending = { started, done: resolve, playing: false, timer: setTimeout(settle, NO_AD_MS) as unknown as number };
        s.showBanner();
      });
    },

    rewarded: () => Promise.resolve(false),
    canReward: () => false,
    showBanner: () => Promise.resolve(false),
    clearBanner() {},
    watchMute() {},
  };
}
