// Stadium surroundings: lawn, perimeter wall with LED boards, stepped grandstands under cantilever
// roofs, floodlight towers, a band of trees and a ring of hills. Static parts are merged per
// material (about a dozen draw calls in all). Nothing comes further inside the track extents than
// the perimeter wall's inner face: CameraRig keeps the camera 1.5 m inside them.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SkyKind, Theme } from '../track/track';
import type { QualityProfile } from './quality';
import { cactusGeometry, frameGeometry, mesaGeometry, palmGeometry, pierGeometry, rockGeometry, scatter } from './scenery';
import { adBoardTexture, crowdTexture } from './stadiumTextures';
import { grassTexture, haloTexture } from './textures';
import { sandTexture } from './themeTextures';
import { themeLook, type ThemeLook } from './themes';
import { disposeMaterial, seeded } from './texUtil';
import { waterMaterial } from './water';

export interface Extents {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Stadium {
  group: THREE.Group;
  dispose(): void;
}

/** Perimeter wall height; its centre line is the extents edge and it is 1 m thick. */
const PERIM_H = 3;
/** Grandstand rows: tread depth and riser height; the first tread clears the wall. */
const ROW_D = 1.6;
const ROW_H = 0.9;
const STAND_Y = 3.2;
const STAND_Z = -0.6;
/** Trees grow this far outside the extents (m). */
export const TREE_NEAR = 70;
export const TREE_FAR = 330;
/** Hill ring: starts this far beyond the stadium's half-size and ends at TERRAIN_FAR from its centre. */
const TERRAIN_GAP = 500;
export const TERRAIN_FAR = 2400;
const HILL_H = 260;
/** Outer field half-size. */
const FIELD = 3000;

type V = [number, number, number];

/** Flat-shaded quads: each quad has its own 4 vertices. */
class Quads {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  /** a, b, c, d counter-clockwise seen from the front; uv (u0, v0) at a and (u1, v1) at c. */
  quad(a: V, b: V, c: V, d: V, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
    const n = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }

