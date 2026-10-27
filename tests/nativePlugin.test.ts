// The Android plugin (VbNativePlugin.java) never resolves a call with no data: Capacitor's bridge logs each
// plugin result in debug builds with console.dir(result.data), and console.dir(undefined) reaches logcat
// as "Capacitor/Console: Line 353 - Msg: undefined" (twice at every launch: keepAwake and
// setGestureExclusion). An empty object logs "[object Object]", which Capacitor's console filter drops.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'velocityblocks', 'game', 'VbNativePlugin.java'), 'utf8');

describe('VbNativePlugin', () => {
  it('resolves every call with an object, never with nothing', () => {
    expect(SRC).not.toMatch(/\.resolve\(\s*\)/);
    // keepAwake, setGestureExclusion, cancelUpdate and writeShareChunk still resolve.
    expect(SRC.match(/call\.resolve\(new JSObject\(\)\)/g)).toHaveLength(4);
  });

  it('reports who installed the app, safely on every Android version', () => {
    const m = /public void installSource\(PluginCall call\)[\s\S]*?\r?\n    }\r?\n/.exec(SRC)![0];
    // Any failure answers {known: false} (treated like Play: no update check), never a rejection.
    expect(m).toMatch(/catch \(Throwable e\)/);
    expect(m).not.toMatch(/call\.reject/);
    expect(SRC).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.R\)[\s\S]*?getInstallSourceInfo\(pkg\)[\s\S]*?getInstallingPackageName\(\)/);
    expect(SRC).toMatch(/return pm\.getInstallerPackageName\(pkg\);/);
  });

  it('opens only https addresses, in a new task outside the app', () => {
    const m = /public void openUrl\(PluginCall call\)[\s\S]*?\r?\n    }\r?\n/.exec(SRC)![0];
    expect(m).toMatch(/"https"\.equalsIgnoreCase\(uri\.getScheme\(\)\)/);
    expect(m).toMatch(/new Intent\(Intent\.ACTION_VIEW, uri\)/);
    expect(m).toMatch(/addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK\)/);
    expect(m).toMatch(/catch \(ActivityNotFoundException e\)/);
  });

  it('updates in the app only in the GitHub build, from this repo, and only to a newer APK of this app', () => {
    expect(SRC).toMatch(/BuildConfig\.SELF_UPDATE && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.N/);
    expect(SRC).toContain('"https://github.com/Mitovoid-AI/VelocityBlocks/releases/download/"');
    const dl = /public void downloadUpdate\(PluginCall call\)[\s\S]*?\r?\n    }\r?\n/.exec(SRC)![0];
    expect(dl).toMatch(/if \(!inAppUpdates\(\)\)/);
    expect(dl).toMatch(/url\.startsWith\(UPDATE_PREFIX\)/);
    expect(dl).toMatch(/checkApk\(out\)/);
    const chk = /private String checkApk\(File apk\)[\s\S]*?\r?\n    }\r?\n/.exec(SRC)![0];
    expect(chk).toMatch(/getPackageName\(\)\.equals\(got\.packageName\)/);
    expect(chk).toMatch(/getLongVersionCode\(got\) <= PackageInfoCompat\.getLongVersionCode\(mine\)/);
    // The installer gets a content:// address with read access, never a file:// one.
    expect(SRC).toMatch(/FileProvider\.getUriForFile\([\s\S]*?FLAG_GRANT_READ_URI_PERMISSION/);
  });

  it('asks for the install permission in the GitHub flavor only', () => {
    const root = join(__dirname, '..', 'android', 'app');
    expect(readFileSync(join(root, 'src', 'github', 'AndroidManifest.xml'), 'utf8')).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    expect(readFileSync(join(root, 'src', 'main', 'AndroidManifest.xml'), 'utf8')).not.toContain('REQUEST_INSTALL_PACKAGES');
    const gradle = readFileSync(join(root, 'build.gradle'), 'utf8');
    expect(gradle).toMatch(/github \{[\s\S]*?SELF_UPDATE', 'true'/);
    expect(gradle).toMatch(/play \{[\s\S]*?SELF_UPDATE', 'false'/);
  });
});
