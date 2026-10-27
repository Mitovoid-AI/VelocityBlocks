// Local persistence: settings, driver profile, personal bests, ghosts and user-made tracks.
// Every access is guarded: storage can be unavailable (private mode, blocked site data).

import { DEFAULT_CAR_BODY, isCarBody, type CarBody } from '../core/cars';
import { isModelId, vehicleModel, type ModelId } from '../core/vehicleModels';
import { DEFAULT_VEHICLE, entryBase, entryKey, isVehicleClass, isWallsKey, VEHICLE_CLASSES, type VehicleClass } from '../core/vehicles';
import { PHYSICS_VERSION, VEHICLE_REV } from '../core/constants';
import { isPhotoDataUrl } from '../core/photo';
// Pure (no DOM, no three): no import cycle.
import { autoStartTier, isQuality, tierCmp } from '../render/autoQuality';
import type { Quality } from '../render/quality';
// Pure, like core/: no import cycle.
import { TILT_DEAD_DEG, TILT_DEAD_MAX, TILT_SMOOTH_DEFAULT } from '../input/tilt';
import type { TrackData } from '../track/track';
import { decodeGhost, encodeGhost, type Ghost } from './ghost';

/** Touch steering: the ◀ ▶ buttons, an on-screen wheel, or tilting the device. */
export type SteerMode = 'buttons' | 'wheel' | 'tilt';
export const STEER_MODES: readonly SteerMode[] = ['buttons', 'wheel', 'tilt'];
/** Touch gas and brake: analog side bars, or the round on/off buttons. */
export type PedalMode = 'bars' | 'buttons';

export interface Settings {
  /**
   * The graphics tier in use. With qualityAuto it is the tier Auto picked for this device (kept here,
   * so older APKs, which read only this key, start on it too); otherwise the player's choice.
   */
  quality: Quality;
  /** Settings > Graphics quality: Auto (the default for players who never chose one). */
  qualityAuto: boolean;
  /** Auto: the lowest tier this device was too slow for (Auto never steps back up into it), or null. */
  qualityFailed: Quality | null;
  volume: number;
  camera: 'chase' | 'far' | 'hood';
  showGhost: boolean;
  /** Race the target ghost (Gold, then the Author, then the PB) with its line on the road. */
  medalGhosts: boolean;
  /** The ghost the live gap is measured to ('auto': the next goal, see raceMode.ts autoChase). */
  chase: ChaseTarget;
  autoAccelerate: boolean;
  steerMode: SteerMode;
  pedals: PedalMode;
  /**
   * Tilt steering: 0 (gentle, full lock at 35 degrees) .. 1 (sharp, 12 degrees), continuous (a
   * slider). Older builds stepped it in eighths; they show the nearest of their 1..9 steps.
   */
  tiltSensitivity: number;
  /** Tilt steering: the device roll that means straight ahead, in degrees (-30..30). */
  tiltCenter: number;
  /** tiltCenter was set with Recentre (Settings, Profile, Tilt screen): races keep it instead of taking straight ahead at GO. */
  tiltCenterSet: boolean;
  /** The one-time "New: steering wheel, tilt and pedal bars" toast has been shown. */
  controlsTipShown: boolean;
  /** steerMode === 'tilt', kept for older APKs, which read only this (saveSettings syncs it). */
  tilt: boolean;
  /** Traction control (TcLevel in physics/vehicle): 'low' lets the rear wheels spin. Auto-accelerate always races on 'normal'. */
  tractionControl: 'normal' | 'low';
  /** Show the coloured racing line on the road (green throttle, yellow lift, red brake). */
  racingLine: boolean;
  /** "Walls on all roads": barriers along every road edge (off = open roads, walls on raised decks only). */
  walls: boolean;
  /** Tilt steering: input dead zone around straight ahead, in degrees (0..6; 1.5 as in earlier builds). */
  tiltDeadzone: number;
  /** Tilt steering: smoothing of the sensor, 0 (raw) .. 1 (heavy); 0.5 is the light average of earlier builds (smoothingCutoff). */
  tiltSmoothing: number;
  /** Tilt steering: centre feel, 0 (linear, as in earlier builds) .. 1 (gentle around straight ahead, same full lock). */
  tiltCurve: number;
  /** Faster steering response for analog steering (tilt and the on-screen wheel); assistsFor, applied at each start. */
  analogSteer: boolean;
  // Older builds also kept playerName and carColor here. They now live in Profile, but the
  // keys stay in the stored object (and in memory), so an older APK still finds them.
}

