// Poki HTML5 SDK v2 (https://developers.poki.com/guide/sdk-html5). Poki decides when a
// commercial break really plays, so the game signals every natural break. Poki sells the
// display ads around the game frame itself; there are no in-game banners.

import { loadScript, type AdProvider } from './ads';

const SDK_URL = 'https://game-cdn.poki.com/scripts/v2/poki-sdk.js';

interface PokiSdk {
  init(): Promise<void>;
  setDebug?(on: boolean): void;
  gameLoadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  commercialBreak(onStart?: () => void): Promise<void>;
  rewardedBreak(onStart?: () => void): Promise<boolean>;
}

export function pokiAds(): AdProvider {
  let sdk: PokiSdk | null = null;
  let adblock = false;

  return {
    network: 'poki',
    banners: false,

    async init() {
      await loadScript(SDK_URL);
      const s = (window as unknown as { PokiSDK?: PokiSdk }).PokiSDK;
      if (!s) throw new Error('Poki SDK missing after load');
      sdk = s;
      try {
        await s.init();
      } catch {
        // Poki rejects init when an ad blocker is on; the game must still load and play.
        adblock = true;
      }
      if (import.meta.env.DEV) s.setDebug?.(true);
    },

    loadingFinished: () => sdk?.gameLoadingFinished(),
    gameplayStart: () => sdk?.gameplayStart(),
    gameplayStop: () => sdk?.gameplayStop(),
    happytime() {},

    interstitial: (started) => (sdk ? sdk.commercialBreak(started) : Promise.resolve()),
    rewarded: (started) => (sdk ? sdk.rewardedBreak(started).then((ok) => ok === true) : Promise.resolve(false)),
    canReward: () => !!sdk && !adblock,

    showBanner: () => Promise.resolve(false),
    clearBanner() {},
    watchMute() {},
  };
}
