// Geometry helpers for the procedural cars: rounded boxes, lofted hulls, side profiles with wheel
// arches, wings, tubes, the shared tyre and rim, and the per-material merge that keeps each car to a
// handful of draw calls. Geometry only (no textures, no DOM), so every body builds under node.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WHEEL_RADIUS } from '../physics/vehicle';

export type Vec3 = readonly [number, number, number];

/**
 * Box with rounded edges and corners, the shape of three's RoundedBoxGeometry but indexed (that
 * one is unindexed: four times the vertices). The radius is clamped to half the smallest side.
 */
export function roundedBoxGeometry(w: number, h: number, d: number, segments = 2, r = 0.04): THREE.BufferGeometry {
  const ts = segments * 2 + 1;
  const rr = Math.min(r, w / 2, h / 2, d / 2);
  const g = new THREE.BoxGeometry(1, 1, 1, ts, ts, ts);
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const half = 0.5 / ts;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const sx = Math.sign(pos.getX(i));
    const sy = Math.sign(pos.getY(i));
    const sz = Math.sign(pos.getZ(i));
    // The grid lines next to each face's middle collapse onto the flat part; the outer ones bend round.
    n.set(pos.getX(i) - sx * half, pos.getY(i) - sy * half, pos.getZ(i) - sz * half).normalize();
    pos.setXYZ(i, (w / 2 - rr) * sx + n.x * rr, (h / 2 - rr) * sy + n.y * rr, (d / 2 - rr) * sz + n.z * rr);
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}

/** Rounded box mesh at (x, y, z). */
export function rbox(
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  r = 0.04,
  segments = 2,
): THREE.Mesh {
  const m = new THREE.Mesh(roundedBoxGeometry(w, h, d, segments, r), mat);
  m.position.set(x, y, z);
  return m;
}

export interface LoftSection {
  z: number;
  /** Half width. */
  hw: number;
  top: number;
  bottom: number;
  /** Centre x (default 0). */
  x?: number;
  /** Superellipse exponent of the upper half: 2 is an ellipse, higher is boxier (default 3). */
  n?: number;
  /** Exponent of the lower half (default n). */
  nb?: number;
}

/**
 * Smooth hull through superellipse cross-sections along z (any order), with flat caps at both
 * ends. Between sections every point moves in a straight line, so a part lofted through the same
 * z stations with its top raised (a stripe) follows the surface exactly.
 */