/** The driver: name and car preferences ('vb.profile'). The photo is stored separately. */
export interface Profile {
  name: string;
  carColor: string;
  carBody: CarBody;
  /** Car, Bike or Truck: each has its own handling, records and author times. */
  vehicle: VehicleClass;
  /**
   * The Realistic look per class: a model of that class (vehicleModels.ts), or absent for the Classic
   * (procedural) vehicle. Looks only: records, ghosts and medals do not depend on it.
   */
  models: Partial<Record<VehicleClass, ModelId>>;
  /** Float the photo above the car while racing. */
  showBadge: boolean;
  /** The first-launch setup page has been completed or skipped. */
  setupDone: boolean;
}

export interface RunRecord {
  best: number;
  cpTimes: number[];
  finishes: number;
}

export interface SavedTrack {
  id: string;
  data: TrackData;
  updated: number;
}

const PREFIX = 'vb.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** False when the value could not be stored (quota, storage unavailable). */
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    /* storage full or unavailable: progress simply isn't kept */
    return false;
  }
}

/** A stored JSON value that should be an object; `null`, numbers and arrays become {}. */
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const PROFILE_VERSION = 1;
export const PROFILE_NAME_MAX = 20;
export const DEFAULT_NAME = 'Player';
export const DEFAULT_CAR_COLOR = '#e8452c';

// A raw string, not JSON, under its own key: a name keystroke never rewrites ~30k
// characters of base64, and a quota failure on the photo can't block the name or colour.
const PHOTO_KEY = PREFIX + 'profile.photo';

// Control characters, zero-width spaces and bidi controls (which could flip the direction
// of the text around the name). ZWNJ/ZWJ (U+200C/D) stay: emoji sequences and Indic or
// Persian names need them.
const NAME_STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A displayable driver name of at most 20 characters; empty becomes 'Player'. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  // Tabs and newlines become spaces before the control characters go.
  const s = raw.replace(/\s+/g, ' ').replace(NAME_STRIP, '').replace(/ {2,}/g, ' ').trim();
  // Array.from counts code points, so an emoji is never cut in half.
  return Array.from(s).slice(0, PROFILE_NAME_MAX).join('').trim() || DEFAULT_NAME;
}

