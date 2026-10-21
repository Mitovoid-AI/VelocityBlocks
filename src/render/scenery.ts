// Scenery for the Desert and Water themes, outside the perimeter wall: cacti, rocks and mesas in the desert;
// palms, rocks, wooden piers, a beach and the sea on the coast. Low-poly, vertex-coloured, instanced or merged
// (a few draw calls each), counts from the tier's tree budget so Low stays light. Deterministic.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Extents } from './stadium';
import { seeded } from './texUtil';

/** Paint a geometry one colour (non-indexed, no uvs), for merged vertex-coloured models. */
export function paint(src: THREE.BufferGeometry, hex: number | THREE.Color): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const c = hex instanceof THREE.Color ? hex : new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

/** A saguaro: a ribbed trunk and two arms (about 7 m tall at scale 1). */
export function cactusGeometry(): THREE.BufferGeometry {
  const green = 0x4f7a3a;
  const dark = 0x3e6630;
  const arm = (side: number, y: number, h: number) => [
    paint(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 6).rotateZ(Math.PI / 2).translate(side * 0.8, y, 0), dark),
    paint(new THREE.CylinderGeometry(0.3, 0.32, h, 6).translate(side * 1.35, y + h / 2 - 0.15, 0), green),
    paint(new THREE.SphereGeometry(0.3, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(side * 1.35, y + h - 0.15, 0), green),
  ];
  return merged([
    paint(new THREE.CylinderGeometry(0.42, 0.5, 6.4, 7).translate(0, 3.2, 0), green),
    paint(new THREE.SphereGeometry(0.42, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 6.4, 0), green),
    ...arm(1, 2.6, 2.2),
    ...arm(-1, 3.4, 1.7),
  ]);
}

/** A faceted boulder (about 2 m across at scale 1), coloured per instance. */
export function rockGeometry(): THREE.BufferGeometry {
  return paint(new THREE.IcosahedronGeometry(1.2, 0).scale(1.3, 0.75, 1).translate(0, 0.5, 0), 0xffffff);
}

/** A palm: a leaning, segmented trunk and a crown of drooping fronds (about 9 m tall at scale 1). */
export function palmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const segs = 6;
  let x = 0;
  let y = 0;
  for (let i = 0; i < segs; i++) {
    const h = 1.5;
    const lean = 0.05 + i * 0.045;
    const g = new THREE.CylinderGeometry(0.2 - i * 0.012, 0.26 - i * 0.012, h, 6).translate(0, h / 2, 0).rotateZ(-lean).translate(x, y, 0);
    parts.push(paint(g, i % 2 ? 0x8a6a45 : 0x7a5c3a));
    x += Math.sin(lean) * h;
    y += Math.cos(lean) * h * 0.98;
  }
  const leaf = 0x3f8f3a;
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    // A frond: a flattened cone pointing out and down from the crown.
    const f = new THREE.ConeGeometry(0.55, 3.6, 4, 1)
      .scale(1, 1, 0.18)
      .translate(0, 1.8, 0)
      .rotateZ(-Math.PI / 2 + 0.55)
      .rotateY(a)
      .translate(x, y, 0);
    parts.push(paint(f, k % 2 ? leaf : 0x4fa046));
  }
  parts.push(paint(new THREE.IcosahedronGeometry(0.45, 0).translate(x, y - 0.2, 0), 0x6a4a2a));
  return merged(parts);
}

/** Flat-topped mesas with layered red rock, merged: a ring between `r0` and `r1` metres from the centre. */
export function mesaGeometry(b: Extents, count: number, r0: number, r1: number, seed = 5): THREE.BufferGeometry {
  const rnd = seeded(seed);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const bands = [0xb5653a, 0xc97b45, 0xa45534, 0xd08d55, 0x9a4c30].map((h) => new THREE.Color(h));
  const parts: THREE.BufferGeometry[] = [];
  for (let n = 0; n < count; n++) {
    const a = rnd() * Math.PI * 2;
    const r = r0 + rnd() * (r1 - r0);
    const rad = 60 + rnd() * 140;
    const h = 50 + rnd() * 110;
    const sides = 7 + Math.floor(rnd() * 4);
    const layers = 3 + Math.floor(rnd() * 3);
    const px = cx + Math.cos(a) * r;
    const pz = cz + Math.sin(a) * r;
    for (let l = 0; l < layers; l++) {
      const t0 = l / layers;
      const t1 = (l + 1) / layers;
      // Slightly stepped walls: each stratum a little narrower than the one under it.
      const g = new THREE.CylinderGeometry(rad * (1 - t1 * 0.18), rad * (1 - t0 * 0.18), h / layers, sides, 1, l < layers - 1)
        .translate(0, h * (t0 + t1) / 2, 0)
        .scale(1, 1, 0.7 + 0.3 * ((n * 7) % 3) / 2)
        .rotateY(rnd() * Math.PI)
        .translate(px, -2, pz);
      parts.push(paint(g, bands[(n + l) % bands.length]));
    }
  }
  return merged(parts);
}

