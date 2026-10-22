import './ui/styles.css';
import { createAds } from './ads/adsUi';
import { App } from './app/app';
import { inject } from '@vercel/analytics';

// Initialize Vercel Web Analytics
inject();

// The web manifest's icons make the browser game installable, and Chrome on Android would then pop up its
// own "Install app" banner on every visit. Suppress it: players add the game to the Home Screen from the
// browser menu if they want, and the website points them to the real apps.
window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());

function hideBoot(): void {
  const el = document.querySelector<HTMLElement>('#boot');
  if (!el) return;
  el.classList.add('done');
  setTimeout(() => el.remove(), 400);
}

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
    // The first frames compile every shader and bake the lighting, a second or two on a phone. The
    // boot screen stays over them (at most 8 s), so the menu never appears and then freezes.
    await Promise.race([app.world.ready, new Promise((r) => setTimeout(r, 8000))]);
    hideBoot();
    ads.loadingFinished();
    // Sideloaded Android installs: look for a newer GitHub release once the menu is up (platform/updates.ts).
    app.checkUpdatesSoon();
    return app;
  } catch (e) {
    // three.js needs WebGL 2. Without it the page would stay blank, so say why.
    console.error(e);
    hideBoot();
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
  // window.vbScore('author' | 'gold' | 'none' | 'first' | 'held' | 'editor' | 'walls'): the results card with sample runs.
  if (import.meta.env.DEV) void import('./ui/scoreCardPreview').then((p) => p.install());
});
