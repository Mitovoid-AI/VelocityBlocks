// Ads for the browser builds. The game only talks to Ads; each ad network is an AdProvider
// (CrazyGames, Poki, a local test double, or none for Android, iOS and the plain web build).
// Ads never play while driving: an interstitial may come before a race starts, a rewarded ad
// can unlock a campaign track, and a banner may sit under some menu screens.

export type AdNetwork = 'none' | 'crazygames' | 'poki' | 'adtest';

export interface AdProvider {
  readonly network: AdNetwork;
  /** Menu banners are supported. */
  readonly banners: boolean;
  /** Load and start the SDK. The game starts whether this resolves or rejects. */
  init(): Promise<void>;
  /** The game has loaded and its first screen is up. */
  loadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  /** A rare achievement (CrazyGames "happy time"). */
  happytime(): void;
  /**
   * Ask for an interstitial. `started` runs if an ad really plays; the promise settles when it
   * is over or when none came (the network decides how often ads play).
   */
  interstitial(started: () => void): Promise<void>;
  /** Ask for a rewarded ad. Resolves true only when the reward was earned. */
  rewarded(started: () => void): Promise<boolean>;
  /** False when a rewarded ad can't work (ad blocker, SDK missing), so the offer is hidden. */
  canReward(): boolean;
  /** Fill `el` (which has an id and this size) with a banner. Resolves false if none was shown. */
  showBanner(el: HTMLElement, width: number, height: number): Promise<boolean>;
  clearBanner(el: HTMLElement): void;
  /** Platform-wide mute (CrazyGames' muteAudio setting): called now and on every change. */
  watchMute(fn: (muted: boolean) => void): void;
}

/** What the game does around an ad. */
export interface AdHooks {
  /** Block (true) or release all input while an ad is requested or playing. */
  block(on: boolean): void;
  /** An ad is on screen: pause the game loop and mute (true), or carry on (false). */
  playing(on: boolean): void;
}

/** How long the SDK may take to load and start before the game starts without it. */
export const AD_INIT_TIMEOUT_MS = 6000;
/** How long a request may wait for an ad to start before the game carries on without it. */
export const AD_REQUEST_TIMEOUT_MS = 8000;
/** The longest an ad may hold the screen before the game takes it back. */
export const AD_PLAY_TIMEOUT_MS = 180_000;

/** No ads: Android, iOS and the plain web build. */
export const noAds: AdProvider = {
  network: 'none',
  banners: false,
  init: () => Promise.resolve(),
  loadingFinished() {},
  gameplayStart() {},
  gameplayStop() {},
  happytime() {},
  interstitial: () => Promise.resolve(),
  rewarded: () => Promise.resolve(false),
  canReward: () => false,
  showBanner: () => Promise.resolve(false),
  clearBanner() {},
  watchMute() {},
};

/** Run a provider call; an SDK that throws (CrazyGames off its own domains) must not stop the game. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn('[ads]', e);
    return fallback;
  }
}

export class Ads {
  hooks: AdHooks = { block() {}, playing() {} };
  private busyNow = false;
  private inGameplay = false;

  constructor(readonly provider: AdProvider = noAds) {}

  get network(): AdNetwork {
    return this.provider.network;
  }

  get banners(): boolean {
    return this.provider.banners;
  }

  /** An ad is being requested or played: ignore anything that would start another. */
  get busy(): boolean {
    return this.busyNow;
  }

  /** Start the SDK, giving up after AD_INIT_TIMEOUT_MS. Never rejects. */
  async init(): Promise<void> {
    let timer = 0;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.provider.init()),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, AD_INIT_TIMEOUT_MS) as unknown as number)),
      ]);
    } catch (e) {
      console.warn('[ads] init failed; playing without ads', e);
    } finally {
      clearTimeout(timer);
    }
  }

  loadingFinished(): void {
    safe(() => this.provider.loadingFinished(), undefined);
  }

  happytime(): void {
    safe(() => this.provider.happytime(), undefined);
  }

  /** Report whether the player is driving. Only changes reach the network. */
  gameplay(on: boolean): void {
    if (on === this.inGameplay) return;
    this.inGameplay = on;
    safe(() => (on ? this.provider.gameplayStart() : this.provider.gameplayStop()), undefined);
  }

  canReward(): boolean {
    return safe(() => this.provider.canReward(), false);
  }

  watchMute(fn: (muted: boolean) => void): void {
    safe(() => this.provider.watchMute(fn), undefined);
  }

  showBanner(el: HTMLElement, width: number, height: number): Promise<boolean> {
    return safe(() => this.provider.showBanner(el, width, height), Promise.resolve(false)).catch(() => false);
  }

  clearBanner(el: HTMLElement): void {
    safe(() => this.provider.clearBanner(el), undefined);
  }

  /** A natural break (before a race): the network may play an interstitial. Never rejects. */
  async interstitial(): Promise<void> {
    await this.run((started) => this.provider.interstitial(started));
  }

  /** Resolves true when the reward was earned; false when no ad played or it was skipped. */
  async rewarded(): Promise<boolean> {
    return (await this.run((started) => this.provider.rewarded(started))) === true;
  }

  /**
   * Block input, request the ad and wait for it, then release input. `hooks.playing` follows the
   * ad itself, not this wait: an ad that only starts after the request timed out still pauses
   * and mutes the game (the race freezes under it) until it ends.
   */
  private async run<T>(request: (started: () => void) => Promise<T>): Promise<T | undefined> {
    if (this.busyNow) return undefined;
    this.busyNow = true;
    this.gameplay(false);
    this.hooks.block(true);
    let started = false;
    let ended = false;
    let playTimer = 0;
    const end = () => {
      clearTimeout(playTimer);
      if (started && !ended) {
        ended = true;
        this.hooks.playing(false);
      }
    };
    try {
      return await new Promise<T | undefined>((resolve) => {
        const requestTimer = setTimeout(() => {
          if (!started) resolve(undefined);
        }, AD_REQUEST_TIMEOUT_MS);
        const onStart = () => {
          if (started) return;
          started = true;
          clearTimeout(requestTimer);
          this.hooks.playing(true);
          playTimer = setTimeout(() => {
            end();
            resolve(undefined);
          }, AD_PLAY_TIMEOUT_MS) as unknown as number;
        };
        Promise.resolve()
          .then(() => request(onStart))
          .then(
            (v) => {
              clearTimeout(requestTimer);
              end();
              resolve(v);
            },
            (e) => {
              console.warn('[ads] request failed', e);
              clearTimeout(requestTimer);
              end();
              resolve(undefined);
            },
          );
      });
    } finally {
      this.busyNow = false;
      this.hooks.block(false);
    }
  }
}

/** Load a third-party script (an ad SDK). */
export function loadScript(src: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const timer = setTimeout(() => reject(new Error(`Timed out loading ${src}`)), timeoutMs);
    s.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Could not load ${src} (blocked or offline)`));
    };
    document.head.appendChild(s);
  });
}

/** The banner size for a viewport, or null when a banner would crowd the menus. */
export function bannerSize(viewW: number, viewH: number): { width: number; height: number } | null {
  if (viewW >= 800 && viewH >= 600) return { width: 728, height: 90 };
  if (viewW >= 360 && viewH >= 400) return { width: 320, height: 50 };
  return null;
}
