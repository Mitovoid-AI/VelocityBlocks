// The Desert and Water sets: the text format's theme and water tokens, the campaign API the menu reads,
// water and sand in the track model and the physics (a fall into water respawns, sand is slower than
// grass, splash zones drag), the file format, and the themed surroundings, sky and water on every tier.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CELL, WATER_BED, WATER_SINK_Y } from '../src/core/constants';
import { COUNTDOWN_TICKS, RaceSession, SINK_TICKS, type RaceEvent } from '../src/game/race';
import { createCar, NO_CONTROLS, speedOf, stepCar, type Controls } from '../src/physics/vehicle';
import { QUALITY, type Quality } from '../src/render/quality';
import { applySkyPalette, SKY, skyMesh } from '../src/render/sky';
import { buildStadium, type Extents } from '../src/render/stadium';
import { STADIUM_LOOK, themeLook } from '../src/render/themes';
import { buildTrackVisual } from '../src/render/trackMesh';
import { waterMaterial } from '../src/render/water';
import { BLOCK_BY_CODE, BLOCKS } from '../src/track/blocks';
import { buildTrack, fitsGrid } from '../src/track/builder';
import {
  CAMPAIGN_DEFS,
  CAMPAIGN_SETS,
  campaign,
  campaignByDifficulty,
  campaignSet,
  campaignTrack,
} from '../src/track/campaign';
import { exportTrack, importTrack } from '../src/track/format';
import { traceRoute } from '../src/track/route';
import { SAND_GRIP, Track, type SurfaceHit } from '../src/track/track';

const GAS: Controls = { steer: 0, gas: 1, brake: 0 };

describe('text format: themes and water', () => {
  it('reads the theme and sky tokens, and leaves stadium tracks as they were', () => {
    expect(buildTrack('d', '!desert !sunset St Sx2 F')).toMatchObject({ theme: 'desert', sky: 'sunset' });
    expect(buildTrack('w', '!water St Sx2 F').theme).toBe('water');
    const plain = buildTrack('s', 'St Sx2 F');
    expect(plain).not.toHaveProperty('theme');
    expect(plain).not.toHaveProperty('sky');
    expect(() => buildTrack('x', '!jungle St F')).toThrow(/bad token/);
  });

  it('floods a ~ gap as a river across the footprint, one cell beyond it, past ground-level road cells', () => {
    const d = buildTrack('r', '!water St S J ~ ~ Sx2 F');
    const water = d.blocks.filter((b) => b.type === 'water');
    const road = d.blocks.filter((b) => b.type !== 'water');
    // A straight track one cell wide: each gap cell plus one cell either side.
    expect(water.length).toBe(6);
    expect(road.length).toBe(6);
    expect(water.every((b) => b.k === 0)).toBe(true);
    expect(fitsGrid(d)).toBe(true);
    // A limited river: ~1 floods one cell to each side only, here the same.
    expect(buildTrack('r', '!water St S J ~1 ~1 Sx2 F').blocks.length).toBe(12);
    // Under a bridge: the raised deck's own cells flood (the floor below it is free); a ground cell does not.
    const b = buildTrack('b', '!water St U ~Sx2 D F');
    const wet = new Set(b.blocks.filter((p) => p.type === 'water').map((p) => `${p.i},${p.j}`));
    const deck = b.blocks.filter((p) => p.type === 'straight');
    expect(deck.every((p) => p.k === 1 && wet.has(`${p.i},${p.j}`))).toBe(true);
    const causeway = buildTrack('c', '!water St ~S F').blocks;
    const cs = causeway.find((p) => p.type === 'straight')!;
    expect(causeway.some((p) => p.type === 'water' && p.i === cs.i && p.j === cs.j)).toBe(false);
  });

  it('turns the floor into a lagoon with !lake, keeping a cell of land beside every ground-level road', () => {
    const d = buildTrack('l', '!water !lake St T U U Sx2 C S R2 S D D Sx2 F');
    const t = new Track(d);
    expect(t.waterBlocks.length).toBeGreaterThan(10);
    for (const b of t.blocks) {
      if (b.def.water || b.p.k > 0) continue;
      for (const [i, j] of b.cells()) {
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) expect(t.waterAt((i + di + 0.5) * CELL, (j + dj + 0.5) * CELL)).toBe(false);
        }
      }
    }
  });

  it('has a splash zone (W) and a water block (~) in the block catalogue, for the editor palette too', () => {
    expect(BLOCK_BY_CODE.W).toBe(BLOCKS.splash);
    expect(BLOCK_BY_CODE['~']).toBe(BLOCKS.water);
    expect(BLOCKS.splash.splash).toBe(true);
    expect(BLOCKS.water.water).toBe(true);
    expect(buildTrack('s', 'St W F').blocks.map((b) => b.type)).toEqual(['start', 'splash', 'finish']);
  });
});

