// A stand-in network for `npm run dev:adtest`: every request plays a short fake ad, so the
// breaks, the rewarded unlock and the menu banner can be tried without an ad account.

import type { AdProvider } from './ads';

const log = (...a: unknown[]) => console.info('[ads:test]', ...a);

/** A full-screen fake ad. Resolves true when it ran to the end, false when skipped. */
function fakeAd(title: string, seconds: number, skippable: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'ad-test-overlay';
    el.innerHTML = `<div class="ad-test-box">
        <div class="ad-test-tag">TEST AD</div>
        <div class="ad-test-title">${title}</div>
        <div class="ad-test-count"></div>
        ${skippable ? '<button class="btn center" data-skip>Skip (no reward)</button>' : ''}
      </div>`;
    document.querySelector('#app')!.appendChild(el);
    const count = el.querySelector<HTMLElement>('.ad-test-count')!;
    let left = seconds;
    const done = (full: boolean) => {
      clearInterval(timer);
      el.remove();
      resolve(full);
    };
    const tick = () => {
      count.textContent = `${left} s`;
      if (left-- <= 0) done(true);
    };
    const timer = setInterval(tick, 1000);
    tick();
    el.querySelector('[data-skip]')?.addEventListener('click', () => done(false));
  });
}

export function testAds(): AdProvider {
  return {
    network: 'adtest',
    banners: true,
    init: async () => log('init'),
    loadingFinished: () => log('loadingFinished'),
    gameplayStart: () => log('gameplayStart'),
    gameplayStop: () => log('gameplayStop'),
    happytime: () => log('happytime'),
    async interstitial(started) {
      log('interstitial');
      started();
      await fakeAd('Interstitial', 3, false);
    },
    async rewarded(started) {
      log('rewarded');
      started();
      const full = await fakeAd('Rewarded', 4, true);
      log(full ? 'reward earned' : 'skipped');
      return full;
    },
    canReward: () => true,
    async showBanner(el, width, height) {
      log('banner', width, height);
      el.innerHTML = `<div class="ad-test-banner">Test banner ${width}&times;${height}</div>`;
      return true;
    },
    clearBanner(el) {
      el.innerHTML = '';
    },
    watchMute: () => {},
  };
}