  /** Axis-aligned box with outward faces; `bottom` false leaves the underside open. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, bottom = true): void {
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

type Part = 'wall' | 'ads' | 'stand' | 'crowd' | 'roof' | 'lamp';

/**
 * One side of the stadium in its own frame: x along the side, +z towards the track, origin on the
 * extents edge at the middle of the side. Adds geometry per material and returns the lamp halos.
 */
function buildSide(len: number, rows: number, add: (part: Part, g: THREE.BufferGeometry) => void, stands = true): V[] {
  const h = len / 2;
  const q: Record<Part, Quads> = {
    wall: new Quads(),
    ads: new Quads(),
    stand: new Quads(),
    crowd: new Quads(),
    roof: new Quads(),
    lamp: new Quads(),
  };
  const extra: [Part, THREE.BufferGeometry][] = [];

  // Perimeter wall (it overlaps the next side's wall in the corner) and its LED boards.
  q.wall.box(-h - 0.5, h + 0.5, 0, PERIM_H, -0.5, 0.5);
  q.ads.quad([-h, 0.45, 0.52], [h, 0.45, 0.52], [h, 2.45, 0.52], [-h, 2.45, 0.52], -h / 16, 0, h / 16, 1);
  // The Desert and Water arenas are open: the wall and its boards only.
  if (!stands) {
    for (const part of Object.keys(q) as Part[]) if (q[part].idx.length) add(part, q[part].build());
    return [];
  }

  // Stepped grandstand: fascia, then per row a tread, a riser of spectators and the end caps.
  q.stand.quad([-h, 0, STAND_Z], [h, 0, STAND_Z], [h, STAND_Y, STAND_Z], [-h, STAND_Y, STAND_Z]);
  for (let k = 0; k < rows; k++) {
    const zf = STAND_Z - k * ROW_D;
    const zb = zf - ROW_D;
    const y = STAND_Y + k * ROW_H;
    q.stand.quad([-h, y, zf], [h, y, zf], [h, y, zb], [-h, y, zb], 0, 0, len / 4, ROW_D / 4);
    q.crowd.quad([-h, y, zb], [h, y, zb], [h, y + ROW_H, zb], [-h, y + ROW_H, zb], -h / 8, 0, h / 8, 1);
    q.stand.quad([-h, 0, zb], [-h, 0, zf], [-h, y, zf], [-h, y, zb]);
    q.stand.quad([h, 0, zf], [h, 0, zb], [h, y, zb], [h, y, zf]);
  }
  const zBack = STAND_Z - rows * ROW_D;
  const yTop = STAND_Y + rows * ROW_H;
  q.stand.quad([-h, yTop, zBack], [h, yTop, zBack], [h, yTop + 1.2, zBack], [-h, yTop + 1.2, zBack]);
  q.stand.quad([h, 0, zBack], [-h, 0, zBack], [-h, yTop + 1.2, zBack], [h, yTop + 1.2, zBack]);

  // Cantilever roof over the back two thirds of the rows: light top, dark underside, columns behind.
  const yR = yTop + 6;
  const zFront = zBack + rows * ROW_D * 0.65;
  q.roof.box(-h, h, yR, yR + 0.5, zBack - 0.6, zFront, false);
  q.wall.quad([-h, yR - 0.01, zBack - 0.6], [h, yR - 0.01, zBack - 0.6], [h, yR - 0.01, zFront], [-h, yR - 0.01, zFront]);
  const cols = Math.max(3, Math.min(6, Math.round(len / 40) + 1));
  for (let i = 0; i < cols; i++) {
    const x = -h + 2 + ((len - 4) * i) / (cols - 1);
    extra.push(['roof', new THREE.CylinderGeometry(0.35, 0.35, yR, 8).translate(x, yR / 2, zBack - 0.3)]);
  }

  // Floodlight towers behind the stand, lamps tilted down at the track.
  const halos: V[] = [];
  const zT = zBack - 6;
  const H = yR + 22;
  const tilt = 0.35;
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  for (let x = -h; x <= h + 1; x += Math.max(120, len / 4)) {
    extra.push(['wall', new THREE.CylinderGeometry(0.6, 1.0, H, 8).translate(x, H / 2, zT)]);
    extra.push(['wall', new THREE.BoxGeometry(10, 4, 1.2).rotateX(tilt).translate(x, H + 1.5, zT + 0.8)]);
    const fy = H + 1.5 - 0.62 * sin;
    const fz = zT + 0.8 + 0.62 * cos;
    extra.push(['lamp', new THREE.PlaneGeometry(9.2, 3.2).rotateX(tilt).translate(x, fy, fz)]);
    halos.push([x, fy - sin * 1.2, fz + cos * 1.2]);
  }

  for (const part of Object.keys(q) as Part[]) if (q[part].idx.length) add(part, q[part].build());
  for (const [part, g] of extra) add(part, g);
  return halos;
}

function hash2(i: number, j: number, seed: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 2D value noise in 0..1 with `cell`-metre cells. */
function valueNoise(x: number, z: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const sx = fx - i;
  const sz = fz - j;
  const tx = sx * sx * (3 - 2 * sx);
  const tz = sz * sz * (3 - 2 * sz);
  const a = hash2(i, j, seed);
  const b = hash2(i + 1, j, seed);
  const c = hash2(i, j + 1, seed);
  const d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/** Lawn inside the walls: world-space uvs on the shared stripe texture, tinted per vertex to break up the tiling. */
function lawnGeometry(b: Extents): THREE.BufferGeometry {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const g = new THREE.PlaneGeometry(w, d, 32, 32).rotateX(-Math.PI / 2).translate((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    uv.setXY(i, x / 64, -z / 64);
    const k = 0.9 + 0.18 * (0.65 * valueNoise(x, z, 60, 1) + 0.35 * valueNoise(x, z, 17, 2));
    col[i * 3] = k;
    col[i * 3 + 1] = k;
    col[i * 3 + 2] = k * 0.97;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Flat field around the lawn, as a frame so the two never overlap (no z-fighting far away). */
function fieldGeometry(b: Extents): THREE.BufferGeometry {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const X0 = cx - FIELD;
  const X1 = cx + FIELD;
  const Z0 = cz - FIELD;
  const Z1 = cz + FIELD;
  const q = new Quads();
  const flat = (x0: number, x1: number, z0: number, z1: number) => q.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]);
  flat(X0, X1, Z0, b.z0);
  flat(X0, X1, b.z1, Z1);
  flat(X0, b.x0, b.z0, b.z1);
  flat(b.x1, X1, b.z0, b.z1);
  return q.build();
}

/** Ring of hills on the horizon, rising towards its outer edge; vertex-coloured green to blue-grey. */
export function terrainGeometry(
  b: Extents,
  seed = 13,
  low: THREE.Color = new THREE.Color('#5d8a4a'),
  high: THREE.Color = new THREE.Color('#8794a3'),
  hillH = HILL_H,
): THREE.BufferGeometry {
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const r1 = TERRAIN_FAR;
  const r0 = Math.min(r1 - 300, Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + TERRAIN_GAP);
  const SEG = 96;
  const RINGS = 6;
  const rnd = seeded(seed);
  const l1 = Array.from({ length: 23 }, rnd);
  const l2 = Array.from({ length: 7 }, rnd);
  const wave = (a: number, l: number[]) => {
    const f = (a / (Math.PI * 2)) * l.length;
    const i = Math.floor(f);
    const s = f - i;
    const t = s * s * (3 - 2 * s);
    return l[i % l.length] + (l[(i + 1) % l.length] - l[i % l.length]) * t;
  };
  const c = new THREE.Color();
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= RINGS; j++) {
    const t = j / RINGS;
    const r = r0 + (r1 - r0) * t;
    const rise = t * t * (3 - 2 * t);
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const n = 0.25 + 0.55 * wave(a, l1) + 0.2 * wave(a, l2);
      const y = n * hillH * rise;
      pos.push(cx + Math.cos(a) * r, y - 0.5, cz + Math.sin(a) * r);
      c.copy(low).lerp(high, Math.min(1, y / (hillH * 0.85)));
      col.push(c.r, c.g, c.b);
    }
  }
  const row = SEG + 1;
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * row + i;
      const bb = a + 1;
      const cc = a + row;
      const d = cc + 1;
      idx.push(a, bb, cc, bb, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Low-poly tree: a five-sided trunk and two faceted canopies, vertex-coloured, non-indexed. */
function treeGeometry(): THREE.BufferGeometry {
  const paint = (src: THREE.BufferGeometry, hex: number): THREE.BufferGeometry => {
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    g.deleteAttribute('uv');
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const parts = [
    paint(new THREE.CylinderGeometry(0.28, 0.42, 3.2, 5).translate(0, 1.6, 0), 0x5a3d27),
    paint(new THREE.IcosahedronGeometry(2.4, 0).scale(1, 1.25, 1).translate(0, 4.6, 0), 0x2f6b2a),
    paint(new THREE.IcosahedronGeometry(1.7, 0).scale(1, 1.2, 1).translate(0, 6.9, 0), 0x3d7f33),
  ];
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** Trees scattered in a band TREE_NEAR..TREE_FAR outside the extents; deterministic. */
function buildTrees(b: Extents, count: number, mat: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(treeGeometry(), mat, count);
  const rnd = seeded(97);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  const c = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 40; tries++) {
    const x = b.x0 - TREE_FAR + rnd() * (b.x1 - b.x0 + 2 * TREE_FAR);
    const z = b.z0 - TREE_FAR + rnd() * (b.z1 - b.z0 + 2 * TREE_FAR);
    if (x > b.x0 - TREE_NEAR && x < b.x1 + TREE_NEAR && z > b.z0 - TREE_NEAR && z < b.z1 + TREE_NEAR) continue;
    const k = 0.8 + rnd() * 0.8;
    q.setFromAxisAngle(Y, rnd() * Math.PI * 2);
    m.compose(t.set(x, 0, z), q, s.set(k, k * (0.85 + rnd() * 0.35), k));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, c.setRGB(0.8 + rnd() * 0.35, 0.85 + rnd() * 0.3, 0.75 + rnd() * 0.3));
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * The surroundings of a track: the stadium (lawn, stands, roofs, floodlights, trees, hills) or, for the
 * Desert and Water themes and any sunset, an open arena or a stadium in the theme's colours (themedSurroundings).
 */
export function buildStadium(b: Extents, p: QualityProfile, theme: Theme = 'stadium', sky: SkyKind = 'day'): Stadium {
  if (theme !== 'stadium' || sky !== 'day') return themedSurroundings(b, p, theme, themeLook(theme, sky));
  const group = new THREE.Group();
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const lit = (params: THREE.MeshStandardMaterialParameters): THREE.Material => {
    if (!p.cheapGround) return new THREE.MeshStandardMaterial(params);
    // Only the keys Lambert shares, and only those given: r186 warns about every undefined one.
    const m = new THREE.MeshLambertMaterial();
    if (params.color !== undefined) m.color.set(params.color);
    m.map = params.map ?? null;
    m.vertexColors = params.vertexColors ?? false;
    return m;
  };

  const mats: Record<Part, THREE.Material> = {
    wall: lit({ color: 0x30353d, roughness: 0.8 }),
    ads: new THREE.MeshBasicMaterial({ map: adBoardTexture(), color: 0xdddddd }),
    stand: lit({ color: 0x8b929c, roughness: 0.9 }),
    crowd: lit({ map: crowdTexture(), roughness: 0.9 }),
    // At most 0.2 metalness, so markEnvLit leaves these big surfaces off the environment map.
    roof: lit({ color: 0xe8ebef, roughness: 0.45, metalness: 0.2 }),
    // Lamps are lights: HDR white, so they clip on screen and bloom where bloom is on.
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.2) }),
  };

  // Four sides, each in its own frame (+z towards the track).
  const parts: Record<Part, THREE.BufferGeometry[]> = { wall: [], ads: [], stand: [], crowd: [], roof: [], lamp: [] };
  const halos: number[] = [];
  const sides: [number, number, number, number][] = [
    [cx, b.z0, w, 0],
    [cx, b.z1, w, Math.PI],
    [b.x0, cz, d, Math.PI / 2],
    [b.x1, cz, d, -Math.PI / 2],
  ];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const [px, pz, len, rot] of sides) {
    m.makeRotationY(rot).setPosition(px, 0, pz);
    const lamps = buildSide(len, p.standRows, (part, g) => parts[part].push(g.applyMatrix4(m)));
    for (const l of lamps) {
      v.set(l[0], l[1], l[2]).applyMatrix4(m);
      halos.push(v.x, v.y, v.z);
    }
  }
  for (const part of Object.keys(parts) as Part[]) {
    const geos = parts[part];
    const merged = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, mats[part]);
      mesh.name = 'stadium-' + part;
      group.add(mesh);
    }
  }

