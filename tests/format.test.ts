import { describe, expect, it } from 'vitest';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { classAuthorTimes, medalFor, medalTimes, type AuthorTable } from '../src/game/medals';
import { formatTime } from '../src/game/race';
import { buildTrack } from '../src/track/builder';
import { campaign } from '../src/track/campaign';
import { exportTrack, importTrack } from '../src/track/format';
import { authorTimeFor, withAuthorTime, type TrackData } from '../src/track/track';

describe('track files', () => {
  it('round-trips a campaign track through export/import', () => {
    const data = { ...campaign()[3].data, authorTime: 16470 };
    const back = importTrack(exportTrack(data));
    expect(back.blocks).toEqual(data.blocks);
    expect(back.name).toBe(data.name);
    expect(back.authorTime).toBe(16470);
  });

  it("keeps the other classes' author times, with their revisions", () => {
    let data: TrackData = { ...campaign()[0].data, authorTime: 13900 };
    data = withAuthorTime(data, 'bike', 15440);
    data = withAuthorTime(data, 'truck', 15400);
    expect(data.authorTimes).toEqual({ bike: { t: 15440, rev: VEHICLE_REV.bike }, truck: { t: 15400, rev: VEHICLE_REV.truck } });
    const back = importTrack(exportTrack(data));
    expect(back.authorTime).toBe(13900);
    expect(authorTimeFor(back, 'car')).toBe(13900);
    expect(authorTimeFor(back, 'bike')).toBe(15440);
    expect(authorTimeFor(back, 'truck')).toBe(15400);
    // Clearing one class leaves the others; clearing the last drops the field.
    expect(withAuthorTime(data, 'bike', undefined).authorTimes).toEqual({ truck: { t: 15400, rev: VEHICLE_REV.truck } });
    expect(withAuthorTime(withAuthorTime(data, 'bike', undefined), 'truck', undefined).authorTimes).toBeUndefined();
    expect(withAuthorTime(data, 'car', undefined).authorTime).toBeUndefined();
    // A file without them (older builds) is car-only, and exports without the field.
    const legacy = importTrack(exportTrack(campaign()[0].data));
    expect(legacy.authorTimes).toBeUndefined();
    expect(authorTimeFor(legacy, 'bike')).toBeNull();
    expect(JSON.parse(exportTrack(campaign()[0].data))).not.toHaveProperty('authorTimes');
  });

  it("drops invalid class author times, and ignores another revision's", () => {
    const file = JSON.parse(exportTrack(campaign()[0].data));
    file.authorTimes = { bike: { t: -5, rev: 1 }, truck: { t: 'fast', rev: 1 }, boat: { t: 1000, rev: 1 } };
    expect(importTrack(JSON.stringify(file)).authorTimes).toBeUndefined();
    file.authorTimes = { bike: { t: NaN, rev: 1 }, truck: { t: 20000.4, rev: 1.5 } };
    expect(importTrack(JSON.stringify(file)).authorTimes).toBeUndefined();
    file.authorTimes = { bike: { t: 20000.4, rev: VEHICLE_REV.bike + 1 } };
    const stale = importTrack(JSON.stringify(file));
    expect(stale.authorTimes).toEqual({ bike: { t: 20000, rev: VEHICLE_REV.bike + 1 } });
    expect(authorTimeFor(stale, 'bike')).toBeNull();
  });

  it('rejects foreign or malformed files', () => {
    expect(() => importTrack('not json')).toThrow(/JSON/);
    expect(() => importTrack('{"format":"something-else","blocks":[]}')).toThrow(/not a Velocity Blocks/);
    expect(() =>
      importTrack('{"format":"velocity-blocks-track","blocks":[["Q",1,1,0,0]]}'),
    ).toThrow(/Unknown block/);
    expect(() =>
      importTrack('{"format":"velocity-blocks-track","blocks":[["S",1,1,0,0],["S",1,1,0,2]]}'),
    ).toThrow(/overlap/);
    expect(() =>
      importTrack('{"format":"velocity-blocks-track","blocks":[["S",40,1,0,0]]}'),
    ).toThrow(/outside/);
  });

  it('keeps every campaign track inside the editor grid', () => {
    for (const ct of campaign()) {
      expect(() => importTrack(exportTrack(ct.data)), ct.data.name).not.toThrow();
    }
  });

  it('builds a valid layout from the text format', () => {
    const t = buildTrack('x', '@2 St Sx2 D C F');
    expect(t.blocks.length).toBe(6);
    expect(t.blocks[0].k).toBe(2);
    expect(t.blocks[5].k).toBe(1);
  });
});

describe('author-time tables', () => {
  it('serve each class from its section, and none for another physics or revision', () => {
    const t: AuthorTable = { physics: PHYSICS_VERSION, times: { A01: 1 }, bike: { rev: VEHICLE_REV.bike, times: { A01: 2 } } };
    expect(classAuthorTimes(t, 'car')).toEqual({ A01: 1 });
    expect(classAuthorTimes(t, 'bike')).toEqual({ A01: 2 });
    expect(classAuthorTimes(t, 'truck')).toBeNull();
    expect(classAuthorTimes({ ...t, bike: { rev: VEHICLE_REV.bike + 1, times: { A01: 2 } } }, 'bike')).toBeNull();
    expect(classAuthorTimes({ ...t, physics: PHYSICS_VERSION - 1 }, 'car')).toBeNull();
  });
});

describe('medals and time display', () => {
  it('derives medal thresholds from the author time', () => {
    const m = medalTimes(13980);
    expect(m).toEqual({ author: 13980, gold: 15000, silver: 17000, bronze: 21000 });
    expect(medalFor(13980, m)).toBe(4);
    expect(medalFor(14990, m)).toBe(3);
    expect(medalFor(20000, m)).toBe(1);
    expect(medalFor(30000, m)).toBe(0);
  });

  it('formats race times with hundredths', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(83450)).toBe('1:23.45');
    expect(formatTime(-320, true)).toBe('-0.32');
    expect(formatTime(1500, true)).toBe('+1.50');
  });
});