export function loftGeometry(sections: readonly LoftSection[], ring = 16): THREE.BufferGeometry {
  const secs = [...sections].sort((a, b) => a.z - b.z);
  const pos: number[] = [];
  const idx: number[] = [];
  for (const s of secs) {
    const cx = s.x ?? 0;
    const cy = (s.top + s.bottom) / 2;
    const hy = (s.top - s.bottom) / 2;
    for (let k = 0; k < ring; k++) {
      // k = 0 is the +x side at mid height, counter-clockwise seen from the front (+z).
      const t = (k / ring) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const e = 2 / (sn >= 0 ? (s.n ?? 3) : (s.nb ?? s.n ?? 3));
      pos.push(cx + s.hw * Math.sign(c) * Math.abs(c) ** e, cy + hy * Math.sign(sn) * Math.abs(sn) ** e, s.z);
    }
  }
  for (let i = 0; i + 1 < secs.length; i++) {
    for (let k = 0; k < ring; k++) {
      const a = i * ring + k;
      const b = i * ring + ((k + 1) % ring);
      const c = a + ring;
      const d = b + ring;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Caps get their own vertices, so their edges stay crisp.
  for (const [i, dir] of [
    [0, -1],
    [secs.length - 1, 1],
  ] as const) {
    const s = secs[i];
    const centre = pos.length / 3;
    pos.push(s.x ?? 0, (s.top + s.bottom) / 2, s.z);
    for (let k = 0; k < ring; k++) pos.push(pos[(i * ring + k) * 3], pos[(i * ring + k) * 3 + 1], s.z);
    for (let k = 0; k < ring; k++) {
      const a = centre + 1 + k;
      const b = centre + 1 + ((k + 1) % ring);
      if (dir > 0) idx.push(centre, a, b);
      else idx.push(centre, b, a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Smooth shading over curves and bevels, hard edges at real corners (more than 60 degrees), then
 * the vertices that ended up identical are shared again. The crease helper hashes positions to
 * 1 cm, so it runs at 100x scale to keep small parts apart.
 */
function creased(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  g.scale(100, 100, 100);
  const out = toCreasedNormals(g, Math.PI / 3);
  if (out !== g) g.dispose();
  const welded = mergeVertices(out.scale(0.01, 0.01, 0.01));
  out.dispose();
  return welded;
}

/**
 * A side profile (shape x = car z, shape y = car y) extruded across the car from x0 to x1. The
 * bevel rounds every edge and grows the outline by its size, which arch radii must allow for.
 */
export function extrudeX(shape: THREE.Shape, x0: number, x1: number, bevel = 0.03, curveSegments = 10): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, x1 - x0 - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments,
  });
  // Shape x -> +z, extrusion -> -x; the bevelled block then spans x0..x1.
  g.rotateY(-Math.PI / 2);
  g.translate(x1 - bevel, 0, 0);
  return creased(g);
}

/** Centre height of the wheel arches: a little above the settled wheel centre (-0.51), so the springs can compress. */
export const ARCH_Y = -0.46;

/** Where a circle of radius r around (zc, cy) crosses the line y = foot: half-chord and the angle up from horizontal. */
function archFoot(r: number, foot: number, cy = ARCH_Y): { d: number; a: number } {
  const a = Math.asin(Math.min(1, Math.max(-1, (foot - cy) / r)));
  return { d: r * Math.cos(a), a };
}

/** Cut a wheel arch of radius r around (zc, cy) into a profile whose bottom edge is being drawn towards +z at y = foot. */
function cutArch(s: THREE.Shape, zc: number, r: number, foot: number, cy = ARCH_Y): void {
  const { d, a } = archFoot(r, foot, cy);
  s.lineTo(zc - d, foot);
  // Clockwise from the rear foot over the top to the front foot.
  s.absarc(zc, cy, r, Math.PI - a, a, true);
}

export interface Profile {
  /** Outline from the front bottom corner over the top to the rear bottom corner (z decreasing). */
  top: (s: THREE.Shape) => void;
  front: number;
  rear: number;
  /** Bottom edge height. */
  foot: number;
  /** Arch centres (wheel z) and radius before the bevel. */
  arches: readonly number[];
  archR: number;
  /** Arch centre height (default ARCH_Y, the car's). */
  archY?: number;
}

/**
 * Body side profile with the wheel arches cut out of its bottom edge, extruded from x0 to x1.
 * The outline runs over the top from the front to the rear, then forward along the bottom through
 * the arches.
 */
export function profileGeometry(p: Profile, x0: number, x1: number, bevel = 0.03): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(p.front, p.foot);
  p.top(s);
  s.lineTo(p.rear, p.foot);
  for (const zc of [...p.arches].sort((a, b) => a - b)) cutArch(s, zc, p.archR, p.foot, p.archY);
  s.lineTo(p.front, p.foot);
  return extrudeX(s, x0, x1, bevel, 12);
}

/** Arch-shaped fender (a half ring around (zc, cy) with its feet cut at y = foot) over a wheel. */
export function fenderGeometry(
  zc: number,
  rIn: number,
  rOut: number,
  foot: number,
  x0: number,
  x1: number,
  cy = ARCH_Y,
  bevel = 0.02,
): THREE.BufferGeometry {
  const o = archFoot(rOut, foot, cy);
  const i = archFoot(rIn, foot, cy);
  const s = new THREE.Shape();
  s.moveTo(zc + o.d, foot);
  s.absarc(zc, cy, rOut, o.a, Math.PI - o.a, false);
  s.lineTo(zc - i.d, foot);
  s.absarc(zc, cy, rIn, Math.PI - i.a, i.a, true);
  s.lineTo(zc + o.d, foot);
  return extrudeX(s, x0, x1, bevel, 12);
}

/**
 * Wing element spanning x from -span/2 to span/2: an inverted airfoil (rounded leading edge at +z,
 * curved underside) of the given chord and thickness, centred on the origin.
 */
export function wingGeometry(span: number, chord: number, thick: number): THREE.BufferGeometry {
  const c = chord / 2;
  const t = thick;
  const s = new THREE.Shape();
  s.moveTo(c, 0);
  s.bezierCurveTo(c, t * 0.45, c * 0.2, t * 0.5, -c, t * 0.18);
  s.lineTo(-c, t * 0.02);
  s.bezierCurveTo(c * 0.1, -t * 0.55, c, -t * 0.5, c, 0);
  return extrudeX(s, -span / 2, span / 2, Math.min(0.008, t * 0.15), 8);
}

/** Smooth tube through the points (open ends, so hide them inside other parts). */
export function tubeGeometry(points: readonly Vec3[], r: number, segments = 24, radial = 8): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, segments, r, radial, false);
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Straight round tube from a to b (build time only: it allocates). */
export function strut(mat: THREE.Material, a: Vec3, b: Vec3, r = 0.045, radial = 8): THREE.Mesh {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, radial), mat);
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  m.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(len));
  return m;
}