/** '#rrggbb' in lower case, else the fallback. Safe to put in a style attribute. */
export function sanitizeColor(raw: unknown, fallback = DEFAULT_CAR_COLOR): string {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

/** The stored realistic model per class: a known model of that very class, or nothing (Classic). */
export function sanitizeModels(raw: unknown): Partial<Record<VehicleClass, ModelId>> {
  const o = asObject(raw);
  const out: Partial<Record<VehicleClass, ModelId>> = {};
  for (const cls of VEHICLE_CLASSES) {
    const v = o[cls];
    if (isModelId(v) && vehicleModel(v).cls === cls) out[cls] = v;
  }
  return out;
}

/** Build the profile from what is stored, falling back to the pre-profile settings keys. */
export function migrateProfile(rawProfile: unknown, legacySettings: Record<string, unknown>): Profile {
  const p = asObject(rawProfile);
  return {
    name: sanitizeName(p.name ?? legacySettings.playerName),
    carColor: sanitizeColor(p.carColor ?? legacySettings.carColor),
    carBody: isCarBody(p.carBody) ? p.carBody : DEFAULT_CAR_BODY,
    vehicle: isVehicleClass(p.vehicle) ? p.vehicle : DEFAULT_VEHICLE,
    models: sanitizeModels(p.models),
    showBadge: typeof p.showBadge === 'boolean' ? p.showBadge : true,
    setupDone: p.setupDone === true,
  };
}

const touchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

/** What builds before Auto quality started a player on: touchscreens Medium, else High. */
export const legacyDefaultQuality = (touch: boolean): Quality => (touch ? 'medium' : 'high');

/** Ghosts the live gap can be measured to, in the order the pause menu cycles them. */
export const CHASE_TARGETS = ['auto', 'pb', 'author', 'gold', 'silver', 'bronze'] as const;
export type ChaseTarget = (typeof CHASE_TARGETS)[number];

export const DEFAULT_SETTINGS: Settings = {
  // Auto: phones and tablets start on medium (smaller shadow map, capped pixel ratio), and the frame
  // rate in the first races moves it (render/autoQuality.ts).
  quality: autoStartTier(touchDevice, null),
  qualityAuto: true,
  qualityFailed: null,
  volume: 0.7,
  camera: 'chase',
  showGhost: true,
  medalGhosts: true,
  chase: 'auto',
  autoAccelerate: false,
  steerMode: 'buttons',
  pedals: 'bars',
  tiltSensitivity: 0.5,
  tiltCenter: 0,
  tiltCenterSet: false,
  controlsTipShown: false,
  tilt: false,
  tractionControl: 'normal',
  racingLine: false,
  walls: false,
  // Tilt tuning defaults are the feel of earlier builds (only the steering rack's analog assist is new).
  tiltDeadzone: TILT_DEAD_DEG,
  tiltSmoothing: TILT_SMOOTH_DEFAULT,
  tiltCurve: 0,
  analogSteer: true,
};

/** A finite number clamped to lo..hi, else the fallback. */
function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/**
 * Settings from what is stored: defaults for missing keys, and the control keys validated.
 * Legacy and unknown keys pass through, so an older APK finds its own keys again. `tilt` is
 * written by every build, so it decides tilt or not: a tilt switch flipped in an older APK
 * after a downgrade wins over the steerMode it carried along.
 */
export function migrateSettings(raw: Record<string, unknown>, touch = touchDevice): Settings {
  const saved = STEER_MODES.includes(raw.steerMode as SteerMode) ? (raw.steerMode as SteerMode) : 'buttons';
  const steerMode: SteerMode = raw.tilt === true ? 'tilt' : saved === 'tilt' ? 'buttons' : saved;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    autoAccelerate: raw.autoAccelerate === true,
    steerMode,
    tilt: steerMode === 'tilt',
    pedals: raw.pedals === 'buttons' ? 'buttons' : 'bars',
    tiltSensitivity: num(raw.tiltSensitivity, 0, 1, DEFAULT_SETTINGS.tiltSensitivity),
    tiltCenter: num(raw.tiltCenter, -30, 30, DEFAULT_SETTINGS.tiltCenter),
    tiltCenterSet: raw.tiltCenterSet === true,
    controlsTipShown: raw.controlsTipShown === true,
    tractionControl: raw.tractionControl === 'low' ? 'low' : 'normal',
    racingLine: raw.racingLine === true,
    medalGhosts: raw.medalGhosts !== false,
    chase: CHASE_TARGETS.includes(raw.chase as ChaseTarget) ? (raw.chase as ChaseTarget) : 'auto',
    walls: raw.walls === true,
    tiltDeadzone: num(raw.tiltDeadzone, 0, TILT_DEAD_MAX, DEFAULT_SETTINGS.tiltDeadzone),
    tiltSmoothing: num(raw.tiltSmoothing, 0, 1, DEFAULT_SETTINGS.tiltSmoothing),
    tiltCurve: num(raw.tiltCurve, 0, 1, DEFAULT_SETTINGS.tiltCurve),
    analogSteer: raw.analogSteer !== false,
    ...migrateQuality(raw, touch),
  } as Settings;
}

/**
 * Graphics quality from what is stored. Builds before Auto saved the whole settings object, default
 * tier included, so a stored tier equal to that platform's old default most likely was never chosen:
 * it becomes Auto (which starts from that same tier). Any other stored tier was the player's choice
 * and is kept. Auto never starts on or above a tier this device was too slow for.
 */
