// Update check for the Android app when it was installed from an APK by hand (a GitHub release), not
// from Google Play. Play installs never look for updates here: Google Play updates them, and Play's
// policy forbids an app updating itself any other way. The browser, portal and `npm run dev` builds never
// check either.
//
// At most once per 24 h, after the menu is up, the app asks GitHub for the latest release (one
// unauthenticated GET to api.github.com, nothing sent but the request itself). A newer vX.Y.Z tag with an
// .apk asset offers Update now / Later / Skip this version. The GitHub APK build downloads it inside the game
// with a progress bar and opens Android's installer on it (app/updateUi.ts); older app builds and Android 6
// open the APK's address in the system browser instead. Offline, rate-limited or any other
// failure: nothing is shown. Settings > Check for updates asks at once and says what it found.

import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from './appVersion';
import { installSource, type InstallSource } from './native';

export const REPO = 'Mitovoid-AI/VelocityBlocks';
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Only APKs attached to this repo's releases are offered (browser_download_url starts with this). */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
/** Automatic checks: at most one per this long (ms). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 8000;
/** Release notes longer than this (characters) are cut. */
export const NOTES_MAX = 600;
/** Installers that mean Google Play: such installs never self-update. */
export const PLAY_INSTALLERS: readonly string[] = ['com.android.vending', 'com.google.android.feedback'];

// ------------------------------------------------------------------ Versions

export type Semver = readonly [number, number, number];

/** 'v1.3.0', '1.3.0' or '1.3' (= 1.3.0). Pre-release or build suffixes ('1.3.0-beta') and anything else: null. */
export function parseVersion(s: unknown): Semver | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?\s*$/i.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** <0 when a is older than b, 0 when equal, >0 when newer. */
export function compareVersions(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const versionText = (v: Semver): string => v.join('.');

// ------------------------------------------------------------------ Releases

export interface ApkAsset {
  name: string;
  /** browser_download_url: a https://github.com/<REPO>/releases/download/... address. */
  url: string;
  /** Bytes (0 when GitHub did not say). */
  size: number;
}

/** The first release asset whose name ends in .apk and that downloads from this repo's releases. */
export function pickApkAsset(assets: unknown): ApkAsset | null {
  if (!Array.isArray(assets)) return null;
  for (const a of assets as unknown[]) {
    if (!a || typeof a !== 'object') continue;
    const { name, browser_download_url: url, size } = a as Record<string, unknown>;
    if (typeof name !== 'string' || !/\.apk$/i.test(name.trim())) continue;
    if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) continue;
    return { name: name.trim(), url, size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0 };
  }
  return null;
}

/**
 * Release notes as plain text, at most `max` characters (cut at a word, with an ellipsis). Light Markdown
 * is undone ([text](url) -> text, heading marks, ** and __, HTML comments); the result is still untrusted
 * text: put it on the page with textContent or esc(), never as HTML.
 */
