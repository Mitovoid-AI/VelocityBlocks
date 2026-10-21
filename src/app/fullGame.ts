// The Full Game: one non-consumable Google Play in-app purchase ('full_game') that opens the premium
// content of the Android app. This file has the build rules, the entitlement and the lock rules; the
// store itself is platform/purchases.ts and the screen is fullGameScreen.ts.
//
// Free everywhere: the Stadium campaign, the Car with its procedural bodies, the editor and My tracks,
// and the first track of every themed set (D01, W01). Premium: the rest of each themed set, the Bike and
// the Truck, and the Realistic models.
//
// Only Android builds sell it. The browser builds (CrazyGames, Poki, the plain web build, `npm run dev`)
// keep everything unlocked: the portal builds earn from ads instead, and the code is MIT anyway. iOS has no
// App Store product set up, so it stays unlocked too.

import { Capacitor } from '@capacitor/core';
import { isModelId, vehicleModel, type ModelId } from '../core/vehicleModels';
import { PREMIUM_VEHICLES, type VehicleClass } from '../core/vehicles';
import {
  loadDevFullGame,
  loadFullGame,
  saveDevFullGame,
  saveFullGame,
  type DevFullGame,
  type FullGameRecord,
  type Profile,
} from '../game/storage';

export { FULL_GAME_ID } from '../platform/purchases';

/** The app version shown at the bottom of Settings: package.json "version" (see platform/appVersion.ts). */
export { APP_VERSION } from '../platform/appVersion';

// ------------------------------------------------------------------ Builds

/**
 * - web: the plain web build and `npm run dev` (everything unlocked)
 * - portal: CrazyGames / Poki / adtest builds (everything unlocked; they earn from ads)
 * - ios: no App Store product yet (everything unlocked)
 * - android-debug: Google Play billing, plus the hidden dev switch in Settings
 * - android-release: Google Play billing only
 */
export type BuildKind = 'web' | 'portal' | 'ios' | 'android-debug' | 'android-release';

export function detectBuildKind(env: { ads: string; platform: string; debug: boolean }): BuildKind {
  if (env.ads !== 'none') return 'portal';
  if (env.platform === 'android') return env.debug ? 'android-debug' : 'android-release';
  if (env.platform === 'ios') return 'ios';
  return 'web';
}

/** `?iap=free` / `?iap=owned` in `npm run dev` only: act as a debug Android build with a fake store. */
export function devSimulation(): DevFullGame {
  if (!import.meta.env.DEV || typeof location === 'undefined') return null;
  const m = /[?&]iap=(free|owned)\b/.exec(location.search);
  return m ? (m[1] as 'free' | 'owned') : null;
}

function runtimeKind(): BuildKind {
  if (devSimulation()) return 'android-debug';
  let platform = 'web';
  let debug = false;
  try {
    platform = Capacitor.getPlatform();
    // Capacitor's Android bridge sets window.Capacitor.DEBUG from the APK's debuggable flag: true in
    // debug builds, false in release builds (the web bundle is the same for both).
    const g = (globalThis as { Capacitor?: { DEBUG?: unknown } }).Capacitor;
    debug = g?.DEBUG === true || (Capacitor as { DEBUG?: unknown }).DEBUG === true;
  } catch {
    /* no Capacitor: a browser */
  }
  return detectBuildKind({ ads: typeof __VB_ADS__ === 'string' ? __VB_ADS__ : 'none', platform, debug });
}

// ------------------------------------------------------------------ Entitlement

export interface FullGamePersist {
  load(): FullGameRecord;
  save(r: FullGameRecord): void;
  loadDev(): DevFullGame;
  saveDev(v: DevFullGame): void;
}

const LOCAL: FullGamePersist = { load: loadFullGame, save: saveFullGame, loadDev: loadDevFullGame, saveDev: saveDevFullGame };

/**
 * Whether the Full Game is open on this install. The store's answer is kept locally (so it works offline)
 * and re-checked whenever Google Play answers. Listeners hear every change of `unlocked`.
 */
export class FullGame {
  private rec: FullGameRecord;
  private dev: DevFullGame;
  private readonly fns = new Set<() => void>();

  constructor(
    readonly kind: BuildKind,
    private readonly persist: FullGamePersist = LOCAL,
  ) {
    this.rec = persist.load();
    this.dev = kind === 'android-debug' ? persist.loadDev() : null;
  }

  /** This build sells the Full Game through Google Play. */
  get billing(): boolean {
    return this.kind === 'android-debug' || this.kind === 'android-release';
  }

  /** The hidden dev switch (Settings > tap the version 7 times) is available. */
  get devTools(): boolean {
    return this.kind === 'android-debug';
  }

  /** Everything is open: a build without billing, a purchase, or (debug builds) the dev switch. */
  get unlocked(): boolean {
    if (!this.billing) return true;
    if (this.dev) return this.dev === 'owned';
    return this.rec.owned;
  }

  /** What Google Play last said (or the local copy of it), whatever the dev switch says. */
  get owned(): boolean {
    return this.rec.owned;
  }

  get checked(): number {
    return this.rec.checked;
  }

  get devOverride(): DevFullGame {
    return this.dev;
  }