  const lawn = new THREE.Mesh(lawnGeometry(b), lit({ map: grassTexture(), vertexColors: true, roughness: 1 }));
  lawn.name = 'lawn';
  lawn.receiveShadow = true;
  group.add(lawn);
  const field = new THREE.Mesh(fieldGeometry(b), new THREE.MeshLambertMaterial({ color: 0x5c8f45 }));
  field.name = 'field';
  group.add(field);
  const hills = new THREE.Mesh(terrainGeometry(b), new THREE.MeshLambertMaterial({ vertexColors: true }));
  hills.name = 'terrain';
  group.add(hills);
  if (p.trees > 0) {
    const trees = buildTrees(b, p.trees, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    trees.name = 'trees';
    group.add(trees);
  }
  if (p.halos && halos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(halos, 3));
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        map: haloTexture(),
        color: new THREE.Color(1, 0.93, 0.78),
        size: 34,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
      }),
    );
    pts.name = 'halos';
    group.add(pts);
  }

  return {
    group,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((mm: THREE.Material) => disposeMaterial(mm));
        }
      });
    },
  };
}

/** Lit material for the surroundings: Standard, or Lambert on the cheap tier (only the keys Lambert shares). */
function litMaterial(p: QualityProfile, params: THREE.MeshStandardMaterialParameters): THREE.Material {
  if (!p.cheapGround) return new THREE.MeshStandardMaterial(params);
  const m = new THREE.MeshLambertMaterial();
  if (params.color !== undefined) m.color.set(params.color);
  m.map = params.map ?? null;
  m.vertexColors = params.vertexColors ?? false;
  return m;
}

