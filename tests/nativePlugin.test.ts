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
    // keepAwake and setGestureExclusion still resolve.
    expect(SRC.match(/call\.resolve\(new JSObject\(\)\)/g)).toHaveLength(2);
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
});
