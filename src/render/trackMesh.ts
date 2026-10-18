// Builds the visual meshes for a track from the same block definitions the physics uses.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DECK_EDGE, DECK_T, WALL_H, WALL_OFF } from '../core/constants';
import { centerAt } from '../track/blocks';
import { barrierRange, type PlacedBlock, type Track } from '../track/track';
import { bannerTexture, barrierTexture, concreteTexture, padTexture, roadTexture } from './textures';

class Strip {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  /** Add a grid of rows x cols vertices; `at(r, c)` returns [x, y, z, u, v]. */
  grid(rows: number, cols: number, at: (r: number, c: number) => number[], flip = false): void {
    const base = this.pos.length / 3;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const p = at(r, c);
        this.pos.push(p[0], p[1], p[2]);
        this.uv.push(p[3], p[4]);
      }
    for (let r = 0; r < rows - 1; r++)
      for (let c = 0; c < cols - 1; c++) {
        const a = base + r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        if (flip) this.idx.push(a, d, b, b, d, e);
        else this.idx.push(a, b, d, b, e, d);
      }
  }

  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export interface TrackVisual {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
}

export interface VisualOptions {
  /** Single colour override (editor previews). */
  ghostColor?: number;
  /** Skip pillars and banners (cheap previews). */
  light?: boolean;
}

function samplesFor(blk: PlacedBlock): number {
  if (blk.def.path === 'arc') return blk.def.radius > 20 ? 28 : 16;
  return blk.def.height(blk.def.length) !== 0 || blk.def.type === 'ramp' ? 20 : 2;
}

/** World point at distance s along the block, lateral d, height offset y. */
function at(blk: PlacedBlock, s: number, d: number, yoff: number): [number, number, number] {
  const c = centerAt(blk.def, s);
  const ra = c.tb;
  const rb = -c.ta;
  const w = blk.toWorld(c.a + ra * d, c.b + rb * d);
  return [w.x, blk.baseY + blk.def.height(s) + yoff, w.z];
}

