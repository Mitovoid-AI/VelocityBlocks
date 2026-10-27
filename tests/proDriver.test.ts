// The pro driver (src/game/proDriver.ts) and its stored laps (src/track/proLaps.json, scripts/pro-laps.ts).
import { describe, expect, it } from 'vitest';
import { PHYSICS_VERSION, VEHICLE_REV } from '../src/core/constants';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { ghostEndTick, ghostPose } from '../src/game/ghost';
import { proGhost } from '../src/game/proDriver';
import { proGhostJob, stretchGhost, type ProLapsTable } from '../src/game/proLaps';
import { runJob } from '../src/game/racingLine';
import { DEFAULT_SETTINGS, migrateSettings } from '../src/game/storage';
import { autoChase, formatDelta, GhostDelta, RouteProgress } from '../src/game/ghostDelta';
import { campaignAuthorTime, classAuthorTimes, medalTimes, type AuthorTable } from '../src/game/medals';
import authorTimes from '../src/track/authorTimes.json';
import { traceRoute } from '../src/track/route';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';
import proLaps from '../src/track/proLaps.json';

const table = proLaps as unknown as ProLapsTable;

describe('pro laps', () => {
  it('are for the current physics', () => {
    expect(table.physics).toBe(PHYSICS_VERSION);
  });

  // The game drives the stored settings again for the medal ghosts and autoplay: each must lap cleanly at
  // exactly the stored time, or the table is stale (rerun scripts/pro-laps.ts after a physics change).
  describe.each(VEHICLE_CLASSES)('%s', (cls) => {
    const sec = table.classes[cls];
    it('cover every campaign track at the class revision', () => {
      expect(sec?.rev).toBe(VEHICLE_REV[cls]);
      expect(Object.keys(sec?.laps ?? {}).sort()).toEqual(campaign().map((c) => c.id).sort());
    });
    it('replay cleanly at their stored times', () => {
      const off: string[] = [];
      for (const ct of campaign()) {
        const lap = sec?.laps[ct.id];
        if (!lap) continue;
        const g = proGhost(new Track(ct.data), cls, lap.params);
        if (g?.time !== lap.time) off.push(`${ct.id}: ${g?.time ?? 'no clean lap'} vs ${lap.time}`);
      }
      expect(off).toEqual([]);
    }, 120000);
  });

  it('the time-sliced ghost job drives the same lap as the direct one', () => {
    const ct = campaign()[0];
    const lap = table.classes.car!.laps[ct.id];
    const a = proGhost(new Track(ct.data), 'car', lap.params)!;
    const b = runJob(proGhostJob(new Track(ct.data), 'car', lap.params))!;
    expect(b.time).toBe(a.time);
    expect(Array.from(b.samples)).toEqual(Array.from(a.samples));
  });
});

describe('stretchGhost', () => {
  it('drives the same poses, finishing at the new time', () => {
    const ct = campaign()[0];
    const g = proGhost(new Track(ct.data), 'car', table.classes.car!.laps[ct.id].params)!;
    const s = stretchGhost(g, g.time * 1.5);
    expect(s.time).toBe(g.time * 1.5);
    expect(ghostEndTick(s)).toBeCloseTo(ghostEndTick(g) * 1.5, 6);
    // Halfway through the stretched run it is where the original was halfway through its own.
    const a = ghostPose(g, ghostEndTick(g) / 2)!;
    const b = ghostPose(s, ghostEndTick(s) / 2)!;
    expect(b.pos.x).toBeCloseTo(a.pos.x, 4);
    expect(b.pos.z).toBeCloseTo(a.pos.z, 4);
    expect(s.cpTimes.length).toBe(g.cpTimes.length);
  });
});

describe('author times', () => {
  it('are the pro laps, faster than the autopilot on every track', () => {
    for (const cls of VEHICLE_CLASSES) {
      for (const ct of campaign()) {
        const pro = table.classes[cls]?.laps[ct.id];
        if (!pro) continue;
        expect(campaignAuthorTime(ct.id, cls), `${cls} ${ct.id}`).toBe(pro.time);
        expect(pro.time, `${cls} ${ct.id} beats the autopilot`).toBeLessThan(classAuthorTimes(authorTimes as AuthorTable, cls)![ct.id]);
      }
    }
  });
});

describe('ghost gaps', () => {
  const ct = campaign()[0];
  const track = new Track(ct.data);
  const g = proGhost(track, 'car', table.classes.car!.laps[ct.id].params)!;
  const route = traceRoute(track);

  it('a ghost is level with itself all the way round', () => {
    const d = new GhostDelta(route, g);
    const p = new RouteProgress(route);
    for (let tick = 0; tick <= ghostEndTick(g); tick += g.interval * 5) {
      const pose = ghostPose(g, tick)!;
      const s = p.update(pose.pos.x, pose.pos.y, pose.pos.z);
      // Within a sample interval or two of its own time.
      expect(Math.abs((tick / 100) * 1000 - d.timeAt(s))).toBeLessThan(60);
    }
  });

  it('a slower copy of the ghost is behind it by the right amount at the finish', () => {
    const slow = stretchGhost(g, g.time * 1.2);
    const d = new GhostDelta(route, g);
    const end = ghostPose(slow, ghostEndTick(slow))!;
    const p = new RouteProgress(route);
    // Walk the slow ghost round so the progress follows it.
    for (let tick = 0; tick <= ghostEndTick(slow); tick += slow.interval) {
      const q = ghostPose(slow, tick)!;
      p.update(q.pos.x, q.pos.y, q.pos.z);
    }
    expect(end).not.toBeNull();
    expect(slow.time - d.timeAt(p.s)).toBeCloseTo(slow.time - g.time, -2);
  });

  it('formats gaps with a sign and hundredths', () => {
    expect(formatDelta(-420)).toBe('−0.42');
    expect(formatDelta(1234)).toBe('+1.23');
  });
});

describe('the chased ghost', () => {
  const m = medalTimes(20000);
  it('is Gold until gold is won, then the Author, then the personal best', () => {
    expect(autoChase(null, m)).toBe('gold');
    expect(autoChase(m.gold + 10, m)).toBe('gold');
    expect(autoChase(m.gold, m)).toBe('author');
    expect(autoChase(m.author, m)).toBe('pb');
    expect(autoChase(null, null)).toBe('pb');
  });
  it('setting defaults to auto and keeps a valid choice', () => {
    expect(DEFAULT_SETTINGS.chase).toBe('auto');
    expect(migrateSettings({ chase: 'gold' }).chase).toBe('gold');
    expect(migrateSettings({ chase: 'nope' }).chase).toBe('auto');
  });
});

describe('medal ghosts setting', () => {
  it('is on by default and kept when switched off', () => {
    expect(DEFAULT_SETTINGS.medalGhosts).toBe(true);
    expect(migrateSettings({}).medalGhosts).toBe(true);
    expect(migrateSettings({ medalGhosts: false }).medalGhosts).toBe(false);
  });
});
