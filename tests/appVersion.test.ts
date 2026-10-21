// The app version has one source, package.json "version": vite injects it (__APP_VERSION__, shown in
// Settings) and android/app/build.gradle reads the same file for versionName and versionCode. These fail
// when that wiring is broken or the version could not make a valid, increasing Android versionCode.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION as SETTINGS_VERSION } from '../src/app/fullGame';
import { androidVersionCode, APP_VERSION } from '../src/platform/appVersion';
import { parseVersion } from '../src/platform/updates';

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
const gradle = readFileSync(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');

/** The last versionCode uploaded to Google Play before the version moved to package.json (1.2). */
const LAST_PLAY_VERSION_CODE = 3;

describe('app version', () => {
  it('package.json holds a plain X.Y.Z version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parseVersion(pkg.version)).not.toBeNull();
  });

  it('the bundle and Settings show package.json\'s version', () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(SETTINGS_VERSION).toBe(pkg.version);
  });

  it('package-lock.json agrees', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  it('gives an Android versionCode above every one Google Play has seen', () => {
    const code = androidVersionCode(pkg.version);
    expect(code).not.toBeNull();
    expect(code!).toBeGreaterThan(LAST_PLAY_VERSION_CODE);
  });

  it('versionCode grows with every version (X*10000 + Y*100 + Z)', () => {
    expect(androidVersionCode('1.2.0')).toBe(10200);
    expect(androidVersionCode('1.2.1')).toBe(10201);
    expect(androidVersionCode('1.3.0')).toBe(10300);
    expect(androidVersionCode('2.0.0')).toBe(20000);
    const order = ['1.2.0', '1.2.1', '1.2.99', '1.3.0', '1.10.0', '1.99.99', '2.0.0'].map((v) => androidVersionCode(v)!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Minor or patch over 99 would break the order: refused (gradle refuses them too).
    expect(androidVersionCode('1.100.0')).toBeNull();
    expect(androidVersionCode('1.2.100')).toBeNull();
    expect(androidVersionCode('1.2')).toBeNull();
  });

  it('build.gradle reads package.json instead of hard-coding the version', () => {
    expect(gradle).toMatch(/JsonSlurper\(\)\.parse\(rootProject\.file\('\.\.\/package\.json'\)\)\.version/);
    expect(gradle).toMatch(/^\s*versionName appVersion\s*$/m);
    expect(gradle).toMatch(/^\s*versionCode appVersionCode\s*$/m);
    expect(gradle).toMatch(/appMajor \* 10000 \+ appMinor \* 100 \+ appPatch/);
    expect(gradle).not.toMatch(/^\s*versionCode\s+\d/m);
    expect(gradle).not.toMatch(/^\s*versionName\s+["']/m);
  });
});
