import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { lineColors, lineJob, loadStoredLines, Phase, runJob, type RacingLineData } from '../src/game/racingLine';
import { buildRibbon, chevronMark, drawWindow, RACING_LINE_RENDER_ORDER, RacingLineView } from '../src/render/racingLine';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

// The precomputed lines load on first use (the game's bundle leaves them out): campaign line jobs need them.
await loadStoredLines();

/** A straight synthetic line along +x, gently rising, with a hidden stretch (a jump); every phase in turn. */
function synthetic(n: number, hidden: [number, number]): RacingLineData {
  const d: RacingLineData = {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    s: new Float32Array(n),
    e: new Float32Array(n),
    phase: new Uint8Array(n),
    brake: new Float32Array(n),
    visible: new Uint8Array(n),
    time: 1000,
  };
  for (let i = 0; i < n; i++) {
    d.x[i] = i;
    d.y[i] = 2 + i * 0.01;
    d.s[i] = i;
    const k = i % 40;
    d.phase[i] = k < 10 ? Phase.Brake : k < 20 ? Phase.Throttle : k < 30 ? Phase.Nitro : Phase.Lift;
    d.brake[i] = d.phase[i] === Phase.Brake ? 0.8 : 0;
    d.visible[i] = i >= hidden[0] && i <= hidden[1] ? 0 : 1;
  }
  return d;
}

describe('racing line ribbon', () => {
  const d = synthetic(300, [100, 110]);
  const r = buildRibbon(d, lineColors(d), 0.5, 0.1);

  it('has two vertices per sample, lifted above the road, and segments only where both ends show', () => {
    expect(r.position.length).toBe(300 * 2 * 3);
    let segs = 0;
    for (let i = 0; i < 299; i++) if (d.visible[i] && d.visible[i + 1]) segs++;
    expect(r.index.length).toBe(6 * segs);
    expect(r.index).toBeInstanceOf(Uint16Array);
    for (let i = 0; i < 300; i++) {
      const [lx, ly, lz, rx, ry, rz] = r.position.subarray(i * 6, i * 6 + 6);
      expect(ly).toBeCloseTo(d.y[i] + 0.1, 5);
      expect(ry).toBeCloseTo(d.y[i] + 0.1, 5);
      expect(Math.hypot(rx - lx, rz - lz)).toBeCloseTo(1, 5);
      expect(r.edge[2 * i]).toBe(-1);
      expect(r.edge[2 * i + 1]).toBe(1);
      expect(r.mark[2 * i]).toBe(chevronMark(d.phase[i]));
      expect(r.mark[2 * i + 1]).toBe(chevronMark(d.phase[i]));
      if (i) expect(r.firstIndex[i]).toBeGreaterThanOrEqual(r.firstIndex[i - 1]);
    }
    expect(r.firstIndex[299]).toBe(r.index.length);
    // No triangle touches a hidden sample.
    for (const v of r.index) expect(d.visible[v >> 1]).toBe(1);
  });

  it('handles all four phases: dark chevrons in brake zones, light ones on nitro, colours from lineColors', () => {
    expect([Phase.Throttle, Phase.Lift, Phase.Brake, Phase.Nitro].map(chevronMark)).toEqual([0, 0, 1, -1]);
    const colors = lineColors(d);
    for (const p of [Phase.Throttle, Phase.Lift, Phase.Brake, Phase.Nitro]) {
      const i = d.phase.indexOf(p);
      expect(i, `phase ${p}`).toBeGreaterThanOrEqual(0);
      // Both edge vertices carry the sample's colour as lineColors paints it.
      for (const k of [0, 3]) expect(Array.from(r.color.subarray(i * 6 + k, i * 6 + k + 3))).toEqual(Array.from(colors.subarray(i * 3, i * 3 + 3)));
    }
    // Every visible nitro run is drawn (nitro samples are on the road like any other).
    for (let i = 0; i < 299; i++) {
      if (d.phase[i] === Phase.Nitro && d.visible[i] && d.visible[i + 1]) expect(r.firstIndex[i + 1] - r.firstIndex[i]).toBe(6);
    }
    const view = new RacingLineView(d);
    const mark = view.mesh.geometry.getAttribute('aMark').array as Float32Array;
    expect(Array.from(mark)).toEqual(Array.from(r.mark));
    // Auto-accelerate repaints lifts only: nitro and brake samples keep their colours.
    const col = view.mesh.geometry.getAttribute('aCol').array as Float32Array;
    const nitroAt = d.phase.indexOf(Phase.Nitro) + 3;
    const brakeAt = d.phase.indexOf(Phase.Brake) + 3;
    const before = [nitroAt, brakeAt].map((i) => Array.from(col.subarray(i * 6, i * 6 + 3)));
    view.setLiftAsThrottle(true);
    expect([nitroAt, brakeAt].map((i) => Array.from(col.subarray(i * 6, i * 6 + 3)))).toEqual(before);
    view.dispose();
  });

  it('draws a window from just behind the car to far ahead', () => {
    const [start, count] = drawWindow(d.s, r.firstIndex, 50, 2, 100);
    expect(start).toBe(r.firstIndex[47]);
    expect(start + count).toBe(r.firstIndex[150]);
    expect(drawWindow(d.s, r.firstIndex, -50)).toEqual([0, r.firstIndex[170]]);
    const [s2, c2] = drawWindow(d.s, r.firstIndex, 290);
    expect(s2 + c2).toBe(r.index.length);
  });
});

