// Bridge to the app's own Android plugin (android/.../VbNativePlugin.java). Where the plugin
// is missing (the web build, iOS) saving reports 'unsupported' and the rest does nothing. A new
// web bundle in an older app build gets rejections for the newer methods; those are ignored.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ExclusionRect, GestureInsets } from '../input/edgeGuard';

/** The phone and its navigation mode, for the pause screen's diagnostics line. */
export interface DeviceInfo {
  sdk: number;
  release: string;
  maker: string;
  model: string;
  /** 'gesture', '3-button', '2-button' or 'unknown'. */
  nav: string;
}

interface VbNativePlugin {
  saveText(options: { name: string; text: string; mime: string }): Promise<{ saved: boolean }>;
  keepAwake(options: { on: boolean }): Promise<void>;
  setGestureExclusion(options: { vw: number; vh: number; rects: ExclusionRect[] }): Promise<void>;
  getGestureInsets(): Promise<GestureInsets>;
  deviceInfo(): Promise<DeviceInfo>;
  addListener(event: 'gestureInsets', fn: (g: GestureInsets) => void): Promise<PluginListenerHandle>;
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

let lastExclusion = '';

/**
 * Turn Android's back swipe off over these rects (CSS px of a vw x vh page), so an edge swipe that
 * starts on a touch control stays in the game. [] clears them. Android 10+; repeats are skipped.
 */
export function setGestureExclusion(vw: number, vh: number, rects: ExclusionRect[]): void {
  if (!available()) return;
  const key = JSON.stringify([vw, vh, rects]);
  if (key === lastExclusion) return;
  lastExclusion = key;
  // Rejected before the WebView is laid out (or by an older app build): forget the key, so the
  // next resize or showTouch sends the rects again.
  VbNative.setGestureExclusion({ vw, vh, rects }).catch(() => {
    if (lastExclusion === key) lastExclusion = '';
  });
}

/** Call `fn` with the system gesture strips (dp) now and whenever they change. Android app only. */
export function watchGestureInsets(fn: (g: GestureInsets) => void): void {
  if (!available()) return;
  VbNative.addListener('gestureInsets', fn).catch(() => {});
  VbNative.getGestureInsets().then(fn, () => {});
}

/** The phone and its navigation mode, or null outside the Android app. */
export async function deviceInfo(): Promise<DeviceInfo | null> {
  if (!available()) return null;
  try {
    return await VbNative.deviceInfo();
  } catch {
    return null;
  }
}