describe('campaign sets', () => {
  const all = campaign();

  it('keeps the Stadium set first and as it was', () => {
    expect(all.slice(0, 12).map((c) => c.id)).toEqual(['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12']);
    for (const c of all.slice(0, 12)) {
      expect(c.set).toBe('Stadium');
      expect(c.theme).toBe('stadium');
      expect(c.data).not.toHaveProperty('theme');
      expect(c.data.blocks.some((b) => b.type === 'water' || b.type === 'splash')).toBe(false);
    }
  });

  it('has six Desert and six Water tracks, each set easiest first, with names, themes and difficulty', () => {
    for (const { set, theme, prefix } of CAMPAIGN_SETS) {
      const list = campaignSet(set);
      expect(list.length, set).toBeGreaterThanOrEqual(6);
      list.forEach((c, n) => {
        expect(c.id.startsWith(prefix)).toBe(true);
        expect(c.theme).toBe(theme);
        expect(c.setIndex).toBe(n + 1);
        expect(c.name.length).toBeGreaterThan(2);
        expect(c.data.name).toBe(`${c.id} ${c.name}`);
        if (n) expect(c.difficulty).toBeGreaterThan(list[n - 1].difficulty);
      });
    }
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(campaignTrack('D03')?.name).toBe('Mesa Loop');
    expect(campaignTrack('Z99')).toBeUndefined();
  });

  it('places the new tracks between the Stadium steps on one difficulty scale', () => {
    const order = campaignByDifficulty().map((c) => c.id);
    expect(order.slice(0, 6)).toEqual(['A01', 'D01', 'A02', 'W01', 'A03', 'D02']);
    expect(order[order.length - 1]).toBe('W06');
    // Every gap between two Stadium tracks holds exactly one new track.
    for (let n = 1; n < 12; n++) {
      const a = order.indexOf(`A${String(n).padStart(2, '0')}`);
      const b = order.indexOf(`A${String(n + 1).padStart(2, '0')}`);
      expect(b - a, `between A${n} and A${n + 1}`).toBe(2);
    }
  });

  it('gives the Desert set sunsets and the Water set real water on every track', () => {
    expect(campaignSet('Desert').filter((c) => c.data.sky === 'sunset').length).toBeGreaterThanOrEqual(2);
    for (const c of campaignSet('Water')) expect(new Track(c.data).hasWater, c.id).toBe(true);
    // Splash zones on the road in the Water set.
    expect(campaignSet('Water').filter((c) => c.data.blocks.some((b) => b.type === 'splash')).length).toBeGreaterThanOrEqual(4);
  });

  it('routes never run through water, and every water track crosses some (a bridge or a jump)', () => {
    for (const [id, , name, code] of CAMPAIGN_DEFS) {
      const t = new Track(buildTrack(`${id} ${name}`, code));
      const route = traceRoute(t);
      expect(route.blocks.some((b) => b.def.water), id).toBe(false);
      if (t.hasWater) expect(route.points.some((p) => t.waterAt(p.x, p.z)), id).toBe(true);
    }
  });
});

describe('track model: sand and water', () => {
  it('has sand off the road in the desert, grass elsewhere, and road surfaces unchanged', () => {
    const desert = new Track(buildTrack('d', '!desert St Sx3 F'));
    const stadium = new Track(buildTrack('s', 'St Sx3 F'));
    const off = desert.surfaceAt(-200, 1, -200);
    expect(off).toMatchObject({ y: 0, road: false, surf: 'sand', grip: SAND_GRIP });
    expect(stadium.surfaceAt(-200, 1, -200)).toEqual({ y: 0, nx: 0, ny: 1, nz: 0, grip: 0.55, road: false, block: null });
    const s = desert.blocks[1].centerWorld(16);
    expect(desert.surfaceAt(s.x, 1, s.z)).toMatchObject({ road: true, grip: 1 });
  });

  it('has no ground in a water cell: the bed lies far below, and the cell is not part of the road', () => {
    const t = new Track(buildTrack('w', '!water St S J ~ ~ Sx2 F'));
    const w = t.waterBlocks[0];
    const x = (w.p.i + 0.5) * CELL, z = (w.p.j + 0.5) * CELL;
    expect(t.waterAt(x, z)).toBe(true);
    expect(t.surfaceAt(x, 1, z)).toMatchObject({ y: WATER_BED, road: false, surf: 'water' });
    expect(t.blocksAt(x, z)).toBeUndefined();
    expect(t.wallAt(x, 0.5, z)).toBeNull();
  });

  it('gives a splash zone less grip than the road', () => {
    const t = new Track(buildTrack('s', 'St W F'));
    const c = t.blocks[1].centerWorld(16);
    const hit = t.surfaceAt(c.x, 1, c.z);
    expect(hit.surf).toBe('splash');
    expect(hit.road).toBe(true);
    expect(hit.grip).toBeLessThan(1);
  });
});