// ---- Wheels -----------------------------------------------------------------------------------

type Run = ReadonlyArray<readonly [number, number]>;

/**
 * Surface of revolution around y from runs of [radius, height] points. Each run is shaded smoothly;
 * the joins between runs are hard edges. Optional colour per run (vertex colours).
 */
function lathe(runs: readonly Run[], segments: number, colors?: readonly THREE.Color[]): THREE.BufferGeometry {
  const parts = runs.map((run, i) => {
    const g = new THREE.LatheGeometry(
      run.map(([r, y]) => new THREE.Vector2(r, y)),
      segments,
    );
    if (colors) {
      const c = colors[i];
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) col.set([c.r, c.g, c.b], v * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    return g;
  });
  return mergeParts(parts);
}

/** Position and normal only (plus colour if any), always indexed: one layout for mergeGeometries. */
function plain(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color']) if (src.attributes[k]) g.setAttribute(k, src.attributes[k].clone());
  if (src.index) g.setIndex(src.index.clone());
  else g.setIndex(Array.from({ length: src.attributes.position.count }, (_, i) => i));
  return g;
}

/** Merge parts into one indexed geometry. */
function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map(plain);
  const g = mergeGeometries(flat)!;
  flat.forEach((p) => p.dispose());
  parts.forEach((p) => p.dispose());
  return g;
}

/** Tyre colour when the tyre carries vertex colours (a sidewall band). */
export const RUBBER = 0x1a1c20;

/**
 * Tyre of width w around the x axis, outboard face at +x: rounded shoulders, a dark disc closing
 * the wheel on both sides (the rim's spokes sit in front of the outer one) and, with `band`, a
 * coloured stripe on the outer sidewall as vertex colours. The tread radius is exactly R. `shoulder`
 * is the shoulder radius (a bike tyre's is nearly half its width: a round crown).
 */