/** Wooden piers from the beach out over the sea: decks on posts, merged. */
export function pierGeometry(b: Extents, beach: number, count: number, seed = 9): THREE.BufferGeometry {
  const rnd = seeded(seed);
  const parts: THREE.BufferGeometry[] = [];
  const wood = 0x8a6440;
  const post = 0x5a4028;
  for (let n = 0; n < count; n++) {
    // A side (0..3) and a spot along it; the pier starts on the beach and runs 70..140 m out.
    const side = n % 4;
    const t = 0.15 + rnd() * 0.7;
    const len = 70 + rnd() * 70;
    const start = beach - 30;
    const m = new THREE.Matrix4();
    const along = side < 2 ? b.x0 + (b.x1 - b.x0) * t : b.z0 + (b.z1 - b.z0) * t;
    const out = [b.z0 - start, b.z1 + start, b.x0 - start, b.x1 + start][side];
    const dir = [-1, 1, -1, 1][side];
    const geos: THREE.BufferGeometry[] = [paint(new THREE.BoxGeometry(5, 0.4, len).translate(0, 1.4, len / 2), wood)];
    for (let s = 6; s < len; s += 12) {
      for (const x of [-2.2, 2.2]) geos.push(paint(new THREE.BoxGeometry(0.45, 4, 0.45).translate(x, -0.6, s), post));
    }
    geos.push(paint(new THREE.BoxGeometry(5.6, 1.2, 0.3).translate(0, 2.1, len), wood));
    const g = merged(geos);
    if (side < 2) m.makeRotationY(dir > 0 ? 0 : Math.PI).setPosition(along, 0, out);
    else m.makeRotationY(dir > 0 ? Math.PI / 2 : -Math.PI / 2).setPosition(out, 0, along);
    parts.push(g.applyMatrix4(m));
  }
  return merged(parts);
}

/**
 * Instances of `geo` scattered in the band `near`..`far` metres outside the extents, with a scale range and a
 * per-instance tint around `tint`. Deterministic.
 */
export function scatter(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  b: Extents,
  count: number,
  near: number,
  far: number,
  seed: number,
  scale: [number, number],
  tint: THREE.Color = new THREE.Color(1, 1, 1),
  spread = 0.25,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  const rnd = seeded(seed);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  const c = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 40; tries++) {
    const x = b.x0 - far + rnd() * (b.x1 - b.x0 + 2 * far);
    const z = b.z0 - far + rnd() * (b.z1 - b.z0 + 2 * far);
    if (x > b.x0 - near && x < b.x1 + near && z > b.z0 - near && z < b.z1 + near) continue;
    const k = scale[0] + rnd() * (scale[1] - scale[0]);
    q.setFromAxisAngle(Y, rnd() * Math.PI * 2);
    m.compose(t.set(x, 0, z), q, s.set(k, k * (0.85 + rnd() * 0.3), k));
    mesh.setMatrixAt(n, m);
    const v = 1 - spread / 2 + rnd() * spread;
    mesh.setColorAt(n, c.setRGB(tint.r * v, tint.g * v, tint.b * v));
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** A flat frame between two rectangles (inner extents grown by `a`, outer by `b`), at height y. */
export function frameGeometry(e: Extents, a: number, bOut: number, y: number): THREE.BufferGeometry {
  const X0 = e.x0 - bOut, X1 = e.x1 + bOut, Z0 = e.z0 - bOut, Z1 = e.z1 + bOut;
  const x0 = e.x0 - a, x1 = e.x1 + a, z0 = e.z0 - a, z1 = e.z1 + a;
  const pos: number[] = [];
  const quad = (ax: number, az: number, bx: number, bz: number) => {
    pos.push(ax, y, bz, bx, y, bz, bx, y, az, ax, y, bz, bx, y, az, ax, y, az);
  };
  quad(X0, Z0, X1, z0);
  quad(X0, z1, X1, Z1);
  quad(X0, z0, x0, z1);
  quad(x1, z0, X1, z1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