/** An endless flat surface of one kind at y = 0. */
function plane(hit: Partial<SurfaceHit>): Track {
  return {
    surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null, ...hit }),
    wallAt: () => null,
    sideAt: () => null,
    columnsNear: () => null,
    spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
  } as unknown as Track;
}

/** Speed (m/s) after `ticks` of full throttle from rest. */
function topSpeed(track: Track, ticks = 2000): number {
  const c = createCar(track);
  for (let n = 0; n < ticks; n++) stepCar(c, GAS, track);
  return speedOf(c);
}

describe('physics: surfaces', () => {
  it('is slower on sand than on grass, and both far slower than the road', () => {
    const road = topSpeed(plane({}));
    const grass = topSpeed(plane({ grip: 0.55, road: false }));
    const sand = topSpeed(plane({ grip: SAND_GRIP, road: false, surf: 'sand' }));
    expect(grass).toBeLessThan(road * 0.5);
    expect(sand).toBeLessThan(grass - 2);
    expect(sand * 3.6).toBeGreaterThan(60);
  });

  it('drags the car back in a splash zone', () => {
    const fast = createCar(plane({}));
    const wet = createCar(plane({ grip: 0.85, surf: 'splash' }));
    for (const c of [fast, wet]) c.vel = { x: 0, y: 0, z: 60 };
    for (let n = 0; n < 50; n++) {
      stepCar(fast, GAS, plane({}));
      stepCar(wet, GAS, plane({ grip: 0.85, surf: 'splash' }));
    }
    expect(speedOf(fast) - speedOf(wet)).toBeGreaterThan(2);
  });
});

describe('race: falling into water', () => {
  const track = new Track(buildTrack('w', '!water St S C S J ~ ~ Sx2 F'));

  function racing(): RaceSession {
    const r = new RaceSession(track);
    for (let n = 0; n < COUNTDOWN_TICKS; n++) r.step(NO_CONTROLS);
    return r;
  }

  /** Puts the car over the middle of the river, at rest, a little above the surface. */
  function drop(r: RaceSession): void {
    const w = track.waterBlocks[Math.floor(track.waterBlocks.length / 2)];
    r.car.pos = { x: (w.p.i + 0.5) * CELL, y: 1.5, z: (w.p.j + 0.5) * CELL };
    r.car.vel = { x: 0, y: 0, z: 0 };
  }

  it('splashes, then respawns at the last checkpoint SINK_TICKS later, with the clock running', () => {
    const r = racing();
    for (let n = 0; n < 2000 && r.taken.size === 0; n++) r.step(GAS);
    expect(r.taken.size).toBe(1);
    const cp = track.gates.find((g) => g.kind === 'checkpoint')!.block;
    drop(r);
    const events: [number, RaceEvent][] = [];
    for (let n = 0; n < 400 && !events.some(([, e]) => e.type === 'respawn'); n++) for (const e of r.step(NO_CONTROLS)) events.push([r.ticks, e]);
    const splash = events.find(([, e]) => e.type === 'splash');
    const respawn = events.find(([, e]) => e.type === 'respawn');
    expect(splash).toBeDefined();
    expect(respawn?.[1]).toEqual({ type: 'respawn', auto: true, water: true });
    expect(respawn![0] - splash![0]).toBe(SINK_TICKS - 1);
    expect(r.phase).toBe('racing');
    expect(r.respawns).toBe(1);
    // Back on the checkpoint's deck, upright and dry.
    const l = cp.toLocal(r.car.pos.x, r.car.pos.z);
    expect(Math.abs(l.a)).toBeLessThan(11);
    expect(r.car.pos.y).toBeGreaterThan(0);
    expect(track.waterAt(r.car.pos.x, r.car.pos.z)).toBe(false);
    expect(r.sinkTicks).toBe(0);
  });

  it('restarts the run when no checkpoint was taken', () => {
    const r = racing();
    drop(r);
    let restart = false;
    for (let n = 0; n < 400 && !restart; n++) restart = r.step(NO_CONTROLS).some((e) => e.type === 'respawn');
    expect(restart).toBe(true);
    expect(r.phase).toBe('countdown');
  });

  it('never triggers over dry ground or high over the water', () => {
    const r = racing();
    const w = track.waterBlocks[0];
    r.car.pos = { x: (w.p.i + 0.5) * CELL, y: 20, z: (w.p.j + 0.5) * CELL };
    r.car.vel = { x: 0, y: 0, z: 0 };
    // Well above WATER_SINK_Y for the first ticks of the fall.
    for (let n = 0; n < 20; n++) expect(r.step(NO_CONTROLS).some((e) => e.type === 'splash')).toBe(false);
    expect(r.car.pos.y).toBeGreaterThan(WATER_SINK_Y);
  });
});