/** Beach width (m) outside the Water arena's wall; the sea starts there. */
export const BEACH = 230;

/**
 * Desert and Water surroundings (and the Stadium at sunset): the perimeter wall with its LED boards (stands,
 * roofs and floodlights only for the Stadium), the floor inside (sand or lawn), the field outside, hills on the
 * horizon, and the theme's scenery: cacti, rocks and mesas in the desert; a beach, palms, rocks, wooden piers
 * and the sea on the coast. About ten draw calls, the tier's tree budget shared out between the props.
 */
function themedSurroundings(b: Extents, p: QualityProfile, theme: Theme, look: ThemeLook): Stadium {
  const group = new THREE.Group();
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const stands = theme === 'stadium';
  const mats: Record<Part, THREE.Material> = {
    wall: litMaterial(p, { color: look.wall, roughness: 0.85 }),
    ads: new THREE.MeshBasicMaterial({ map: adBoardTexture(), color: 0xdddddd }),
    stand: litMaterial(p, { color: 0x8b929c, roughness: 0.9 }),
    crowd: litMaterial(p, { map: crowdTexture(), roughness: 0.9 }),
    roof: litMaterial(p, { color: 0xe8ebef, roughness: 0.45, metalness: 0.2 }),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.2) }),
  };
  const parts: Record<Part, THREE.BufferGeometry[]> = { wall: [], ads: [], stand: [], crowd: [], roof: [], lamp: [] };
  const halos: number[] = [];
  const sides: [number, number, number, number][] = [
    [cx, b.z0, w, 0],
    [cx, b.z1, w, Math.PI],
    [b.x0, cz, d, Math.PI / 2],
    [b.x1, cz, d, -Math.PI / 2],
  ];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (const [px, pz, len, rot] of sides) {
    m.makeRotationY(rot).setPosition(px, 0, pz);
    const lamps = buildSide(len, p.standRows, (part, g) => parts[part].push(g.applyMatrix4(m)), stands);
    for (const l of lamps) {
      v.set(l[0], l[1], l[2]).applyMatrix4(m);
      halos.push(v.x, v.y, v.z);
    }
  }
  for (const part of Object.keys(parts) as Part[]) {
    const geos = parts[part];
    // An open arena has no stands, roofs or lamps.
    const merged = geos.length ? mergeGeometries(geos) : null;
    geos.forEach((g) => g.dispose());
    if (merged) {
      const mesh = new THREE.Mesh(merged, mats[part]);
      mesh.name = 'stadium-' + part;
      group.add(mesh);
    } else disposeMaterial(mats[part]);
  }

  const desert = theme === 'desert';
  const floor = new THREE.Mesh(
    lawnGeometry(b),
    litMaterial(p, { map: desert ? sandTexture() : grassTexture(), vertexColors: true, roughness: 1 }),
  );
  floor.name = 'lawn';
  floor.receiveShadow = true;
  group.add(floor);
  const beach = theme === 'water' ? BEACH : 0;
  if (beach) {
    // Sand from the wall to the water's edge, then the sea out past the horizon fog.
    const sand = new THREE.Mesh(frameGeometry(b, 0, beach, 0), new THREE.MeshLambertMaterial({ color: look.field }));
    sand.name = 'field';
    group.add(sand);
    const sea = new THREE.Mesh(frameGeometry(b, beach - 1, FIELD, -0.4), waterMaterial(look, { cheap: p.cheapGround, scale: 60 }));
    sea.name = 'sea';
    group.add(sea);
  } else {
    const field = new THREE.Mesh(fieldGeometry(b), new THREE.MeshLambertMaterial({ color: look.field }));
    field.name = 'field';
    group.add(field);
  }
  const hills = new THREE.Mesh(
    terrainGeometry(b, theme === 'water' ? 29 : 17, look.hillLow, look.hillHigh, look.hillHeight),
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  );
  hills.name = 'terrain';
  group.add(hills);

  const flat = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const budget = p.trees;
  if (desert) {
    if (budget > 0) {
      const cacti = scatter(cactusGeometry(), flat(), b, Math.round(budget * 0.45), TREE_NEAR - 30, TREE_FAR, 101, [0.8, 1.5]);
      cacti.name = 'trees';
      group.add(cacti);
    }
    const rocks = scatter(rockGeometry(), flat(), b, Math.max(12, Math.round(budget * 0.35)), 20, TREE_FAR + 120, 103, [0.8, 3.5], new THREE.Color(0xa86a44));
    rocks.name = 'rocks';
    group.add(rocks);
    const r0 = Math.max(w, d) / 2 + 420;
    const mesas = new THREE.Mesh(mesaGeometry(b, p.cheapGround ? 8 : 14, r0, r0 + 900), flat());
    mesas.name = 'mesas';
    group.add(mesas);
  } else if (theme === 'water') {
    if (budget > 0) {
      const palms = scatter(palmGeometry(), flat(), b, Math.round(budget * 0.4), 25, beach - 40, 107, [0.85, 1.35]);
      palms.name = 'trees';
      group.add(palms);
    }
    const rocks = scatter(rockGeometry(), flat(), b, Math.max(10, Math.round(budget * 0.15)), beach - 70, beach + 10, 109, [1, 4], new THREE.Color(0x8a8f94));
    rocks.name = 'rocks';
    group.add(rocks);
    const piers = new THREE.Mesh(pierGeometry(b, beach, 4), flat());
    piers.name = 'piers';
    group.add(piers);
  } else if (budget > 0) {
    const trees = buildTrees(b, budget, flat());
    trees.name = 'trees';
    group.add(trees);
  }
  if (p.halos && halos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(halos, 3));
    const pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        map: haloTexture(),
        color: new THREE.Color(1, 0.93, 0.78),
        size: 34,
        sizeAttenuation: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
      }),
    );
    pts.name = 'halos';
    group.add(pts);
  }

  return {
    group,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) o.dispose();
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((mm: THREE.Material) => disposeMaterial(mm));
        }
      });
    },
  };
}
