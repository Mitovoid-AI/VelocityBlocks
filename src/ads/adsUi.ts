// DOM side of the ads: picking the network for this build, the input blocker shown while an
// ad is requested or playing, and the menu banner slot.

import { Capacitor } from '@capacitor/core';
import './ads.css';
import { Ads, bannerSize, noAds, type AdProvider } from './ads';
import { crazyGamesAds } from './crazygames';
import { gameMonetizeAds } from './gamemonetize';
import { pokiAds } from './poki';
import { testAds } from './testAds';

/**
 * The network chosen at build time (`vite --mode crazygames|poki|gamemonetize|adtest`, see .env.*). Each
 * test compares the build constant directly, so the bundler drops the other adapters: a portal
 * build never mentions another portal's SDK.
 */
function buildProvider(): AdProvider {
  if (__VB_ADS__ === 'crazygames') return crazyGamesAds();
  if (__VB_ADS__ === 'poki') return pokiAds();
  if (__VB_ADS__ === 'gamemonetize') return gameMonetizeAds();
  if (__VB_ADS__ === 'adtest') return testAds();
  return noAds;
}

export function createAds(): Ads {
  // The native apps never carry web ads, whatever the build mode.
  const provider = Capacitor.isNativePlatform() ? noAds : buildProvider();
  if (provider.network !== 'none') {
    // Portals embed the game in an iframe: a wheel over the 3D view must not scroll their page.
    // Menus keep their own scrolling (their scrollers sit above the canvas).
    window.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as Element | null)?.id === 'view') e.preventDefault();
      },
      { passive: false },
    );
  }
  return new Ads(provider);
}

let blocker: HTMLDivElement | null = null;

/** Swallow every tap, click and key while an ad is requested or playing. */
export function blockForAd(on: boolean): void {
  if (!blocker) {
    blocker = document.createElement('div');
    blocker.className = 'ad-blocker hidden';
    blocker.tabIndex = -1;
    blocker.setAttribute('aria-hidden', 'true');
    document.querySelector('#app')!.appendChild(blocker);
  }
  blocker.classList.toggle('hidden', !on);
  if (on) {
    // A focused button would still take Enter or Space (Next track, a menu item).
    (document.activeElement as HTMLElement | null)?.blur();
    blocker.focus({ preventScroll: true });
  }
}

/** Time between two requests for the banner container (CrazyGames allows one per 30 s). */
const BANNER_COOLDOWN_MS = 31_000;

/**
 * The banner under the menus that carry `.with-banner` (home, campaign, My tracks). It follows
 * the screen in #screens, so any other screen, a race or the editor hides and clears it.
 */
export class BannerSlot {
  private readonly el: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private want = false;
  /** The banner on screen, or null. */
  private size: { width: number; height: number } | null = null;
  private lastRequest = -Infinity;
  private timer = 0;
  private refitTimer = 0;

  constructor(private readonly ads: Ads) {
    this.box = document.createElement('div');
    this.box.className = 'ad-banner hidden';
    this.box.innerHTML = '<div class="ad-banner-label">Advertisement</div><div id="vb-ad-banner"></div>';
    document.querySelector('#app')!.appendChild(this.box);
    this.el = this.box.querySelector<HTMLDivElement>('#vb-ad-banner')!;
    const screens = document.querySelector('#screens')!;
    const sync = () => this.set(!!screens.querySelector(':scope > .screen.with-banner'));
    new MutationObserver(sync).observe(screens, { childList: true });
    sync();
    window.addEventListener('resize', () => {
      clearTimeout(this.refitTimer);
      this.refitTimer = window.setTimeout(() => this.refit(), 300);
    });
  }

  private set(want: boolean): void {
    if (want === this.want) return;
    this.want = want;
    clearTimeout(this.timer);
    if (want) this.request();
    else this.hide();
  }

  /** After a rotation or window resize, swap the banner if the screen now calls for another size (or none). */
  private refit(): void {
    if (!this.want) return;
    const size = bannerSize(window.innerWidth, window.innerHeight);
    if (size?.width === this.size?.width && size?.height === this.size?.height) return;
    clearTimeout(this.timer);
    this.hide();
    this.request();
  }

  private request(): void {
    const wait = this.lastRequest + BANNER_COOLDOWN_MS - performance.now();
    if (wait > 0) {
      this.timer = window.setTimeout(() => this.want && this.request(), wait);
      return;
    }
    const size = bannerSize(window.innerWidth, window.innerHeight);
    if (!size) return;
    this.lastRequest = performance.now();
    this.size = size;
    // The SDK needs the container on screen, at the banner's size, before it fills it.
    this.el.style.width = `${size.width}px`;
    this.el.style.height = `${size.height}px`;
    document.body.style.setProperty('--ad-banner-h', `${size.height}px`);
    this.show(true);
    this.ads.showBanner(this.el, size.width, size.height).then((ok) => {
      // Nothing to show (unfilled, ad blocker): give the menus their space back.
      if (!ok && this.size === size) this.hide();
    });
  }

  private hide(): void {
    this.ads.clearBanner(this.el);
    this.size = null;
    this.show(false);
  }

  private show(on: boolean): void {
    this.box.classList.toggle('hidden', !on);
    // Menus pad their bottom by the banner's height, so it never covers a button.
    document.body.classList.toggle('ad-banner-on', on);
  }
}
