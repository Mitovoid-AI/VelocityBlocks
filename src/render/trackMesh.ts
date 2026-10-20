// Builds the visual meshes for a track from the same block definitions the physics uses.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DECK_EDGE, DECK_T, WALL_H, WALL_OFF } from '../core/constants';
import { centerAt } from '../track/blocks';
import { barrierRange, type Column, type PlacedBlock, type Track } from '../track/track';
import {
  bannerTexture,
  barrierTexture,
  concreteTexture,
  glowBarTexture,
  kerbTexture,
  padTexture,
  roadRoughness,
  roadTexture,
  turfTexture,
} from './textures';
import { disposeMaterial } from './texUtil';

/** The deck is drawn this far above the physics surface; pads, kerbs and gate lines sit on it. */
export const DECK_LIFT = 0.03;
/** Kerbs run from this lateral distance out to the deck edge (under the barrier where there is one). */
const KERB_IN = 9.4;
/** Kerb height above the deck. Physics is flat, so keep it tiny or wheels visibly sink. */
const KERB_H = 0.03;
/** Barrier top: half-round cap this high above WALL_H. */
const CAP_RISE = 0.1;

class Strip {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  /**
   * Add a grid of rows x cols vertices; `at(r, c)` returns [x, y, z, u, v] and optionally an
   * ambient-occlusion shade (default 1), stored as a grey vertex colour.
   */
  grid(rows: number, cols: number, at: (r: number, c: number) => number[], flip = false): void {
    const base = this.pos.length / 3;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const p = at(r, c);
        this.pos.push(p[0], p[1], p[2]);
        this.uv.push(p[3], p[4]);
        const ao = p[5] ?? 1;
        this.col.push(ao, ao, ao);
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
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
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
  /**
   * Lambert instead of Standard on the road, kerbs, skirts, banks and barriers (the Low tier,
   * QualityProfile.cheapGround): the biggest surfaces on screen get the cheapest lit shader. They are
   * rough and non-metallic, so the diffuse look barely changes.
   */
  cheap?: boolean;
}

/** A road surface material: Standard, or with `cheap` a Lambert with the same map, colour and vertex colours. */
function surfaceMaterial(cheap: boolean | undefined, params: THREE.MeshStandardMaterialParameters): THREE.Material {
  if (!cheap) return new THREE.MeshStandardMaterial(params);
  const m = new THREE.MeshLambertMaterial();
  m.map = params.map ?? null;
  m.vertexColors = params.vertexColors ?? false;
  return m;
}

/** Rows of vertices along a block (curves and slopes need more). */
export function samplesFor(blk: PlacedBlock): number {
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

/**
 * A block end (s = 0 or its length) as a key: the centre point and deck height to the centimetre. Block
 * ends sit on cell-edge midpoints at whole levels (or a ramp lip), far from any rounding boundary, and two
 * ends that meet share a cross-section, since both centre lines cross the shared cell edge square on.
 */
function endKey(blk: PlacedBlock, s: number): string {
  const c = blk.centerWorld(s);
  return `${Math.round(c.x * 100)},${Math.round(c.y * 100)},${Math.round(c.z * 100)}`;
}

/**
 * Side barriers of every block (where the physics has them: track.ts barrierRange, every road with
 * Track.walls), and a test for a block end where a barrier runs on into the next block. Only open ends get
 * end caps: a jump gap, the start and finish, a barrier stopping mid-slope. Caps at joints would sit back to
 * back unseen, and are most of a straight's barrier triangles (64 of 92).
 */
export function barrierPlan(track: Track): {
  ranges: ([number, number] | null)[];
  joined: (blk: PlacedBlock, s: number) => boolean;
} {
  const ranges = track.blocks.map((b) => barrierRange(b, track.walls));
  const ends = new Map<string, number>();
  const mark = (k: string) => ends.set(k, (ends.get(k) ?? 0) + 1);
  track.blocks.forEach((b, n) => {
    const r = ranges[n];
    if (!r) return;
    const L = b.def.length;
    if (r[0] === 0) mark(endKey(b, 0));
    if (r[1] === L) mark(endKey(b, L));
  });
  return {
    ranges,
    joined: (blk, s) => (s === 0 || s === blk.def.length) && (ends.get(endKey(blk, s)) ?? 0) > 1,
  };
}

/** Grey vertex colour on a whole geometry, or a per-vertex shade from its position. */
function shade(g: THREE.BufferGeometry, ao: number | ((x: number, y: number, z: number) => number)): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = typeof ao === 'number' ? ao : ao(pos.getX(i), pos.getY(i), pos.getZ(i));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** World-space box-projected uvs (one texture tile per `tile` metres), so tall pillars are not stretched. */
function planarUv(g: THREE.BufferGeometry, tile = 4): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    const x = pos.getX(i) / tile;
    const y = pos.getY(i) / tile;
    const z = pos.getZ(i) / tile;
    if (ay >= ax && ay >= az) uv.setXY(i, x, z);
    else if (ax >= az) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  return g;
}

/** Pillar bodies by height, shared by every track (about 30 KB each, at most 64 kept). */
const pillarBodies = new Map<number, THREE.BufferGeometry>();

/**
 * A pillar as drawn: the physics column's 1.6 m square footprint with rounded edges, darker at the
 * foot, plus a wider cap just under the deck. Non-indexed, with a colour attribute.
 */
export function pillarGeometry(c: Column): THREE.BufferGeometry {
  // A rounded box costs about 1 ms to build and a track has up to ~100 pillars of a few heights:
  // copy a cached body instead. Cached as a plain BufferGeometry, because RoundedBoxGeometry.clone()
  // builds a default rounded box before copying.
  const h = c.y1 - c.y0;
  let tpl = pillarBodies.get(h);
  if (!tpl) {
    if (pillarBodies.size >= 64) pillarBodies.clear(); // editor slopes can make many heights
    const rb = new RoundedBoxGeometry(1.6, h, 1.6, 2, 0.15);
    pillarBodies.set(h, (tpl = new THREE.BufferGeometry().copy(rb)));
    rb.dispose();
  }
  const body = tpl.clone().translate(c.x, (c.y0 + c.y1) / 2, c.z);
  shade(body, (_x, y) => {
    const t = Math.min(1, Math.max(0, (y - c.y0) / 2.5));
    return 0.7 + 0.3 * t * t * (3 - 2 * t);
  });
  const capH = Math.min(0.4, (c.y1 - c.y0) * 0.25);
  const cap = shade(new THREE.BoxGeometry(2.0, capH, 2.0).toNonIndexed().translate(c.x, c.y1 - capH / 2, c.z), 0.85);
  const g = mergeGeometries([body, cap])!;
  body.dispose();
  cap.dispose();
  return planarUv(g);
}

type GateKind = 'start' | 'checkpoint' | 'finish';
const GATE_COLOR: Record<GateKind, number> = { start: 0x22c55e, checkpoint: 0x1f8fff, finish: 0xf5f5f5 };

/** Gate geometry in world space, merged per material across every gate of the track. */
interface GatePart {
  geos: THREE.BufferGeometry[];
  make: () => THREE.Material;
  cast: boolean;
  order: number;
}

function tint(g: THREE.BufferGeometry, color: THREE.Color, k = 1): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([color.r * k, color.g * k, color.b * k], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const gateMats = {
  post: () => new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.4 }),
  // Light strips are lights: HDR colour, so the core reads bright (and blooms where bloom is on).
  glow: () => new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.6, 1.6, 1.6) }),
  halo: () =>
    new THREE.MeshBasicMaterial({
      map: glowBarTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      // Fog would add sky colour to an additive quad.
      fog: false,
    }),
  line: () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, toneMapped: false }),
};

