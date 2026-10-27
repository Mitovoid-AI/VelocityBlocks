// Shared runs (src/game/runShare.ts): links and .vbst files drive the same lap back, and are checked on arrival.
import { describe, expect, it } from 'vitest';
import { proGhost } from '../src/game/proDriver';
import { proLapFor } from '../src/game/proLaps';
import { MAX_RUNS, RunLibrary, RUNS_KEY, storedRun } from '../src/game/runLibrary';
import { APP_LINK_BASE, driveRun, parseRun, RUN_FILE_FORMAT, RUN_LINK_BASE, runFile, runFileName, runLink, runOf, type RunFile } from '../src/game/runShare';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

const ct = campaign()[0];
const ghost = proGhost(new Track(ct.data), 'car', proLapFor(`c:${ct.id}`, 'car')!.params)!;
const entry = { base: `c:${ct.id}`, label: ct.data.name, data: ct.data, vehicle: 'car' as const, walls: false };
const run = runOf(entry, ghost, 'Shaurya')!;

describe('shared runs', () => {
  it('a finished lap keeps its inputs, so it can be shared', () => {
    expect(ghost.inputs?.length).toBeGreaterThan(0);
    expect(run.time).toBe(ghost.time);
  });

  it('a link opens to the same run, which drives to the same time (verified)', async () => {
    const back = await parseRun(await runLink(run));
    expect(back).toEqual(run);
    const d = driveRun(back!)!;
    expect(d.verified).toBe(true);
    expect(d.ghost.time).toBe(run.time);
  });

  it('a run whose time was edited is not verified', () => {
    expect(driveRun({ ...run, time: run.time - 500 })?.verified).toBe(false);
  });
});

describe('.vbst run files', () => {
  const text = runFile(run, '1.3.0', new Date('2026-10-27T12:00:00Z'));
  const file = JSON.parse(text) as RunFile;

  it('say what they are: track, driver, time, vehicle, verified, game, date', () => {
    expect(file.format).toBe(RUN_FILE_FORMAT);
    expect(file.track).toBe('A01 Warm-Up');
    expect(file.driver).toBe('Shaurya');
    expect(file.timeMs).toBe(run.time);
    expect(file.time).toMatch(/^\d:\d\d\.\d\d$/);
    expect(file.vehicle).toBe('car');
    expect(file.verified).toBe(true);
    expect(file.game).toBe('Velocity Blocks 1.3.0');
    expect(file.savedAt).toBe('2026-10-27T12:00:00.000Z');
  });

  it('open to the same run', async () => {
    expect(await parseRun(text)).toEqual(run);
  });

  it('are named after the track, driver and time', () => {
    expect(runFileName(run)).toMatch(/^VelocityBlocks-A01-Warm-Up-Shaurya-0-\d\d-\d\d\.vbst$/);
  });

  it('a file claiming "verified" is checked again on opening: an edited time does not verify', async () => {
    const forged = JSON.stringify({ ...file, verified: true, run: { ...file.run, time: file.run.time - 1000 } });
    const back = await parseRun(forged);
    expect(back).not.toBeNull();
    expect(driveRun(back!)?.verified).toBe(false);
  });

  it('other JSON, or a broken file, is not a run', async () => {
    expect(await parseRun('{"format":"something-else","run":{}}')).toBeNull();
    expect(await parseRun('{ not json')).toBeNull();
    expect(await parseRun(JSON.stringify({ ...file, run: { ...file.run, vehicle: 'boat' } }))).toBeNull();
  });
});

describe('Runs (the kept runs)', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('keeps an opened run once, newest first, and deletes it', () => {
    const lib = new RunLibrary(memory());
    expect(lib.add(run, true, 1000)).toBe(true);
    expect(lib.add({ ...run, driver: 'Naman' }, false, 2000)).toBe(true);
    expect(lib.add(run, true, 3000)).toBe(true);
    const list = lib.list();
    expect(list.map((r) => r.driver)).toEqual(['Shaurya', 'Naman']);
    expect(list[0]).toMatchObject({ track: 'A01 Warm-Up', time: run.time, vehicle: 'car', verified: true, addedAt: 3000 });
    lib.remove(list[1].id);
    expect(lib.list().map((r) => r.driver)).toEqual(['Shaurya']);
  });

  it(`keeps at most ${MAX_RUNS}`, () => {
    const lib = new RunLibrary(memory());
    for (let i = 0; i < MAX_RUNS + 5; i++) lib.add({ ...run, driver: `d${i}` }, true, i);
    expect(lib.list()).toHaveLength(MAX_RUNS);
    expect(lib.list()[0].driver).toBe(`d${MAX_RUNS + 4}`);
  });

  it('a kept run reads back as the same run', async () => {
    const lib = new RunLibrary(memory());
    lib.add(run, true);
    expect(await storedRun(lib.list()[0])).toEqual(run);
  });

  it('broken or missing storage is an empty list, not an error', () => {
    expect(new RunLibrary(null).list()).toEqual([]);
    expect(new RunLibrary(null).add(run, true)).toBe(false);
    const bad = memory();
    bad.setItem(RUNS_KEY, '{oops');
    expect(new RunLibrary(bad).list()).toEqual([]);
  });

  it('the app link carries the same run (velocityblocks://)', async () => {
    const appLink = (await runLink(run)).replace(RUN_LINK_BASE, APP_LINK_BASE);
    expect(appLink.startsWith('velocityblocks://run#run=')).toBe(true);
    expect(await parseRun(appLink)).toEqual(run);
  });
});
