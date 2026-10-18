import { describe, expect, it } from 'vitest';
import { medalFor, medalTimes } from '../src/game/medals';
import { formatTime } from '../src/game/race';
import { buildTrack } from '../src/track/builder';
import { campaign } from '../src/track/campaign';
import { exportTrack, importTrack } from '../src/track/format';

describe('track files', () => {
  it('round-trips a campaign track through export/import', () => {
    const data = { ...campaign()[3].data, authorTime: 16470 };
    const back = importTrack(exportTrack(data));
    expect(back.blocks).toEqual(data.blocks);
    expect(back.name).toBe(data.name);
    expect(back.authorTime).toBe(16470);
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