function addGate(blk: PlacedBlock, kind: GateKind, parts: Map<string, GatePart>): void {
  const p = at(blk, 16, 0, 0);
  const m = new THREE.Matrix4().makeRotationY(Math.atan2(blk.fx, blk.fz)).setPosition(p[0], p[1], p[2]);
  const put = (key: string, geo: THREE.BufferGeometry, make: () => THREE.Material, cast = false, order = 0) => {
    let part = parts.get(key);
    if (!part) parts.set(key, (part = { geos: [], make, cast, order }));
    part.geos.push(geo.applyMatrix4(m));
  };
  const color = new THREE.Color(GATE_COLOR[kind]);
  const span = DECK_EDGE;
  for (const side of [-1, 1]) {
    put('post', new THREE.BoxGeometry(0.9, 7.5, 0.9).translate(side * span, 3.75, 0), gateMats.post, true);
    put('glow', tint(new THREE.BoxGeometry(0.2, 6.5, 0.95).translate(side * (span - 0.5), 3.75, 0), color), gateMats.glow);
    // Cheap glow on every tier: an additive quad in front of and behind each strip.
    for (const face of [-1, 1]) {
      const q = new THREE.PlaneGeometry(1.4, 7.6).rotateY(face < 0 ? Math.PI : 0);
      put('halo', tint(q.translate(side * (span - 0.5), 3.75, face * 0.52), color, 0.55), gateMats.halo);
    }
  }
  const text = kind === 'checkpoint' ? 'CHECKPOINT' : kind === 'start' ? 'START' : 'FINISH';
  const tex =
    kind === 'finish'
      ? bannerTexture(text, '#111', '#ffffff', true)
      : bannerTexture(text, kind === 'start' ? '#15803d' : '#1d4ed8', '#ffffff');
  const beamW = span * 2 + 0.9;
  put('post', new THREE.BoxGeometry(beamW, 2.2, 0.7).translate(0, 7.6, 0), gateMats.post, true);
  // Banner faces as two quads on the beam (a box with six materials cost six draw calls per gate).
  for (const face of [-1, 1]) {
    const q = new THREE.PlaneGeometry(beamW, 2.2).rotateY(face < 0 ? Math.PI : 0).translate(0, 7.6, face * 0.36);
    put('banner-' + text, q, () => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  }
  // Light bar on the deck marking the line itself. Drawn before the racing line (renderOrder -0.5).
  const line = new THREE.PlaneGeometry(WALL_OFF * 2, 0.6).rotateX(-Math.PI / 2).translate(0, DECK_LIFT + 0.04, 0);
  put('line', tint(line, color), gateMats.line, false, -1);
}

export function buildTrackVisual(track: Track, opts: VisualOptions = {}): TrackVisual {
  const group = new THREE.Group();
  const deck = new Strip();
  const kerb = new Strip();
  const skirt = new Strip();
  const bank = new Strip();
  const barrier = new Strip();
  const pads = { boost: new Strip(), turbo: new Strip() };
  const pillarGeos: THREE.BufferGeometry[] = [];
  const gates = new Map<string, GatePart>();
  const edge = DECK_EDGE;
  const walls = barrierPlan(track);

  for (const blk of track.blocks) {
    const L = blk.def.length;
    const n = samplesFor(blk);
    const S = (r: number) => (L * r) / (n - 1);
    const rows = n;
    // Embankments (slopes and ramps rising from the floor) are solid down to the ground.
    const floorOff = (s: number) => -(blk.baseY + blk.def.height(s)) - 0.05;
    // Barriers where the deck is high enough to fall from, or on every road with walls on all roads (the
    // physics' rule); the deck and kerbs darken next to them.
    const br = walls.ranges[blk.index];
    const walled = (s: number) => br !== null && s >= br[0] - 0.5 && s <= br[1] + 0.5;

    // Deck top (u across, v along; one texture tile per 16 m). Four columns: the outer ones carry
    // the shade next to a barrier.
    const D = [-edge, -KERB_IN, KERB_IN, edge];
    deck.grid(rows, 4, (r, c) => {
      const s = S(r);
      const p = at(blk, s, D[c], DECK_LIFT);
      const ao = (c === 0 || c === 3) && walled(s) ? 0.62 : 1;
      return [...p, ((D[c] + edge) / (2 * edge)) * 1.05 - 0.025, s / 16, ao];
    });

    // Kerbs: a bevel on the road side, then flat to just inside the deck edge (inside the barrier
    // where there is one, so its outer face never z-fights the barrier's).
    const KD = [KERB_IN, KERB_IN + 0.15, WALL_OFF, edge - 0.02, edge - 0.02];
    const KY = [0, KERB_H, KERB_H, KERB_H, 0];
    const KU = [0, 0.09, 0.71, 1, 1];
    const KAO = [0.92, 0.9, 0.62, 0.62, 0.62];
    for (const side of [-1, 1]) {
      kerb.grid(
        rows,
        5,
        (r, c) => {
          const s = S(r);
          const p = at(blk, s, side * KD[c], DECK_LIFT + KY[c]);
          return [...p, KU[c], s / 4, walled(s) ? KAO[c] : 1];
        },
        side < 0,
      );
    }

    // Deck sides and underside; embankments get turf sides down to the floor and no underside.
    for (const side of [-1, 1]) {
      if (!blk.embank) {
        skirt.grid(
          rows,
          2,
          (r, c) => {
            const p = at(blk, S(r), side * edge, c === 0 ? DECK_LIFT : -DECK_T);
            return [...p, S(r) / 4, c === 0 ? 0 : -DECK_T / 4, c === 0 ? 1 : 0.8];
          },
          side < 0,
        );
      } else {
        bank.grid(
          rows,
          2,
          (r, c) => {
            const yoff = c === 0 ? DECK_LIFT : floorOff(S(r));
            const p = at(blk, S(r), side * edge, yoff);
            return [...p, S(r) / 6, c === 0 ? 0 : -yoff / 6, c === 0 ? 1 : 0.7];
          },
          side < 0,
        );
      }
    }
    if (!blk.embank) {
      skirt.grid(rows, 2, (r, c) => {
        const d = c === 0 ? -edge : edge;
        const p = at(blk, S(r), d, -DECK_T);
        return [...p, d / 4, S(r) / 4, 0.7];
      }, true);
    } else {
      // High-end face (ramp lip, or the wall under the following bridge); both windings so it always shows.
      const hs = blk.highEndS;
      const bottom = floorOff(hs);
      for (const flip of [false, true]) {
        skirt.grid(2, 2, (r, c) => {
          const yoff = r === 0 ? DECK_LIFT : bottom;
          const p = at(blk, hs, c === 0 ? -edge : edge, yoff);
          return [...p, c * edge / 2, r === 0 ? 0 : -yoff / 4, r === 0 ? 1 : 0.8];
        }, flip);
      }
    }

    // Barriers: inner face, rounded top, outer face on each side, along the barrier range. The physics wall
    // line is the same: inner face at WALL_OFF, outer at the deck edge, WALL_H tall.
    if (br) {
      const [s0, s1] = br;
      const nb = Math.max(2, Math.ceil(((n - 1) * (s1 - s0)) / L) + 1);
      const SB = (r: number) => s0 + ((s1 - s0) * r) / (nb - 1);
      const half = (edge - WALL_OFF) / 2;
      const capD = (c: number) => WALL_OFF + half * (1 - Math.cos((c / 4) * Math.PI));
      const capY = (c: number) => WALL_H + CAP_RISE * Math.sin((c / 4) * Math.PI);
      for (const side of [-1, 1]) {
        const flip = side < 0;
        const IY = [0, 0.45, WALL_H];
        const IAO = [0.6, 0.86, 1];
        barrier.grid(nb, 3, (r, c) => {
          const p = at(blk, SB(r), side * WALL_OFF, IY[c]);
          return [...p, SB(r) / 8, IY[c] / WALL_H, IAO[c]];
        }, flip);
        barrier.grid(nb, 5, (r, c) => {
          const p = at(blk, SB(r), side * capD(c), capY(c));
          return [...p, SB(r) / 8, 0.98];
        }, flip);
        barrier.grid(nb, 2, (r, c) => {
          const p = at(blk, SB(r), side * edge, c === 0 ? 0 : WALL_H);
          return [...p, SB(r) / 8, c, c === 0 ? 0.8 : 1];
        }, !flip);
        // End caps following the rounded profile, so a barrier that starts or stops (mid-block, at a jump
        // gap, the start or the finish) reads as solid. None where it runs on into the next block.
        for (const s of [s0, s1]) {
          if (walls.joined(blk, s)) continue;
          for (const capFlip of [false, true]) {
            barrier.grid(2, 5, (r, c) => {
              const p = at(blk, s, side * capD(c), r === 0 ? 0 : capY(c));
              return [...p, (capD(c) - WALL_OFF) * 0.12, r];
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
        const p = at(blk, s, c === 0 ? -7.5 : 7.5, DECK_LIFT + 0.03);
        return [...p, c, s / 12];
      });
    }

    // Start back wall.
    if (blk.def.gate === 'start') {
      const wall = new THREE.BoxGeometry(edge * 2, WALL_H, 0.6).toNonIndexed();
      const p = at(blk, 0, 0, WALL_H / 2);
      wall.rotateY(Math.atan2(blk.fx, blk.fz));
      wall.translate(p[0] - blk.fx * 0.3, p[1], p[2] - blk.fz * 0.3);
      const y0 = p[1] - WALL_H / 2;
      pillarGeos.push(planarUv(shade(wall, (_x, y) => (y - y0 < 0.1 ? 0.75 : 1))));
    }

    // Gates.
    if (blk.def.gate && !opts.light) addGate(blk, blk.def.gate, gates);
  }

  // Pillars under elevated decks: the same solid columns the physics collides with.
  if (!opts.light) {
    for (const c of track.columns) if (c.kind === 'pillar') pillarGeos.push(pillarGeometry(c));
  }

  const ghost = opts.ghostColor !== undefined;
  const ghostMat = ghost
    ? new THREE.MeshBasicMaterial({ color: opts.ghostColor, transparent: true, opacity: 0.45, depthWrite: false })
    : null;

  const mats = {
    deck:
      ghostMat ??
      surfaceMaterial(opts.cheap, {
        map: roadTexture(),
        // The roughness map only matters to Standard: Lambert leaves it unloaded.
        roughnessMap: opts.cheap ? null : roadRoughness(),
        roughness: 1,
        metalness: 0.0,
        vertexColors: true,
      }),
    kerb: ghostMat ?? surfaceMaterial(opts.cheap, { map: kerbTexture(), roughness: 0.7, vertexColors: true }),
    skirt: ghostMat ?? surfaceMaterial(opts.cheap, { map: concreteTexture(), roughness: 0.95, vertexColors: true }),
    bank: ghostMat ?? surfaceMaterial(opts.cheap, { map: turfTexture(), roughness: 1, vertexColors: true }),
    barrier: ghostMat ?? surfaceMaterial(opts.cheap, { map: barrierTexture(), roughness: 0.55, vertexColors: true }),
    // Pads are lit signs: shown at their true colours, not tone-mapped.
    boost:
      ghostMat ??
      new THREE.MeshBasicMaterial({ map: padTexture('boost').clone(), transparent: true, opacity: 0.95, toneMapped: false }),
    turbo:
      ghostMat ??
      new THREE.MeshBasicMaterial({ map: padTexture('turbo').clone(), transparent: true, opacity: 0.95, toneMapped: false }),
  };
  if (!ghost) {
    (mats.boost as THREE.MeshBasicMaterial).map!.needsUpdate = true;
    (mats.turbo as THREE.MeshBasicMaterial).map!.needsUpdate = true;
  }

  const add = (name: string, geo: THREE.BufferGeometry | null, mat: THREE.Material, cast: boolean, receive: boolean, order = 0) => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = cast && !ghost;
    m.receiveShadow = receive && !ghost;
    m.renderOrder = order;
    group.add(m);
  };
  add('deck', deck.build(), mats.deck, false, true);
  add('kerb', kerb.build(), mats.kerb, false, true);
  add('skirt', skirt.build(), mats.skirt, true, true);
  add('bank', bank.build(), mats.bank, true, true);
  add('barrier', barrier.build(), mats.barrier, true, true);
  // Pads draw before the racing line (renderOrder -0.5), which must stay visible on them.
  add('boost', pads.boost.build(), mats.boost, false, false, -1);
  add('turbo', pads.turbo.build(), mats.turbo, false, false, -1);
  if (pillarGeos.length) {
    const merged = mergeGeometries(pillarGeos, false);
    pillarGeos.forEach((g) => g.dispose());
    if (merged) add('pillars', merged, mats.skirt, true, true);
  }
  for (const [key, part] of gates) {
    const merged = mergeGeometries(part.geos, false);
    part.geos.forEach((g) => g.dispose());
    if (merged) add('gate-' + key, merged, part.make(), part.cast, part.cast, part.order);
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
      const done = new Set<THREE.Material>();
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((mm: THREE.Material) => {
            if (done.has(mm)) return;
            done.add(mm);
            disposeMaterial(mm);
          });
        }
      });
    },
  };
}
