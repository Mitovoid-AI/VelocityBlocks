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

/**
 * Who installed the app (Android): `installer` is the installing package ('com.android.vending' for
 * Google Play; a package installer, a file manager or null for an APK installed by hand). `known` is
 * false when Android would not say, or outside the Android app.
 */
export interface InstallSource {
  known: boolean;
  installer: string | null;
}

interface VbNativePlugin {
  saveText(options: { name: string; text: string; mime: string }): Promise<{ saved: boolean }>;
  keepAwake(options: { on: boolean }): Promise<void>;
  setGestureExclusion(options: { vw: number; vh: number; rects: ExclusionRect[] }): Promise<void>;
  getGestureInsets(): Promise<GestureInsets>;
  deviceInfo(): Promise<DeviceInfo>;
  installSource(): Promise<{ known: boolean; installer?: string }>;
  openUrl(options: { url: string }): Promise<{ opened: boolean }>;
  updateSupport(): Promise<{ inApp: boolean }>;
  downloadUpdate(options: { url: string; size: number }): Promise<{ version: string; size: number }>;
  cancelUpdate(): Promise<void>;
  installUpdate(): Promise<{ state: 'installing' | 'permission' }>;
  addListener(event: 'gestureInsets', fn: (g: GestureInsets) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateProgress', fn: (p: { received: number; total: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateInstall', fn: (p: { state: InstallState }) => void): Promise<PluginListenerHandle>;
}

/** Where opening the installer got to: back from "Install unknown apps" it is installing, denied or failed. */
export type InstallState = 'installing' | 'permission' | 'denied' | 'failed';

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

/** Who installed the app; {known: false} outside the Android app or when Android would not say. */
export async function installSource(): Promise<InstallSource> {
  if (!available()) return { known: false, installer: null };
  try {
    const r = await VbNative.installSource();
    return { known: r.known === true, installer: typeof r.installer === 'string' && r.installer ? r.installer : null };
  } catch {
    return { known: false, installer: null };
  }
}

/**
 * Open an https address in the system browser (Android app only). False when it could not be opened,
 * and always false elsewhere (nothing happens there).
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!available() || !/^https:\/\//i.test(url)) return false;
  try {
    return (await VbNative.openUrl({ url })).opened === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ In-app updates (GitHub APK build)

/**
 * Whether this app downloads and installs updates itself (the GitHub build on Android 7+). False in the Play
 * build, outside Android, and in app builds from before in-app updates (they use the browser download).
 */
export async function inAppUpdates(): Promise<boolean> {
  if (!available()) return false;
  try {
    return (await VbNative.updateSupport()).inApp === true;
  } catch {
    return false;
  }
}

/** The download was stopped with cancelApkDownload(). */
export class DownloadCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * Download a release APK inside the app, calling `progress(received, total)` along the way (total 0 when
 * unknown). Resolves with the APK's version once it is a complete, newer APK of this app; rejects with
 * DownloadCancelled or an Error saying what went wrong.
 */
export async function downloadApk(url: string, size: number, progress: (received: number, total: number) => void): Promise<string> {
  const sub = await VbNative.addListener('updateProgress', (p) => progress(Number(p.received) || 0, Number(p.total) || 0));
  try {
    return (await VbNative.downloadUpdate({ url, size })).version;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'CANCELLED') throw new DownloadCancelled();
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    void sub.remove();
  }
}

export function cancelApkDownload(): void {
  VbNative.cancelUpdate().catch(() => {});
}

/**
 * Open Android's installer on the downloaded APK. 'permission' means Android's "Install unknown apps" page
 * opened first; `later` then gets what happened when the player came back ('installing', 'denied', 'failed').
 */
export async function installApk(later: (s: InstallState) => void): Promise<InstallState> {
  // One waiting listener at most: a second Install tap replaces the first one's.
  void installSub?.remove();
  const sub = await VbNative.addListener('updateInstall', (p) => {
    void sub.remove();
    later(p.state);
  });
  installSub = sub;
  try {
    const { state } = await VbNative.installUpdate();
    if (state !== 'permission') void sub.remove();
    return state;
  } catch {
    void sub.remove();
    return 'failed';
  }
}

let installSub: PluginListenerHandle | null = null;
