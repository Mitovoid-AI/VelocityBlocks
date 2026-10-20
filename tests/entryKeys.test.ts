// Record keys per vehicle class and wall mode, and custom-track author times per class.

import { describe, expect, it } from 'vitest';
import { VEHICLE_REV } from '../src/core/constants';
import { entryBase, entryKey, isWallsKey, vehicleTag, VEHICLE_CLASSES } from '../src/core/vehicles';
import { authorTimeAfter, customAuthorTime, withCustomAuthorTime, withoutAuthorTimes } from '../src/app/authorTime';
import { parseEntryKey } from '../src/game/racingLine';
import { layoutHash } from '../src/game/storage';
import type { TrackData } from '../src/track/track';

describe('entryKey', () => {
  it('keeps the car on open roads on the plain, pre-class key (records and ghosts from before the classes kept it)', () => {
    expect(entryKey('c:A01', 'car', false)).toBe('c:A01');
    expect(entryKey('u:3f9k', 'car', false)).toBe('u:3f9k');
  });

  it('tags the other classes with their revision, and the wall mode', () => {
    expect(entryKey('c:A01', 'car', true)).toBe('c:A01|w');
    expect(entryKey('c:A01', 'bike', false)).toBe(`c:A01@bike${VEHICLE_REV.bike}`);
    expect(entryKey('c:A01', 'truck', true)).toBe(`c:A01@truck${VEHICLE_REV.truck}|w`);
    expect(vehicleTag('car')).toBe('');
  });

  it('gives every class and wall mode its own key, all with the same track key', () => {
    const keys = VEHICLE_CLASSES.flatMap((v) => [false, true].map((w) => entryKey('c:A07', v, w)));
    expect(new Set(keys).size).toBe(6);
    for (const k of keys) expect(entryBase(k)).toBe('c:A07');
    expect(keys.filter(isWallsKey)).toHaveLength(3);
  });

  it('round-trips through the racing line key parser', () => {
    for (const v of VEHICLE_CLASSES) {
      for (const w of [false, true]) {
        expect(parseEntryKey(entryKey('c:A03', v, w))).toEqual({ base: 'c:A03', vehicle: v, walls: w });
      }
    }
  });

  it('never meets a track key with its separators', () => {
    const data: TrackData = { name: 'x', author: 'y', blocks: [{ type: 'start', i: 3, j: 4, k: 0, dir: 1 }] };
    expect(layoutHash(data)).not.toMatch(/[@|]/);
    expect(entryBase(`u:${layoutHash(data)}`)).toBe(`u:${layoutHash(data)}`);
  });
});

describe('custom-track author times per class', () => {
  const data: TrackData = { name: 'Mine', author: 'Me', blocks: [], authorTime: 20000 };

  it("reads the car's from authorTime and the others' from authorTimes", () => {
    expect(customAuthorTime(data, 'car')).toBe(20000);
    expect(customAuthorTime(data, 'bike')).toBeNull();
    const d = withCustomAuthorTime(withCustomAuthorTime(data, 'bike', 22000), 'truck', 24000);
    expect(customAuthorTime(d, 'car')).toBe(20000);
    expect(customAuthorTime(d, 'bike')).toBe(22000);
    expect(customAuthorTime(d, 'truck')).toBe(24000);
    expect(d.authorTimes).toEqual({ bike: { t: 22000, rev: VEHICLE_REV.bike }, truck: { t: 24000, rev: VEHICLE_REV.truck } });
    expect(customAuthorTime(withCustomAuthorTime(d, 'car', 19000), 'car')).toBe(19000);
  });

  it('drops a time driven with another revision of the class, and nonsense values', () => {
    const stale: TrackData = { ...data, authorTime: 0, authorTimes: { bike: { t: 22000, rev: VEHICLE_REV.bike + 1 }, truck: { t: Number.NaN, rev: VEHICLE_REV.truck } } };
    expect(customAuthorTime(stale, 'bike')).toBeNull();
    expect(customAuthorTime(stale, 'truck')).toBeNull();
    expect(customAuthorTime(stale, 'car')).toBeNull();
  });

  it('a block edit clears every class', () => {
    const d = withoutAuthorTimes(withCustomAuthorTime(data, 'bike', 22000));
    for (const v of VEHICLE_CLASSES) expect(customAuthorTime(d, v)).toBeNull();
  });

  it('a walls-off test drive sets the first time and lowers it; a walls-on one never does', () => {
    expect(authorTimeAfter(null, 15000, false)).toBe(15000);
    expect(authorTimeAfter(16000, 15000, false)).toBe(15000);
    expect(authorTimeAfter(15000, 15000, false)).toBeNull();
    expect(authorTimeAfter(14000, 15000, false)).toBeNull();
    expect(authorTimeAfter(null, 15000, true)).toBeNull();
    expect(authorTimeAfter(16000, 15000, true)).toBeNull();
  });
});