export function migrateQuality(raw: Record<string, unknown>, touch = touchDevice): Pick<Settings, 'quality' | 'qualityAuto' | 'qualityFailed'> {
  const stored = isQuality(raw.quality) ? raw.quality : null;
  const qualityFailed = isQuality(raw.qualityFailed) ? raw.qualityFailed : null;
  const qualityAuto =
    typeof raw.qualityAuto === 'boolean' ? raw.qualityAuto : stored === null || stored === legacyDefaultQuality(touch);
  let quality = stored ?? autoStartTier(touch, qualityFailed);
  if (qualityAuto && qualityFailed !== null && tierCmp(quality, qualityFailed) >= 0) quality = autoStartTier(touch, qualityFailed);
  return { quality, qualityAuto, qualityFailed };
}

// ---- PB ghosts: about 2 KB of base64 per second of run, so with three vehicle classes and two wall
// modes they are what fills the ~5 MB localStorage quota. A use list ('vb.ghost.lru', oldest first,
// cleared with the ghosts by resetProgress) picks which one goes when a new PB ghost does not fit.

const GHOST_LRU = `${PREFIX}ghost.lru`;
/** Ghosts evicted at most for one save (a long new run may need more than one old one's room). */
const GHOST_EVICT_MAX = 4;

const ghostKey = (key: string): string => `${PREFIX}ghost.v${PHYSICS_VERSION}.${key}`;

function readLru(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GHOST_LRU) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Write the use list. When storage is full the oldest entries are dropped until it fits: ghosts
 * missing from the list count as the oldest anyway, so the order of the rest still holds.
 */
function writeLru(list: string[]): boolean {
  for (let l = list; ; l = l.slice(Math.floor(l.length / 2))) {
    try {
      localStorage.setItem(GHOST_LRU, JSON.stringify(l));
      return true;
    } catch {
      if (l.length <= 1) return false;
    }
  }
}