  /** Google Play answered: the purchase is owned, or (on a check that found it gone: a refund) not. */
  storeSays(owned: boolean, now = Date.now()): void {
    const was = this.unlocked;
    const changed = owned !== this.rec.owned;
    this.rec = { owned, checked: now };
    try {
      this.persist.save(this.rec);
    } catch {
      /* not kept: the store checks again next start */
    }
    if (changed || was !== this.unlocked) this.emit();
  }

  /** Debug builds: simulate owning ('owned') or not ('free'), or null to follow the store again. */
  setDev(v: DevFullGame): void {
    if (!this.devTools || v === this.dev) return;
    const was = this.unlocked;
    this.dev = v;
    try {
      this.persist.saveDev(v);
    } catch {
      /* session only */
    }
    if (was !== this.unlocked) this.emit();
  }

  /** Called on every change of `unlocked` (and of the stored ownership); returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.fns]) {
      try {
        fn();
      } catch (e) {
        console.error('[fullgame] listener failed', e);
      }
    }
  }
}

let current: FullGame | null = null;

/** The install's entitlement (made on first use). */
export function fullGame(): FullGame {
  return (current ??= new FullGame(runtimeKind()));
}

/** Tests: use this entitlement instead (null: back to the real one). */
export function setFullGame(f: FullGame | null): void {
  current = f;
}

// ------------------------------------------------------------------ Lock rules

/** A campaign track as the lock rules see it: the theme and premium fields are optional data. */
export interface ThemedTrack {
  readonly id: string;
  /** 'stadium', 'desert', 'water', ...: the set it belongs to. Missing: from the id's letter (A, D, W). */
  readonly theme?: unknown;
  /** Overrides the default rule when the track data says so. */
  readonly premium?: unknown;
}

/** The themes that are free all through (every other set is free for its first track only). */
export const FREE_THEMES: ReadonlySet<string> = new Set(['stadium']);

const THEME_BY_LETTER: Record<string, string> = { A: 'stadium', D: 'desert', W: 'water' };
const THEME_LABEL: Record<string, string> = { stadium: 'Stadium', desert: 'Desert', water: 'Water' };

export function trackTheme(t: ThemedTrack): string {
  if (typeof t.theme === 'string' && t.theme) return t.theme;
  return THEME_BY_LETTER[t.id.charAt(0).toUpperCase()] ?? 'stadium';
}

export function themeLabel(theme: string): string {
  return THEME_LABEL[theme] ?? theme.charAt(0).toUpperCase() + theme.slice(1);
}

/**
 * The ids of the tracks that need the Full Game, from the data: a track's own `premium` flag when it has
 * one, else every track of a non-free theme after the first one of that theme in campaign order.
 */
export function premiumTrackIds(list: readonly ThemedTrack[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const t of list) {
    const theme = trackTheme(t);
    const first = !seen.has(theme);
    seen.add(theme);
    const premium = typeof t.premium === 'boolean' ? t.premium : !FREE_THEMES.has(theme) && !first;
    if (premium) out.add(t.id);
  }
  return out;
}

/** One campaign set (a theme), with its tracks' positions in the campaign list, in order. */
export interface CampaignSet {
  theme: string;
  label: string;
  indices: number[];
}

/** The campaign's sets in the order they first appear (Stadium, Desert, Water). */
export function campaignSets(list: readonly ThemedTrack[]): CampaignSet[] {
  const out: CampaignSet[] = [];
  list.forEach((t, i) => {
    const theme = trackTheme(t);
    let s = out.find((x) => x.theme === theme);
    if (!s) out.push((s = { theme, label: themeLabel(theme), indices: [] }));
    s.indices.push(i);
  });
  return out;
}

export function trackLocked(id: string, list: readonly ThemedTrack[], unlocked = fullGame().unlocked): boolean {
  return !unlocked && premiumTrackIds(list).has(id);
}

export function vehicleLocked(v: VehicleClass, unlocked = fullGame().unlocked): boolean {
  return !unlocked && PREMIUM_VEHICLES.has(v);
}

export function modelLocked(id: unknown, unlocked = fullGame().unlocked): boolean {
  return !unlocked && isModelId(id) && vehicleModel(id).premium;
}

/**
 * The class a run uses: the profile's, or the Car while that class is locked. The profile keeps its saved
 * choice, so a purchase brings it straight back.
 */
export function effectiveVehicle(p: Pick<Profile, 'vehicle'>, unlocked = fullGame().unlocked): VehicleClass {
  return vehicleLocked(p.vehicle, unlocked) ? 'car' : p.vehicle;
}

/** The realistic model drawn for a class: the profile's, or null (Classic) while it is locked. */
export function effectiveModel(p: Pick<Profile, 'models'>, cls: VehicleClass, unlocked = fullGame().unlocked): ModelId | null {
  const id = p.models?.[cls];
  return id && !modelLocked(id, unlocked) ? id : null;
}

/** Why a race may not start: its class or its campaign track ('c:<id>') needs the Full Game. */
export type EntryLock = 'vehicle' | 'track' | null;

export function entryLock(
  e: { vehicle: VehicleClass; base: string },
  list: readonly ThemedTrack[],
  unlocked = fullGame().unlocked,
): EntryLock {
  if (unlocked) return null;
  if (vehicleLocked(e.vehicle, unlocked)) return 'vehicle';
  if (e.base.startsWith('c:') && trackLocked(e.base.slice(2), list, unlocked)) return 'track';
  return null;
}
