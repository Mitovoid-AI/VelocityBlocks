import { readFileSync } from 'node:fs';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/** Browser builds with an ad network (VITE_ADS comes from .env.<mode>), each in its own folder. */
const AD_MODES = ['crazygames', 'poki', 'gamemonetize', 'adtest'];

/** package.json "version" is the one place the app version is set (android/app/build.gradle reads it too). */
const APP_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig(({ mode }) => {
  const ads = loadEnv(mode, '.', 'VITE_').VITE_ADS ?? '';
  return {
    // Relative base so the same build works from a web server root, inside a game portal's
    // iframe, and from the Capacitor WebView on Android/iOS.
    base: './',
    // A literal, so the bundler drops the adapters of the other networks (src/ads/adsUi.ts).
    define: {
      __VB_ADS__: JSON.stringify(AD_MODES.includes(ads) ? ads : 'none'),
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    // KTX2Loader finds the Basis transcoder next to itself (new URL(..., import.meta.url)): served from
    // node_modules in dev, not from the pre-bundled deps folder where it does not exist. The build emits it.
    optimizeDeps: { exclude: ['three/examples/jsm/loaders/KTX2Loader.js'] },
    build: {
      target: 'es2020',
      chunkSizeWarningLimit: 1200,
      // dist/ stays the ad-free build that `cap sync` copies into the apps.
      outDir: AD_MODES.includes(mode) ? `dist-${mode}` : 'dist',
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
