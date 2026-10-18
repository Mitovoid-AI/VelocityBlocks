// Bridge to the app's own Android plugin (android/.../VbNativePlugin.java). Where the plugin
// is missing (the web build, iOS) saving reports 'unsupported' and keepAwake does nothing.

import { Capacitor, registerPlugin } from '@capacitor/core';

interface VbNativePlugin {
  saveText(options: { name: string; text: string; mime: string }): Promise<{ saved: boolean }>;
  keepAwake(options: { on: boolean }): Promise<void>;
}

const VbNative = registerPlugin<VbNativePlugin>('VbNative');
const available = (): boolean => Capacitor.isPluginAvailable('VbNative');

/** Let the user save a text file through the OS "Save as" screen. */
export async function saveTextFile(
  name: string,
  text: string,
  mime = 'application/json',
): Promise<'saved' | 'cancelled' | 'unsupported'> {
  if (!available()) return 'unsupported';
  const r = await VbNative.saveText({ name, text, mime });
  return r.saved ? 'saved' : 'cancelled';
}

let awake: boolean | null = null;

/** Keep the screen on while racing only, so menus can time out normally. */
export function keepAwake(on: boolean): void {
  if (awake === on || !available()) return;
  awake = on;
  VbNative.keepAwake({ on }).catch(() => {});
}