describe('file format: themes and water', () => {
  it('keeps the theme, the sky and the water through export and import', () => {
    for (const c of campaign().filter((c) => c.set !== 'Stadium')) {
      const back = importTrack(exportTrack(c.data));
      expect(back.theme, c.id).toBe(c.data.theme);
      expect(back.sky, c.id).toBe(c.data.sky);
      expect(back.blocks, c.id).toEqual(c.data.blocks);
    }
    expect(JSON.parse(exportTrack(campaign()[0].data))).not.toHaveProperty('theme');
    expect(importTrack(JSON.stringify({ format: 'velocity-blocks-track', blocks: [], theme: 'moon' }))).not.toHaveProperty('theme');
  });
});

describe('themed surroundings', () => {
  const B: Extents = { x0: -64, z0: -64, x1: 352, z1: 576 };
  const draws = (root: THREE.Object3D) => {
    const out: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) out.push(o);
    });
    return out;
  };

  describe.each(['low', 'medium', 'high'] as Quality[])('%s', (q) => {
    it.each([
      ['desert', 'day'],
      ['desert', 'sunset'],
      ['water', 'day'],
      ['stadium', 'sunset'],
    ] as const)('%s at %s stays within a dozen draw calls and the tier budget', (theme, sky) => {
      const s = buildStadium(B, QUALITY[q], theme, sky);
      const all = draws(s.group);
      expect(all.length).toBeLessThanOrEqual(12);
      // Only the Stadium has stands: the open arenas have no crowd, roof or floodlights.
      const names = all.map((o) => o.name);
      if (theme !== 'stadium') expect(names.some((n) => /crowd|roof|lamp|halos/.test(n))).toBe(false);
      let inst = 0;
      for (const o of all) if (o instanceof THREE.InstancedMesh) inst += o.count;
      expect(inst).toBeLessThanOrEqual(QUALITY[q].trees + 20);
      if (theme === 'water') expect(names).toContain('sea');
      if (theme === 'desert') expect(names).toContain('mesas');
      s.dispose();
    });
  });

  it('keeps the Stadium by day the original look', () => {
    expect(themeLook()).toBe(STADIUM_LOOK);
    expect(themeLook('stadium', 'day').sky).toBe(SKY);
    expect(themeLook('desert', 'sunset').sky.glowDrop).toBeGreaterThan(0.5);
    const sky = skyMesh();
    applySkyPalette(sky, themeLook('desert', 'sunset').sky);
    const u = (sky.material as THREE.ShaderMaterial).uniforms;
    expect(u.horizon.value).toBe(themeLook('desert', 'sunset').sky.horizon);
    expect((u.sunDir.value as THREE.Vector3).y).toBeLessThan(0.3);
  });

  it('uses the cheap water shader on Low, and draws lakes, shores and splash zones in two draw calls', () => {
    expect(waterMaterial(STADIUM_LOOK, { cheap: true }).defines).not.toHaveProperty('WATER_HQ');
    expect(waterMaterial(STADIUM_LOOK).defines).toHaveProperty('WATER_HQ');
    const see = waterMaterial(STADIUM_LOOK, { opacity: 0.7 });
    expect(see.transparent).toBe(true);
    expect(see.depthWrite).toBe(false);
    const t = new Track(campaignTrack('W02')!.data);
    const v = buildTrackVisual(t, { cheap: true });
    const names: string[] = [];
    v.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) names.push(o.name);
    });
    expect(names.filter((n) => n === 'water' || n === 'splash').sort()).toEqual(['splash', 'water']);
    // The splash effect waits hidden until a car drops in.
    expect(v.splash).toBeTypeOf('function');
    v.splash!(0, 0);
    v.update(0.1);
    const fx = v.group.getObjectByName('splash-fx')!;
    expect(fx.visible).toBe(true);
    v.update(2);
    expect(fx.visible).toBe(false);
    v.dispose();
  });
});
