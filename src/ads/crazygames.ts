// CrazyGames HTML5 SDK v3 (https://docs.crazygames.com/sdk/intro). On localhost the SDK runs in
// its "local" environment, which shows placeholder ads and demo banners; on any domain other
// than CrazyGames' it is "disabled" and every call throws, so the game then runs without ads.

import { loadScript, type AdProvider } from './ads';

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

interface CgAdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (error: { code: string; message: string }) => void;
}

interface CgSdk {
  init(): Promise<void>;
  environment: 'local' | 'crazygames' | 'disabled';
  ad: {
    requestAd(type: 'midgame' | 'rewarded', callbacks: CgAdCallbacks): void;
    hasAdblock(): Promise<boolean>;
  };
  banner: {
    requestBanner(options: { id: string; width: number; height: number }): Promise<void>;
    clearBanner(id: string): void;
  };
  game: {
    gameplayStart(): void;
    gameplayStop(): void;
    loadingStart(): void;
    loadingStop(): void;
    happytime(): void;
    settings: { muteAudio?: boolean };
    addSettingsChangeListener(fn: (settings: { muteAudio?: boolean }) => void): void;
  };
}

export function crazyGamesAds(): AdProvider {
  let sdk: CgSdk | null = null;
  let adblock = false;

  return {
    network: 'crazygames',
    banners: true,

    async init() {
      await loadScript(SDK_URL);
      const s = (window as unknown as { CrazyGames?: { SDK?: CgSdk } }).CrazyGames?.SDK;
      if (!s) throw new Error('CrazyGames SDK missing after load');
      await s.init();
      if (s.environment === 'disabled') {
        console.info('[ads] CrazyGames SDK is disabled on this domain; no ads');
        return;
      }
      sdk = s;
      sdk.game.loadingStart();
      // Not awaited: the answer only decides whether the rewarded offer is shown.
      sdk.ad.hasAdblock().then(
        (b) => (adblock = b),
        () => {},
      );
    },

    loadingFinished: () => sdk?.game.loadingStop(),
    gameplayStart: () => sdk?.game.gameplayStart(),
    gameplayStop: () => sdk?.game.gameplayStop(),
    happytime: () => sdk?.game.happytime(),

    interstitial(started) {
      const s = sdk;
      if (!s) return Promise.resolve();
      return new Promise((resolve) =>
        s.ad.requestAd('midgame', {
          adStarted: started,
          adFinished: () => resolve(),
          // Unfilled, cooldown (about one midgame ad per 3 minutes) or ad blocker: carry on.
          adError: () => resolve(),
        }),
      );
    },

    rewarded(started) {
      const s = sdk;
      if (!s) return Promise.resolve(false);
      return new Promise((resolve) =>
        s.ad.requestAd('rewarded', {
          adStarted: started,
          adFinished: () => resolve(true),
          adError: () => resolve(false),
        }),
      );
    },

    canReward: () => !!sdk && !adblock,

    async showBanner(el, width, height) {
      if (!sdk || adblock) return false;
      await sdk.banner.requestBanner({ id: el.id, width, height });
      return true;
    },

    clearBanner: (el) => sdk?.banner.clearBanner(el.id),

    watchMute(fn) {
      if (!sdk) return;
      fn(!!sdk.game.settings.muteAudio);
      sdk.game.addSettingsChangeListener((settings) => fn(!!settings.muteAudio));
    },
  };
}