/** This physics version's stored ghosts (full storage keys). */
function storedGhosts(): string[] {
  const prefix = `${PREFIX}ghost.v${PHYSICS_VERSION}.`;
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/** The use list with ghost `k` (full storage key) as the most recent; gone ghosts are left out. */
function lruWith(k: string): string[] {
  const stored = new Set(storedGhosts());
  return [...readLru().filter((x) => x !== k && stored.has(x)), k];
}

/** Mark a ghost (full storage key) as just used. */
function touchGhost(k: string): void {
  try {
    writeLru(lruWith(k));
  } catch {
    /* unavailable: the order is only a hint */
  }
}

/**
 * The ghost to evict before saving `keep`: one this build has never seen used (saved by an older
 * build, so not in the list) first, else the least recently used one. Null when there is none.
 */
function oldestGhost(keep: string): string | null {
  const stored = storedGhosts().filter((k) => k !== keep);
  if (!stored.length) return null;
  const lru = readLru();
  const rank = (k: string) => lru.indexOf(k); // -1: never used by this build
  return stored.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

export class Store {
  settings: Settings;
  profile: Profile;
  /** This install was played before (old settings, records, tracks), so setup says "New". */
  readonly returningPlayer: boolean;
  private records: Record<string, RunRecord>;
  /** Record keys ever finished under any physics version: campaign unlocks survive a bump. */
  private finished: Set<string>;
  /** Campaign tracks opened with a rewarded ad (browser builds); kept across physics versions. */
  private adUnlocks: Set<string>;
  private photo: string | null | undefined; // undefined = not read yet

  constructor() {
    const rawSettings = asObject(read<unknown>('settings', {}));
    // Legacy playerName/carColor ride along untouched, so saveSettings writes them back.
    this.settings = migrateSettings(rawSettings);
    this.records = asObject(read<unknown>(`records.v${PHYSICS_VERSION}`, {})) as Record<string, RunRecord>;
    this.finished = this.loadFinished();
    const unlocks = read<unknown>('unlocks.ad', []);
    this.adUnlocks = new Set(Array.isArray(unlocks) ? unlocks.filter((k): k is string => typeof k === 'string') : []);
    const rawProfile = read<unknown>('profile', null);
    this.profile = migrateProfile(rawProfile, rawSettings);
    // Only old data counts, never 'vb.profile' itself: closing the app on the setup page
    // must not change its heading on the next launch.
    const tracks = read<unknown>('tracks', []);
    this.returningPlayer =
      Object.keys(rawSettings).length > 0 ||
      Object.keys(this.records).length > 0 ||
      this.finished.size > 0 ||
      (Array.isArray(tracks) && tracks.length > 0) ||
      read<unknown>('editor.draft', null) !== null;
    // If this write fails the legacy keys are still there, so the next launch migrates again.
    if (rawProfile === null) this.saveProfile();
    this.pruneOldGhosts();
    this.dropStaleAuthorTimes();
  }

  /**
   * A custom track's author time is a test drive under the physics of the day. Records and ghosts
   * are kept per PHYSICS_VERSION; these carry no version, so they are cleared once after a bump and
   * the next finished test drive sets a fresh one. The other classes' times (authorTimes) carry their
   * class revision (a retune retires them where they are read), so only a physics bump clears them here.
   */
  private dropStaleAuthorTimes(): void {
    if (read<unknown>('tracks.physics', null) === PHYSICS_VERSION) return;
    const strip = (t: unknown): unknown => {
      const s = asObject(t) as Partial<SavedTrack>;
      return s.data && typeof s.data === 'object' ? { ...s, data: { ...s.data, authorTime: undefined, authorTimes: undefined } } : t;
    };
    let ok = true;
    const list = read<unknown>('tracks', []);
    if (Array.isArray(list) && list.length) ok = write('tracks', list.map(strip)) && ok;
    const draft = read<unknown>('editor.draft', null);
    if (draft) ok = write('editor.draft', strip(draft)) && ok;
    // A failed write (storage full) tries again on the next launch.
    if (ok) write('tracks.physics', PHYSICS_VERSION);
  }

  /**
   * write(), making room when storage is full by evicting the least recently used PB ghosts (a few at
   * most): records, unlocks, settings and the profile are worth more than any ghost. A ghost save fills
   * the quota on purpose, so without this the next new record would live only until the app closes.
   */
  private writeOrEvict(key: string, value: unknown): boolean {
    for (let evicted = 0; ; evicted++) {
      if (write(key, value)) return true;
      if (evicted >= GHOST_EVICT_MAX) return false;
      try {
        const victim = oldestGhost('');
        if (!victim) return false;
        localStorage.removeItem(victim);
      } catch {
        return false;
      }
    }
  }

  saveSettings(): void {
    this.settings.tilt = this.settings.steerMode === 'tilt';
    this.writeOrEvict('settings', this.settings);
  }

  saveProfile(): boolean {
    return this.writeOrEvict('profile', { v: PROFILE_VERSION, ...this.profile });
  }

  /** The stored photo as a validated data URL, or null. */
  profilePhoto(): string | null {
    if (this.photo === undefined) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(PHOTO_KEY);
      } catch {
        /* unavailable: no photo */
      }
      this.photo = isPhotoDataUrl(raw) ? raw : null;
    }
    return this.photo;
  }

  /**
   * Set (or with null, remove) the photo. False means it was not persisted: an invalid value
   * is ignored, while a storage failure still keeps the new photo for this session. The photo
   * stored before is never deleted on failure (Chromium's quota check already counts the
   * value being replaced, so removing it first would free nothing).
   */
  saveProfilePhoto(url: string | null): boolean {
    if (url !== null && !isPhotoDataUrl(url)) return false;
    this.photo = url;
    try {
      if (url) localStorage.setItem(PHOTO_KEY, url);
      else localStorage.removeItem(PHOTO_KEY);
      return true;
    } catch {
      return false;
    }
  }

  record(key: string): RunRecord | undefined {
    return this.records[key];
  }

  /**
   * The track of `key` (its own key 'c:A01', or any entry key of it) was finished at least once, under
   * this or an earlier physics version, with any vehicle (any revision) and in either wall mode:
   * campaign unlocks are shared, and survive a class retune.
   */
  hasFinished(key: string): boolean {
    const base = entryBase(key);
    return this.finished.has(base) || this.finished.has(key) || Object.keys(this.records).some((k) => entryBase(k) === base);
  }

  adUnlocked(key: string): boolean {
    return this.adUnlocks.has(key);
  }

  unlockWithAd(key: string): void {
    this.adUnlocks.add(key);
    this.writeOrEvict('unlocks.ad', [...this.adUnlocks]);
  }

  /**
   * Store a finished run; returns the previous best (if any), and `saved` false when the record or the
   * unlock could not be stored even after evicting ghosts (it then lasts only until the app closes).
   */
  addFinish(key: string, time: number, cpTimes: number[]): { improved: boolean; previous: number | null; saved: boolean } {
    const r = this.records[key];
    const previous = r ? r.best : null;
    const improved = !r || time < r.best;
    this.records[key] = {
      best: improved ? time : r!.best,
      cpTimes: improved ? cpTimes.slice() : r!.cpTimes,
      finishes: (r?.finishes ?? 0) + 1,
    };
    let saved = this.writeOrEvict(`records.v${PHYSICS_VERSION}`, this.records);
    // The track's own key: a finish with any vehicle or wall mode unlocks the next campaign track.
    const base = entryBase(key);
    if (!this.finished.has(base)) {
      this.finished.add(base);
      saved = this.writeOrEvict('finished', [...this.finished]) && saved;
    }
    return { improved, previous, saved };
  }

  /** A PB ghost for a record key: this physics version, and the class and revision the key names. */
  ghost(key: string): Ghost | null {
    try {
      const raw = localStorage.getItem(ghostKey(key));
      const g = raw ? decodeGhost(raw) : null;
      if (!g || g.physics !== PHYSICS_VERSION || g.rev !== VEHICLE_REV[g.vehicle]) return null;
      if (entryKey(entryBase(key), g.vehicle, isWallsKey(key)) !== key) return null;
      touchGhost(ghostKey(key));
      return g;
    } catch {
      return null;
    }
  }

  /**
   * Save a PB ghost. When storage is full the least recently used ghosts (other tracks', vehicles' or
   * wall modes') are evicted, a few at most, to make room: a PB ghost is worth more than an old one.
   * The use list is part of the save, so the new ghost is always the most recent one and never the
   * next to go. False when it could not be stored; the evicted ghosts are then put back, and an older
   * ghost under this key (a slower run than the new record) is dropped.
   */
  saveGhost(key: string, g: Ghost): boolean {
    const k = ghostKey(key);
    let text: string;
    try {
      text = encodeGhost(g);
    } catch {
      return false;
    }
    const evicted: [string, string][] = [];
    let saved = false;
    for (;;) {
      try {
        if (!saved) {
          localStorage.setItem(k, text);
          saved = true;
        }
        localStorage.setItem(GHOST_LRU, JSON.stringify(lruWith(k)));
        return true;
      } catch {
        // Storage full (or unavailable, when there is nothing to evict either).
        try {
          const victim = evicted.length < GHOST_EVICT_MAX ? oldestGhost(k) : null;
          if (victim) {
            evicted.push([victim, localStorage.getItem(victim) ?? '']);
            localStorage.removeItem(victim);
            continue;
          }
        } catch {
          /* unavailable: give up below */
        }
        // Saved, but the list still does not fit: a shorter list keeps it as the most recent.
        if (saved) {
          try {
            writeLru(lruWith(k));
          } catch {
            /* unavailable */
          }
          return true;
        }
        // Too big even with room made: the new ghost was never written. An older ghost under the same key
        // is a slower run than the record now says: it goes (the race keeps the new one in memory for this
        // session). The evicted ones fit back.
        try {
          localStorage.removeItem(k);
        } catch {
          /* unavailable */
        }
        for (const [vk, v] of evicted) {
          try {
            localStorage.setItem(vk, v);
          } catch {
            /* lost */
          }
        }
        return false;
      }
    }
  }

  /** Clears records, unlocks and ghosts. The profile and its photo are kept. */
  resetProgress(): void {
    this.records = {};
    write(`records.v${PHYSICS_VERSION}`, this.records);
    // Stored as [] rather than removed, so the next launch does not re-seed from old records.
    this.finished.clear();
    write('finished', []);
    this.adUnlocks.clear();
    write('unlocks.ad', []);
    try {
      const drop: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX + 'ghost.')) drop.push(k);
      }
      drop.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
  }

  /** The 'finished' set, seeded once from the records of every physics version. */
  private loadFinished(): Set<string> {
    const saved = read<unknown>('finished', null);
    if (Array.isArray(saved)) return new Set(saved.filter((k): k is string => typeof k === 'string'));
    const set = new Set<string>();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^vb\.records\.v\d+$/.test(k)) continue;
        try {
          for (const r of Object.keys(asObject(JSON.parse(localStorage.getItem(k) ?? 'null')))) set.add(entryBase(r));
        } catch {
          /* a corrupt record list unlocks nothing */
        }
      }
    } catch {
      /* unavailable: unlocks fall back to this version's records */
    }
    write('finished', [...set]);
    return set;
  }

  /** Ghosts of older physics versions can never load again; free their space (~100 KB each). */
  private pruneOldGhosts(): void {
    try {
      const current = `${PREFIX}ghost.v${PHYSICS_VERSION}.`;
      const drop: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX + 'ghost.v') && !k.startsWith(current)) drop.push(k);
      }
      drop.forEach((k) => localStorage.removeItem(k));
      const lru = readLru();
      if (lru.some((k) => !k.startsWith(current))) writeLru(lru.filter((k) => k.startsWith(current)));
    } catch {
      /* ignore */
    }
  }

  customTracks(): SavedTrack[] {
    return read<SavedTrack[]>('tracks', []).sort((a, b) => b.updated - a.updated);
  }

  /** False when storage is full even after evicting ghosts. */
  saveCustomTrack(t: SavedTrack): boolean {
    const list = read<SavedTrack[]>('tracks', []).filter((x) => x.id !== t.id);
    list.push({ ...t, updated: Date.now() });
    return this.writeOrEvict('tracks', list);
  }

  deleteCustomTrack(id: string): void {
    write(
      'tracks',
      read<SavedTrack[]>('tracks', []).filter((x) => x.id !== id),
    );
  }

  editorDraft(): SavedTrack | null {
    return read<SavedTrack | null>('editor.draft', null);
  }

  saveEditorDraft(t: SavedTrack): void {
    this.writeOrEvict('editor.draft', t);
  }
}