export function plainNotes(body: unknown, max = NOTES_MAX): string {
  if (typeof body !== 'string') return '';
  let t = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // Control characters (but not newlines and tabs) have no business in a popup.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.search(/\s\S*$/);
    t = `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
  }
  return t;
}

export interface UpdateInfo {
  /** 'X.Y.Z' */
  version: string;
  /** The release's tag as published ('v1.3.0'): what Skip this version remembers. */
  tag: string;
  /** Plain text (plainNotes), possibly empty. */
  notes: string;
  apk: ApkAsset;
}

/**
 * What a GitHub "latest release" answer offers over `current`: null for a draft, a pre-release, a tag that
 * is not a plain version, one that is not newer, or a release with no APK.
 */
export function releaseUpdate(json: unknown, current: string): UpdateInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const v = parseVersion(tag);
  const cur = parseVersion(current);
  if (!v || !cur || compareVersions(v, cur) <= 0) return null;
  const apk = pickApkAsset(r.assets);
  if (!apk) return null;
  return { version: versionText(v), tag, notes: plainNotes(r.body), apk };
}

// ------------------------------------------------------------------ Who checks

/**
 * - sideload: the Android app installed from an APK (checks for updates)
 * - play: the Android app installed from Google Play (never checks: Play updates it)
 * - off: everything else (web, portal and dev builds, iOS, an install source Android would not tell)
 */
export type UpdateChannel = 'sideload' | 'play' | 'off';

export interface ChannelEnv {
  /** Capacitor.getPlatform(): 'android', 'ios' or 'web'. */
  platform: string;
  /** Capacitor.isNativePlatform(). */
  native: boolean;
  /** __VB_ADS__: 'none' outside the portal builds. */
  ads: string;
  /** import.meta.env.DEV (`npm run dev`). */
  dev: boolean;
  install: InstallSource;
}

export function updateChannel(env: ChannelEnv): UpdateChannel {
  if (env.dev || env.ads !== 'none' || env.platform !== 'android' || !env.native) return 'off';
  // Unknown installer: assume Play, which must never see an update offer from here.
  if (!env.install.known) return 'off';
  const who = env.install.installer;
  if (who && PLAY_INSTALLERS.includes(who)) return 'play';
  return 'sideload';
}

// ------------------------------------------------------------------ Remembered state

export interface UpdateState {
  /** When the last automatic or manual check started (ms since 1970), 0 if never. */
  lastCheck: number;
  /** A tag the player chose Skip this version for, or null. */
  skipped: string | null;
}

export interface UpdatePersist {
  load(): UpdateState;
  save(s: UpdateState): void;
}

const UPDATE_KEY = 'vb.update';

/** localStorage 'vb.update' (not touched by Reset records). Unreadable or missing: never checked, nothing skipped. */
export const localUpdatePersist: UpdatePersist = {
  load() {
    try {
      const o = JSON.parse(localStorage.getItem(UPDATE_KEY) ?? 'null') as unknown;
      if (o && typeof o === 'object') {
        const { lastCheck, skipped } = o as Record<string, unknown>;
        return {
          lastCheck: typeof lastCheck === 'number' && Number.isFinite(lastCheck) ? lastCheck : 0,
          skipped: typeof skipped === 'string' && skipped ? skipped : null,
        };
      }
    } catch {
      /* unavailable or corrupt */
    }
    return { lastCheck: 0, skipped: null };
  },
  save(s) {
    try {
      localStorage.setItem(UPDATE_KEY, JSON.stringify(s));
    } catch {
      /* not kept: the worst case is one more check */
    }
  },
};

/** An automatic check is due: never checked, 24 h since the last one, or the clock went back. */
export function autoCheckDue(state: UpdateState, now: number): boolean {
  return state.lastCheck <= 0 || now - state.lastCheck >= CHECK_INTERVAL_MS || now < state.lastCheck;
}

// ------------------------------------------------------------------ The check

export type CheckResult = { kind: 'update'; info: UpdateInfo } | { kind: 'current' } | { kind: 'error'; reason: string };

export type FetchFn = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Ask GitHub for the latest release. Never throws: offline, a timeout, a rate limit (403/429), a server
 * error or a malformed answer is {kind: 'error'}. No release published yet (404) is 'current'.
 */
export async function fetchLatest(fetchFn: FetchFn, current: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<CheckResult> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn(RELEASES_URL, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctl?.signal,
      }),
      timeout,
    ]);
    if (res.status === 404) return { kind: 'current' };
    if (!res.ok) return { kind: 'error', reason: `HTTP ${res.status}` };
    const json = (await Promise.race([res.json(), timeout])) as unknown;
    const info = releaseUpdate(json, current);
    return info ? { kind: 'update', info } : { kind: 'current' };
  } catch (e) {
    return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateCheckerDeps {
  /** Which kind of install this is (asked once). */
  channel: () => Promise<UpdateChannel>;
  persist?: UpdatePersist;
  fetch?: FetchFn;
  now?: () => number;
  current?: string;
  timeoutMs?: number;
}

/** The app's update checker: the 24 h throttle, Skip this version, and the gate on sideloaded installs. */
export class UpdateChecker {
  private readonly persist: UpdatePersist;
  private readonly fetchFn: FetchFn | null;
  private readonly now: () => number;
  readonly current: string;
  private readonly timeoutMs: number;
  private channelP: Promise<UpdateChannel> | null = null;
  /** The channel once known (null until then): Settings shows Check for updates for 'sideload' only. */
  channelNow: UpdateChannel | null = null;
  private busy: Promise<CheckResult> | null = null;

  constructor(private readonly deps: UpdateCheckerDeps) {
    this.persist = deps.persist ?? localUpdatePersist;
    this.fetchFn = deps.fetch ?? (typeof fetch === 'function' ? (u, i) => fetch(u, i) : null);
    this.now = deps.now ?? Date.now;
    this.current = deps.current ?? APP_VERSION;
    this.timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  channel(): Promise<UpdateChannel> {
    this.channelP ??= this.deps.channel().then(
      (c) => (this.channelNow = c),
      () => (this.channelNow = 'off'),
    );
    return this.channelP;
  }

  /** Whether this install checks for updates at all (and Settings offers the button). */
  async enabled(): Promise<boolean> {
    return (await this.channel()) === 'sideload';
  }

  /**
   * The automatic check (once the menu is up): an update to offer, or null (not a sideloaded install, not
   * due yet, nothing newer, the version was skipped, or the check failed).
   */
  async auto(): Promise<UpdateInfo | null> {
    if (!(await this.enabled())) return null;
    const st = this.persist.load();
    if (!autoCheckDue(st, this.now())) return null;
    const r = await this.run();
    if (r.kind !== 'update') return null;
    return r.info.tag === this.persist.load().skipped ? null : r.info;
  }

  /** Settings > Check for updates: asks now, whatever the throttle; a skipped version is offered again. */
  async manual(): Promise<CheckResult> {
    if (!(await this.enabled())) return { kind: 'error', reason: 'updates are not checked on this install' };
    return this.run();
  }

  /** Skip this version: the automatic check stays quiet about this tag (a later one is offered). */
  skip(tag: string): void {
    this.persist.save({ ...this.persist.load(), skipped: tag });
  }

  /** One request at a time; the start time counts towards the 24 h (a failed check also waits a day). */
  private run(): Promise<CheckResult> {
    if (this.busy) return this.busy;
    const f = this.fetchFn;
    if (!f) return Promise.resolve({ kind: 'error', reason: 'no fetch' });
    this.persist.save({ ...this.persist.load(), lastCheck: this.now() });
    this.busy = fetchLatest(f, this.current, this.timeoutMs).finally(() => (this.busy = null));
    return this.busy;
  }
}

/** The channel of the running app: asks Capacitor and the Android plugin. */
export async function runtimeChannel(): Promise<UpdateChannel> {
  // Off without even asking Android in the dev server and the portal builds.
  const ads = typeof __VB_ADS__ === 'string' ? __VB_ADS__ : 'none';
  if (import.meta.env.DEV || ads !== 'none') return 'off';
  let platform = 'web';
  let native = false;
  try {
    platform = Capacitor.getPlatform();
    native = Capacitor.isNativePlatform();
  } catch {
    /* a browser */
  }
  if (platform !== 'android' || !native) return 'off';
  return updateChannel({ platform, native, ads, dev: false, install: await installSource() });
}

/** "12.3 MB" for a download size; '' when unknown. */
export function sizeText(bytes: number): string {
  if (!(bytes > 0)) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
