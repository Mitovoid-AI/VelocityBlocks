// Track meshes for every campaign track: draw-call budget, vertex colours, kerbs, pillars that match
// the physics columns, and the render order the racing line relies on. Textures are 1x1
// placeholders under node (texUtil), so this checks geometry and materials only.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildTrackVisual, pillarGeometry, samplesFor } from '../src/render/trackMesh';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

const TRACKS = campaign().map((c) => ({ id: c.data.name, track: new Track(c.data) }));

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

const mat = (m: THREE.Mesh) => m.material as THREE.MeshBasicMaterial;

describe.each(TRACKS)('$id visuals', ({ track }) => {
  const v = buildTrackVisual(track);
  const ms = meshes(v.group);
  const named = (n: string) => ms.find((m) => m.name === n);

  it('stays within the draw-call budget (gates merged per material)', () => {
    expect(ms.length).toBeLessThanOrEqual(16);
    expect(ms.filter((m) => m.name.startsWith('gate-')).length).toBeLessThanOrEqual(7);
  });

  it('has finite positions and grey shades in 0..1', () => {
    for (const m of ms) {
      const pos = m.geometry.attributes.position.array;
      expect(Array.from(pos).every(Number.isFinite), m.name).toBe(true);
      const col = m.geometry.attributes.color;
      if (!col) continue;
      const c = Array.from(col.array);
      expect(c.reduce((a, b) => Math.min(a, b)), m.name).toBeGreaterThanOrEqual(0);
      expect(c.reduce((a, b) => Math.max(a, b)), m.name).toBeLessThanOrEqual(1);
    }
  });

  it('gives every vertex-coloured material a colour attribute (no black pillars or walls)', () => {
    for (const m of ms) if (mat(m).vertexColors) expect(m.geometry.attributes.color, m.name).toBeDefined();
    for (const n of ['deck', 'kerb', 'skirt', 'barrier', 'pillars']) {
      const m = named(n);
      if (m) expect(mat(m).vertexColors, n).toBe(true);
    }
  });

  it('draws the deck as four columns per row and kerbs on both sides', () => {
    const rows = track.blocks.reduce((n, b) => n + samplesFor(b), 0);
    expect(named('deck')!.geometry.attributes.position.count).toBe(rows * 4);
    expect(named('kerb')!.geometry.attributes.position.count).toBe(rows * 5 * 2);
  });

  it('draws pads and gate light bars before the racing line, at their true colours', () => {
    for (const m of ms) {
      if (m.name === 'boost' || m.name === 'turbo' || m.name === 'gate-line') {
        expect(m.renderOrder, m.name).toBe(-1);
        expect(mat(m).toneMapped, m.name).toBe(false);
      }
      if (m.name.startsWith('gate-banner')) expect(mat(m).toneMapped).toBe(false);
    }
    expect(named('gate-line')).toBeDefined();
  });

  it('disposes cleanly', () => {
    expect(() => v.dispose()).not.toThrow();
  });
});

describe('pillars', () => {
  const columns = TRACKS.flatMap(({ track }) => track.columns.filter((c) => c.kind === 'pillar'));

  it('exist on the campaign', () => {
    expect(columns.length).toBeGreaterThan(10);
  });

  it('keep the physics column footprint and height, darker at the foot', () => {
    for (const c of columns) {
      const g = pillarGeometry(c);
      expect(g.index).toBeNull();
      g.computeBoundingBox();
      expect(g.boundingBox!.min.y).toBeCloseTo(c.y0, 4);
      expect(g.boundingBox!.max.y).toBeCloseTo(c.y1, 4);
      const pos = g.attributes.position;
      const col = g.attributes.color;
      const capH = Math.min(0.4, (c.y1 - c.y0) * 0.25);
      // Float32 positions: allow a hair of rounding.
      let reach = 0;
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < c.y1 - capH - 1e-3) {
          reach = Math.max(reach, Math.abs(pos.getX(i) - c.x), Math.abs(pos.getZ(i) - c.z));
        }
        lo = Math.min(lo, col.getX(i));
        hi = Math.max(hi, col.getX(i));
      }
      expect(reach).toBeCloseTo(0.8, 4);
      expect(lo).toBeGreaterThanOrEqual(0.7 - 1e-6);
      expect(hi).toBeLessThanOrEqual(1);
      g.dispose();
    }
  });
});

describe('editor previews', () => {
  it('a ghost preview uses one plain material, no vertex colours, no gates or shadows', () => {
    const { track } = TRACKS[5];
    const v = buildTrackVisual(track, { ghostColor: 0x66ccff, light: true });
    const ms = meshes(v.group);
    expect(ms.length).toBeGreaterThan(0);
    const m0 = ms[0].material;
    for (const m of ms) {
      expect(m.material).toBe(m0);
      expect(mat(m).vertexColors).toBe(false);
      expect(m.castShadow).toBe(false);
      expect(m.name.startsWith('gate-')).toBe(false);
    }
    v.dispose();
  });
});

describe('Low tier road surfaces', () => {
  it('draw the road, kerbs, skirts, banks and barriers with Lambert, same maps and vertex colours', () => {
    const { track } = TRACKS[TRACKS.length - 1];
    const full = meshes(buildTrackVisual(track).group);
    const cheap = meshes(buildTrackVisual(track, { cheap: true }).group);
    expect(cheap.map((m) => m.name)).toEqual(full.map((m) => m.name));
    for (const name of ['deck', 'kerb', 'skirt', 'bank', 'barrier']) {
      const a = full.find((m) => m.name === name);
      const b = cheap.find((m) => m.name === name);
      if (!a || !b) continue;
      expect(a.material, name).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(b.material, name).toBeInstanceOf(THREE.MeshLambertMaterial);
      const bm = b.material as THREE.MeshLambertMaterial;
      expect(bm.map, name).toBe((a.material as THREE.MeshStandardMaterial).map);
      expect(bm.vertexColors, name).toBe(true);
    }
    expect(cheap.find((m) => m.name === 'deck')).toBeDefined();
  });
});
