import './ui/styles.css';
import { createAds } from './ads/adsUi';
import { App } from './app/app';

async function boot(): Promise<App | null> {
  // Browser builds for game portals start the ad SDK first (none in the apps or plain web build).
  const ads = createAds();
  if (ads.network !== 'none') {
    document.querySelector('#screens')!.innerHTML =
      '<div class="screen"><div class="muted" style="margin:auto">Loading&hellip;</div></div>';
    await ads.init(); // never rejects, and gives up after a few seconds: the game must still load
  }
  try {
    const app = new App(ads);
    app.start();
    ads.loadingFinished();
    return app;
  } catch (e) {
    // three.js needs WebGL 2. Without it the page would stay blank, so say why.
    console.error(e);
    document.querySelector('#screens')!.innerHTML = `<div class="screen dim"><div class="panel" style="margin:auto;max-width:520px">
      <h2 style="margin-top:0">3D graphics unavailable</h2>
      <p>Velocity Blocks needs WebGL 2, which this device could not start. Update Android System WebView (or your browser) and try again.</p>
    </div></div>`;
    return null;
  }
}

void boot().then((app) => {
  // Expose for debugging in development builds only.
  if (import.meta.env.DEV && app) (window as unknown as { vb: App }).vb = app;
});