export function buildTrackVisual(track: Track, opts: VisualOptions = {}): TrackVisual {
  const group = new THREE.Group();
  const deck = new Strip();
  const skirt = new Strip();
  const barrier = new Strip();
  const pads = { boost: new Strip(), turbo: new Strip() };
  const pillarGeos: THREE.BufferGeometry[] = [];

  for (const blk of track.blocks) {
    const L = blk.def.length;
    const n = samplesFor(blk);
    const S = (r: number) => (L * r) / (n - 1);
    const rows = n;
    const edge = DECK_EDGE;
    // Embankments (slopes and ramps rising from the floor) are solid down to the ground.
    const floorOff = (s: number) => -(blk.baseY + blk.def.height(s)) - 0.05;

    // Deck top (u across, v along; one texture tile per 16 m).
    deck.grid(rows, 2, (r, c) => {
      const d = c === 0 ? -edge : edge;
      const p = at(blk, S(r), d, 0.03);
      return [...p, c === 0 ? -0.025 : 1.025, S(r) / 16];
    });

    // Deck sides and underside (embankments: sides down to the floor, no underside).
    for (const side of [-1, 1]) {
      skirt.grid(
        rows,
        2,
        (r, c) => {
          if (!blk.embank) {
            const p = at(blk, S(r), side * edge, c === 0 ? 0.03 : -DECK_T);
            return [...p, S(r) / 8, c];
          }
          const yoff = c === 0 ? 0.03 : floorOff(S(r));
          const p = at(blk, S(r), side * edge, yoff);
          return [...p, S(r) / 8, c === 0 ? 0 : -yoff / 4];
        },
        side < 0,
      );
    }
    if (!blk.embank) {
      skirt.grid(rows, 2, (r, c) => {
        const p = at(blk, S(r), c === 0 ? -edge : edge, -DECK_T);
        return [...p, c, S(r) / 8];
      }, true);
    } else {
      // High-end face (ramp lip, or the wall under the following bridge); both windings so it always shows.
      const hs = blk.highEndS;
      const bottom = floorOff(hs);
      for (const flip of [false, true]) {
        skirt.grid(2, 2, (r, c) => {
          const yoff = r === 0 ? 0.03 : bottom;
          const p = at(blk, hs, c === 0 ? -edge : edge, yoff);
          return [...p, c * edge / 4, r === 0 ? 0 : -yoff / 4];
        }, flip);
      }
    }

    // Barriers: inner face, top, outer face on each side, only where the deck is high enough to fall from.
    const br = barrierRange(blk);
    if (br) {
      const [s0, s1] = br;
      const nb = Math.max(2, Math.ceil(((n - 1) * (s1 - s0)) / L) + 1);
      const SB = (r: number) => s0 + ((s1 - s0) * r) / (nb - 1);
      for (const side of [-1, 1]) {
        const flip = side < 0;
        barrier.grid(nb, 2, (r, c) => {
          const p = at(blk, SB(r), side * WALL_OFF, c === 0 ? 0 : WALL_H);
          return [...p, SB(r) / 8, c];
        }, flip);
        barrier.grid(nb, 2, (r, c) => {
          const p = at(blk, SB(r), side * (c === 0 ? WALL_OFF : edge), WALL_H);
          return [...p, SB(r) / 8, 0.98];
        }, flip);
        barrier.grid(nb, 2, (r, c) => {
          const p = at(blk, SB(r), side * edge, c === 0 ? 0 : WALL_H);
          return [...p, SB(r) / 8, c];
        }, !flip);
        // End caps, so a barrier that starts or stops mid-block reads as solid.
        for (const s of [s0, s1]) {
          for (const capFlip of [false, true]) {
            barrier.grid(2, 2, (r, c) => {
              const p = at(blk, s, side * (c === 0 ? WALL_OFF : edge), r === 0 ? 0 : WALL_H);
              return [...p, c * 0.06, r];
            }, capFlip);
          }
        }
      }
    }

    // Boost / turbo pads.
    if (blk.def.pad) {
      const strip = pads[blk.def.pad];
      strip.grid(2, 2, (r, c) => {
        const s = r === 0 ? 4 : 28;
        const p = at(blk, s, c === 0 ? -7.5 : 7.5, 0.06);
        return [...p, c, s / 12];
      });
    }

    // Start back wall.
    if (blk.def.gate === 'start') {
      const wall = new THREE.BoxGeometry(edge * 2, WALL_H, 0.6);
      const p = at(blk, 0, 0, WALL_H / 2);
      wall.rotateY(Math.atan2(blk.fx, blk.fz));
      wall.translate(p[0] - blk.fx * 0.3, p[1], p[2] - blk.fz * 0.3);
      pillarGeos.push(wall);
    }

    // Gates.
    if (blk.def.gate && !opts.light) group.add(buildGate(blk, blk.def.gate));
  }

  // Pillars under elevated decks: the same solid columns the physics collides with.
  if (!opts.light) {
    for (const c of track.columns) {
      if (c.kind !== 'pillar') continue;
      const g = new THREE.BoxGeometry(1.6, c.y1, 1.6);
      g.translate(c.x, c.y1 / 2, c.z);
      pillarGeos.push(g);
    }
  }

  const ghost = opts.ghostColor !== undefined;
  const ghostMat = ghost
    ? new THREE.MeshBasicMaterial({ color: opts.ghostColor, transparent: true, opacity: 0.45, depthWrite: false })
    : null;

  const mats = {
    deck: ghostMat ?? new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.82, metalness: 0.0 }),
    skirt: ghostMat ?? new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95 }),
    barrier: ghostMat ?? new THREE.MeshStandardMaterial({ map: barrierTexture(), roughness: 0.6 }),
    boost: ghostMat ?? new THREE.MeshBasicMaterial({ map: padTexture('boost').clone(), transparent: true, opacity: 0.95 }),
    turbo: ghostMat ?? new THREE.MeshBasicMaterial({ map: padTexture('turbo').clone(), transparent: true, opacity: 0.95 }),
  };
  if (!ghost) {
    (mats.boost as THREE.MeshBasicMaterial).map!.needsUpdate = true;
    (mats.turbo as THREE.MeshBasicMaterial).map!.needsUpdate = true;
  }

  const add = (geo: THREE.BufferGeometry | null, mat: THREE.Material, cast: boolean, receive: boolean) => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast && !ghost;
    m.receiveShadow = receive && !ghost;
    group.add(m);
  };
  add(deck.build(), mats.deck, false, true);
  add(skirt.build(), mats.skirt, true, true);
  add(barrier.build(), mats.barrier, true, true);
  add(pads.boost.build(), mats.boost, false, false);
  add(pads.turbo.build(), mats.turbo, false, false);
  if (pillarGeos.length) {
    const merged = mergeGeometries(pillarGeos, false);
    pillarGeos.forEach((g) => g.dispose());
    if (merged) add(merged, mats.skirt, true, true);
  }

  return {
    group,
    update(dt: number) {
      if (ghost) return;
      for (const m of [mats.boost, mats.turbo] as THREE.MeshBasicMaterial[]) {
        if (m.map) m.map.offset.y -= dt * 1.6;
      }
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((mm: THREE.Material) => mm.dispose());
        }
      });
    },
  };
}

function buildGate(blk: PlacedBlock, kind: 'start' | 'checkpoint' | 'finish'): THREE.Group {
  const g = new THREE.Group();
  const p = at(blk, 16, 0, 0);
  g.position.set(p[0], p[1], p[2]);
  g.rotation.y = Math.atan2(blk.fx, blk.fz);
  const color = kind === 'checkpoint' ? 0x1f8fff : kind === 'start' ? 0x22c55e : 0xf5f5f5;
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.4 });
  const glowMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 });
  const span = DECK_EDGE;
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, 7.5, 0.9), postMat);
    post.position.set(side * span, 3.75, 0);
    post.castShadow = true;
    g.add(post);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 6.5, 0.95), glowMat);
    strip.position.set(side * (span - 0.5), 3.75, 0);
    g.add(strip);
  }
  const text = kind === 'checkpoint' ? 'CHECKPOINT' : kind === 'start' ? 'START' : 'FINISH';
  const tex =
    kind === 'finish'
      ? bannerTexture(text, '#111', '#ffffff', true)
      : bannerTexture(text, kind === 'start' ? '#15803d' : '#1d4ed8', '#ffffff');
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(span * 2 + 0.9, 2.2, 0.7),
    [postMat, postMat, postMat, postMat, new THREE.MeshBasicMaterial({ map: tex }), new THREE.MeshBasicMaterial({ map: tex })],
  );
  beam.position.y = 7.6;
  beam.castShadow = true;
  g.add(beam);
  // Light bar on the deck marking the line itself.
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(WALL_OFF * 2, 0.6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.07;
  g.add(line);
  return g;
}