describe('RacingLineView', () => {
  const ct = campaign()[0];
  const track = new Track(ct.data);
  const data = runJob(lineJob(`c:${ct.id}`, track))!;

  it('draws before the ghost car, smoke and photo badge, after the pads and gate light bars', () => {
    const view = new RacingLineView(data);
    const m = view.mesh;
    expect(m.renderOrder).toBe(RACING_LINE_RENDER_ORDER);
    // Pads and gate light bars: -1. Ghost car and smoke: 0. Photo badge: 1.
    expect(m.renderOrder).toBeGreaterThan(-1);
    expect(m.renderOrder).toBeLessThan(0);
    expect(m.material.transparent).toBe(true);
    expect(m.material.depthWrite).toBe(false);
    // One draw call, not a back-face and a front-face pass.
    expect(m.material.forceSinglePass).toBe(true);
    expect(m.frustumCulled).toBe(false);
    view.dispose();
  });

  it('follows the car smoothly along the line', () => {
    const scene = new THREE.Scene();
    const view = new RacingLineView(data);
    view.attach(scene);
    expect(view.mesh.parent).toBe(scene);
    const uCarS = () => view.mesh.material.uniforms.uCarS.value as number;
    let i = data.visible.indexOf(1) + 50;
    view.update({ x: data.x[i], y: data.y[i] + 0.6, z: data.z[i] });
    expect(uCarS()).toBeCloseTo(data.s[i], 3);
    expect(view.mesh.geometry.drawRange.count).toBeGreaterThan(0);
    // Halfway to the next sample: halfway along.
    view.update({ x: (data.x[i] + data.x[i + 1]) / 2, y: data.y[i] + 0.6, z: (data.z[i] + data.z[i + 1]) / 2 });
    expect(uCarS()).toBeCloseTo((data.s[i] + data.s[i + 1]) / 2, 2);
    // A teleport back to the start.
    view.resetTracking();
    i = data.visible.indexOf(1);
    view.update({ x: data.x[i], y: data.y[i] + 0.6, z: data.z[i] });
    expect(uCarS()).toBeCloseTo(data.s[i], 3);
    view.setVisible(false);
    expect(view.mesh.visible).toBe(false);
    view.dispose();
    expect(view.mesh.parent).toBeNull();
  });

  it('can paint lifts as throttle for auto-accelerate', () => {
    const view = new RacingLineView(data);
    const isLift = (i: number) => data.phase[i] === Phase.Lift;
    const lift = data.phase.findIndex((_, i) => isLift(i - 3) && isLift(i) && isLift(i + 3));
    expect(lift).toBeGreaterThan(0);
    const colors = view.mesh.geometry.getAttribute('aCol').array as Float32Array;
    const col = () => Array.from(colors.subarray(lift * 6, lift * 6 + 3));
    const before = col();
    view.setLiftAsThrottle(true);
    expect(col()).not.toEqual(before);
    expect(col()).toEqual(Array.from(lineColors(data, true).subarray(lift * 3, lift * 3 + 3)));
    view.dispose();
  });
});
