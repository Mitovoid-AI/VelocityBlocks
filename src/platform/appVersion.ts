// The app version. package.json "version" (X.Y.Z) is the single source: vite.config.ts injects it as
// __APP_VERSION__, and android/app/build.gradle reads the same file for versionName and versionCode.

/** This build's version, e.g. '1.2.0' (shown at the bottom of Settings, compared with GitHub releases). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/**
 * The Android versionCode for an X.Y.Z version: X*10000 + Y*100 + Z (1.2.0 -> 10200), the same formula as
 * android/app/build.gradle. Y and Z stay under 100 so a later version always gets a larger code. Null for
 * anything else.
 */
export function androidVersionCode(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (min > 99 || pat > 99) return null;
  return maj * 10000 + min * 100 + pat;
}
