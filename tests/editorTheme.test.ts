// The editor's Theme picker (Stadium / Desert / Water by day or at sunset, saved in TrackData), water that
// lies on the floor only (a water block above level 0 used to flood the floor cell under it), and the
// splash sound of a fall into water.

import { describe, expect, it, vi } from 'vitest';
import { lookValue, themeOptionsHtml, withLook } from '../src/app/editorMode';
import { RaceMode } from '../src/app/raceMode';
import { layoutHash } from '../src/game/storage';
import { exportTrack, importTrack } from '../src/track/format';
import { Track, type TrackData } from '../src/track/track';
import { CELL } from '../src/core/constants';

const base = (over: Partial<TrackData> = {}): TrackData => ({
  name: 'Mine',
  author: 'Tester',
  blocks: [
    { type: 'start', i: 5, j: 5, k: 0, dir: 0 },
    { type: 'straight', i: 5, j: 6, k: 0, dir: 0 },
  ],
  ...over,
});

describe('editor: Theme picker', () => {
  it('offers every theme by day and at sunset, with the track’s own selected', () => {
    const html = themeOptionsHtml(base({ theme: 'desert', sky: 'sunset' }));
    expect(html.match(/<option/g)).toHaveLength(6);
    expect(html).toContain('<option value="desert-sunset" selected>');
    expect(themeOptionsHtml(base())).toContain('<option value="stadium-day" selected>');
    expect(lookValue(base({ theme: 'water' }))).toBe('water-day');
  });

  it('saves the theme and sky into TrackData (none for the Stadium by day) and through the file format', () => {
    const d = withLook(base(), 'water', 'sunset');
    expect(d).toMatchObject({ theme: 'water', sky: 'sunset' });
    const back = importTrack(exportTrack(d));
    expect(back.theme).toBe('water');
    expect(back.sky).toBe('sunset');
    const plain = withLook(d, 'stadium', 'day');
    expect('theme' in plain || 'sky' in plain).toBe(false);
    // Unknown values fall back to the Stadium by day.
    expect(lookValue(withLook(base(), 'moon', 'night'))).toBe('stadium-day');
  });

  it('clears the author times only when the ground beside the road changes (to or from the desert sand)', () => {
    const timed = base({ authorTime: 20000, authorTimes: { bike: { t: 22000, rev: 1 } } });
    expect(withLook(timed, 'water', 'sunset').authorTime).toBe(20000);
    expect(withLook(timed, 'stadium', 'sunset').authorTimes).toBeDefined();
    const sand = withLook(timed, 'desert', 'day');
    expect(sand.authorTime).toBeUndefined();
    expect(sand.authorTimes).toBeUndefined();
    expect(withLook({ ...sand, authorTime: 21000 }, 'desert', 'sunset').authorTime).toBe(21000);
    expect(withLook({ ...sand, authorTime: 21000 }, 'stadium', 'day').authorTime).toBeUndefined();
  });

  it('keeps records apart for a desert track (its sand drives differently), and keys the others as before', () => {
    const plain = layoutHash(base());
    expect(layoutHash(base({ theme: 'water', sky: 'sunset' }))).toBe(plain);
    expect(layoutHash(base({ sky: 'sunset' }))).toBe(plain);
    expect(layoutHash(base({ theme: 'desert' }))).not.toBe(plain);
  });
});

describe('water lies on the floor only', () => {
  it('a water block above level 0 floods nothing (and is no road)', () => {
    const high = new Track(base({ theme: 'water', blocks: [...base().blocks, { type: 'water', i: 8, j: 8, k: 1, dir: 0 }] }));
    expect(high.hasWater).toBe(false);
    expect(high.waterAt(8.5 * CELL, 8.5 * CELL)).toBe(false);
    expect(high.waterBlocks).toHaveLength(0);
    expect(high.surfaceAt(8.5 * CELL, 20, 8.5 * CELL, 1).road).toBe(false);
    const floor = new Track(base({ theme: 'water', blocks: [...base().blocks, { type: 'water', i: 8, j: 8, k: 0, dir: 0 }] }));
    expect(floor.hasWater).toBe(true);
    expect(floor.waterAt(8.5 * CELL, 8.5 * CELL)).toBe(true);
  });
});

describe('race: a fall into water', () => {
  it('plays the splash sound and shakes the camera', () => {
    const audio = { splash: vi.fn() };
    const rig = { shake: 0 };
    const self = { app: { hud: {}, audio, rig } };
    (RaceMode.prototype as unknown as { handle(this: unknown, ev: unknown[]): void }).handle.call(self, [{ type: 'splash', x: 1, y: 0, z: 2 }]);
    expect(audio.splash).toHaveBeenCalledTimes(1);
    expect(rig.shake).toBeGreaterThan(0);
  });
});