export function tyreGeometry(w: number, R = WHEEL_RADIUS, band?: THREE.ColorRepresentation, shoulder?: number): THREE.BufferGeometry {
  const h = w / 2;
  const s = Math.min(shoulder ?? Math.min(0.05, h / 3), h * 0.9);
  const bead = R * 0.68;
  const barrel = R * 0.62;
  const k = 1 - Math.SQRT1_2;
  const runs: Run[] = [
    [
      [0, -h * 0.84],
      [barrel, -h * 0.84],
    ],
    [
      [barrel, -h * 0.84],
      [bead, -h],
    ],
    [
      [bead, -h],
      [R - s, -h],
    ],
    [
      [R - s, -h],
      [R - s * k, -h + s * k],
      [R, -h + s],
      [R, h - s],
      [R - s * k, h - s * k],
      [R - s, h],
    ],
    [
      [R - s, h],
      [R * 0.9, h],
    ],
    // Sidewall band (plain rubber unless `band` is given).
    [
      [R * 0.9, h],
      [R * 0.84, h],
    ],
    [
      [R * 0.84, h],
      [bead, h],
    ],
    // Into the rim, then the dark disc behind the spokes.
    [
      [bead, h],
      [barrel, h * 0.1],
    ],
    [
      [barrel, h * 0.1],
      [0, h * 0.1],
    ],
  ];
  let colors: THREE.Color[] | undefined;
  if (band !== undefined) {
    const rubber = new THREE.Color(RUBBER);
    const b = new THREE.Color(band);
    colors = runs.map((_, i) => (i === 5 ? b : rubber));
  }
  return lathe(runs, 28, colors).rotateZ(-Math.PI / 2);
}

/**
 * Rim inside a tyre of width w, outboard face at +x: a recessed lip, the barrel, five dished spokes
 * and a hub, merged into one geometry that stays inside the tyre's width.
 */
export function rimGeometry(w: number, R = WHEEL_RADIUS, spokes = 5): THREE.BufferGeometry {
  const h = w / 2;
  const lip = h - 0.012;
  const barrel = R * 0.62;
  const parts: THREE.BufferGeometry[] = [
    lathe(
      [
        [
          [R * 0.69, lip],
          [barrel, lip],
        ],
        [
          [barrel, lip],
          [barrel, h * 0.1 + 0.002],
        ],
      ],
      28,
    ),
  ];
  const len = barrel - 0.03;
  // Dished: the outer end sits nearer the face than the hub, by at most 4 cm (long spokes dish less).
  const dish = Math.min(0.14, Math.asin(Math.min(1, 0.04 / (len + 0.02))));
  for (let i = 0; i < spokes; i++) {
    const g = roundedBoxGeometry(0.055, 0.035, len, 1, 0.012);
    g.translate(0, 0, len / 2 + 0.02).rotateX(-dish).translate(0, h - 0.06, 0).rotateY((i / spokes) * Math.PI * 2);
    parts.push(g);
  }
  parts.push(
    new THREE.CylinderGeometry(0.065, 0.07, 0.05, 12).translate(0, h - 0.065, 0),
    new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8).translate(0, h - 0.03, 0),
  );
  return mergeParts(parts).rotateZ(-Math.PI / 2);
}

// ---- Merging ----------------------------------------------------------------------------------

/**
 * Merge the meshes directly under `group` that share a material into one mesh per material, in
 * order of first appearance: a car body is one draw call per material instead of one per part.
 * Anything with children stays as it is.
 */
export function mergeByMaterial(group: THREE.Group): void {
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const o of [...group.children]) {
    if (!(o instanceof THREE.Mesh) || o.children.length) continue;
    const mat = o.material as THREE.Material;
    o.updateMatrix();
    const g = plain(o.geometry).applyMatrix4(o.matrix);
    if (o.matrix.determinant() < 0) {
      // A mirrored part: restore counter-clockwise front faces.
      const ix = g.index!;
      for (let i = 0; i < ix.count; i += 3) {
        const b = ix.getX(i + 1);
        ix.setX(i + 1, ix.getX(i + 2));
        ix.setX(i + 2, b);
      }
    }
    let list = buckets.get(mat);
    if (!list) buckets.set(mat, (list = []));
    list.push(g);
    group.remove(o);
    o.geometry.dispose();
  }
  for (const [mat, geos] of buckets) group.add(new THREE.Mesh(mergeParts(geos), mat));
}