// ---- Full Game (the Google Play in-app purchase, app/fullGame.ts). Kept apart from progress: Settings >
// Reset records & ghosts never touches it. A local copy so the unlock works offline; the store re-checks
// it on every start where Google Play answers (platform/purchases.ts).

/** What the store last said about the Full Game on this install. */
export interface FullGameRecord {
  owned: boolean;
  /** When Google Play last confirmed it (ms since 1970), 0 if never. */
  checked: number;
}

/** Debug Android builds only: Settings' hidden dev switch overrides the store ('owned', 'free'), or null. */
export type DevFullGame = 'owned' | 'free' | null;

const FULL_GAME_KEY = 'fullgame';
const DEV_FULL_GAME_KEY = 'fullgame.dev';

/** The stored Full Game state; anything unreadable counts as not owned. */
export function loadFullGame(): FullGameRecord {
  const o = asObject(read<unknown>(FULL_GAME_KEY, null));
  return {
    owned: o.owned === true,
    checked: typeof o.checked === 'number' && Number.isFinite(o.checked) ? o.checked : 0,
  };
}

/** False when it could not be stored (it then lasts until the game closes; the store re-checks next start). */
export function saveFullGame(r: FullGameRecord): boolean {
  return write(FULL_GAME_KEY, { owned: r.owned === true, checked: r.checked });
}

export function loadDevFullGame(): DevFullGame {
  const v = read<unknown>(DEV_FULL_GAME_KEY, null);
  return v === 'owned' || v === 'free' ? v : null;
}

export function saveDevFullGame(v: DevFullGame): void {
  if (v === null) {
    try {
      localStorage.removeItem(PREFIX + DEV_FULL_GAME_KEY);
    } catch {
      /* unavailable */
    }
  } else write(DEV_FULL_GAME_KEY, v);
}

/** Stable identity for a block layout (records and ghosts follow the layout, not the name). */
export function layoutHash(data: TrackData): string {
  let h = 2166136261;
  // The Desert's sand beside the road drives differently from grass, so it is part of the layout's key (the
  // other themes and the sky are looks only, and a track without a theme keeps the key it always had).
  const s = data.blocks.map((b) => `${b.type}${b.i},${b.j},${b.k},${b.dir}`).join(';') + (data.theme === 'desert' ? '|desert' : '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
