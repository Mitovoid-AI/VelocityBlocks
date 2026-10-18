// Local persistence: settings, driver profile, personal bests, ghosts and user-made tracks.
// Every access is guarded: storage can be unavailable (private mode, blocked site data).

import { DEFAULT_CAR_BODY, isCarBody, type CarBody } from '../core/cars';
import { PHYSICS_VERSION } from '../core/constants';
import { isPhotoDataUrl } from '../core/photo';
import type { TrackData } from '../track/track';
import { decodeGhost, encodeGhost, type Ghost } from './ghost';

export interface Settings {
  quality: 'low' | 'medium' | 'high';
  volume: number;
  camera: 'chase' | 'far' | 'hood';
  showGhost: boolean;
  autoAccelerate: boolean;
  tilt: boolean;
  // Older builds also kept playerName and carColor here. They now live in Profile, but the
  // keys stay in the stored object (and in memory), so an older APK still finds them.
}

/** The driver: name and car preferences ('vb.profile'). The photo is stored separately. */
export interface Profile {
  name: string;
  carColor: string;
  carBody: CarBody;
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

/** Build the profile from what is stored, falling back to the pre-profile settings keys. */
export function migrateProfile(rawProfile: unknown, legacySettings: Record<string, unknown>): Profile {
  const p = asObject(rawProfile);
  return {
    name: sanitizeName(p.name ?? legacySettings.playerName),
    carColor: sanitizeColor(p.carColor ?? legacySettings.carColor),
    carBody: isCarBody(p.carBody) ? p.carBody : DEFAULT_CAR_BODY,
    showBadge: typeof p.showBadge === 'boolean' ? p.showBadge : true,
    setupDone: p.setupDone === true,
  };
}

const touchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export const DEFAULT_SETTINGS: Settings = {
  // Phones and tablets start on medium (smaller shadow map, capped pixel ratio).
  quality: touchDevice ? 'medium' : 'high',
  volume: 0.7,
  camera: 'chase',
  showGhost: true,
  autoAccelerate: false,
  tilt: false,
};

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
    this.settings = { ...DEFAULT_SETTINGS, ...rawSettings } as Settings;
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
  }

  saveSettings(): void {
    write('settings', this.settings);
  }

  saveProfile(): boolean {
    return write('profile', { v: PROFILE_VERSION, ...this.profile });
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

  /** Finished at least once, under this or an earlier physics version. */
  hasFinished(key: string): boolean {
    return this.finished.has(key) || !!this.records[key];
  }

  adUnlocked(key: string): boolean {
    return this.adUnlocks.has(key);
  }

  unlockWithAd(key: string): void {
    this.adUnlocks.add(key);
    write('unlocks.ad', [...this.adUnlocks]);
  }

  /** Store a finished run; returns the previous best (if any). */
  addFinish(key: string, time: number, cpTimes: number[]): { improved: boolean; previous: number | null } {
    const r = this.records[key];
    const previous = r ? r.best : null;
    const improved = !r || time < r.best;
    this.records[key] = {
      best: improved ? time : r!.best,
      cpTimes: improved ? cpTimes.slice() : r!.cpTimes,
      finishes: (r?.finishes ?? 0) + 1,
    };
    write(`records.v${PHYSICS_VERSION}`, this.records);
    if (!this.finished.has(key)) {
      this.finished.add(key);
      write('finished', [...this.finished]);
    }
    return { improved, previous };
  }

  ghost(key: string): Ghost | null {
    try {
      const raw = localStorage.getItem(`${PREFIX}ghost.v${PHYSICS_VERSION}.${key}`);
      const g = raw ? decodeGhost(raw) : null;
      return g && g.physics === PHYSICS_VERSION ? g : null;
    } catch {
      return null;
    }
  }

  saveGhost(key: string, g: Ghost): void {
    try {
      localStorage.setItem(`${PREFIX}ghost.v${PHYSICS_VERSION}.${key}`, encodeGhost(g));
    } catch {
      /* ignore */
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
          for (const r of Object.keys(asObject(JSON.parse(localStorage.getItem(k) ?? 'null')))) set.add(r);
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
    } catch {
      /* ignore */
    }
  }

  customTracks(): SavedTrack[] {
    return read<SavedTrack[]>('tracks', []).sort((a, b) => b.updated - a.updated);
  }

  saveCustomTrack(t: SavedTrack): void {
    const list = read<SavedTrack[]>('tracks', []).filter((x) => x.id !== t.id);
    list.push({ ...t, updated: Date.now() });
    write('tracks', list);
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
    write('editor.draft', t);
  }
}

/** Stable identity for a block layout (records and ghosts follow the layout, not the name). */
export function layoutHash(data: TrackData): string {
  let h = 2166136261;
  const s = data.blocks.map((b) => `${b.type}${b.i},${b.j},${b.k},${b.dir}`).join(';');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
