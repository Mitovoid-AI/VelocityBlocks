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
});
