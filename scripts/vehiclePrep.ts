// Pure helpers for scripts/build-vehicles.ts and tests/vehicleAssets.test.ts: glTF JSON and buffer reading,
// node transforms, the canonical vehicle frame (+z forward, +y up, +x left, ground at y = 0), wheel and axle
// finding, splitting a wheel out of a single mesh, PNG decoding/encoding for the paint whitening, and GLB
// statistics. Node built-ins only (zlib), so the validator test runs without three.js or gltfpack.

import { deflateSync, inflateSync } from 'node:zlib';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A glTF document as parsed JSON: only the fields these helpers read are typed. */
export interface Gltf {
  asset: { version: string; [k: string]: unknown };
  scene?: number;
  scenes?: { nodes?: number[]; name?: string }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number; extensions?: any }[];
  buffers?: { uri?: string; byteLength: number; extensions?: any }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; sampler?: number; extensions?: any }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number; name?: string }[];
  samplers?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}
export interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: any;
}
export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: any;
}
export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
export interface TextureInfo {
  index: number;
  texCoord?: number;
  extensions?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: TextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: TextureInfo;
  };
  normalTexture?: TextureInfo;
  occlusionTexture?: TextureInfo;
  emissiveTexture?: TextureInfo;
  emissiveFactor?: number[];
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: Record<string, unknown>;
  extras?: unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type V3 = [number, number, number];
/** Column-major 4x4, as glTF stores node matrices. */
export type M4 = number[];

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

export function apply(m: M4, p: readonly number[]): V3 {
  return [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]) as V3;
}

/** A node's local matrix from its matrix or TRS. */
export function nodeLocal(n: GltfNode): M4 {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] *= s[c];
  return m;
}

/** World matrix of every node reachable from the default scene. */
export function worldMatrices(g: Gltf): Map<number, M4> {
  const out = new Map<number, M4>();
  const walk = (i: number, parent: M4) => {
    const w = mul(parent, nodeLocal(g.nodes![i]));
    out.set(i, w);
    for (const c of g.nodes![i].children ?? []) walk(c, w);
  };
  for (const r of g.scenes?.[g.scene ?? 0]?.nodes ?? []) walk(r, IDENTITY);
  return out;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** An accessor's values as numbers (normalised integers scaled to 0..1 or -1..1), `count * components` long. */
export function readAccessor(g: Gltf, bins: readonly Buffer[], index: number): Float64Array {
  const a = g.accessors![index];
  const n = COMPONENTS[a.type];
  const out = new Float64Array(a.count * n);
  if (a.bufferView === undefined) return out;
  const bv = g.bufferViews![a.bufferView];
  const bin = bins[bv.buffer];
  const size = BYTES[a.componentType];
  const stride = bv.byteStride || n * size;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let k = 0; k < a.count; k++) {
    for (let j = 0; j < n; j++) {
      const o = base + k * stride + j * size;
      let v: number;
      switch (a.componentType) {
        case 5126: v = bin.readFloatLE(o); break;
        case 5125: v = bin.readUInt32LE(o); break;
        case 5123: v = bin.readUInt16LE(o); if (a.normalized) v /= 65535; break;
        case 5122: v = bin.readInt16LE(o); if (a.normalized) v = Math.max(-1, v / 32767); break;
        case 5121: v = bin.readUInt8(o); if (a.normalized) v /= 255; break;
        default: v = bin.readInt8(o); if (a.normalized) v = Math.max(-1, v / 127);
      }
      out[k * n + j] = v;
    }
  }
  return out;
}

/** Triangle vertex indices of a primitive (an unindexed one counts its vertices). */
export function primitiveIndices(g: Gltf, bins: readonly Buffer[], p: GltfPrimitive): Uint32Array {
  if (p.indices === undefined) return Uint32Array.from({ length: g.accessors![p.attributes.POSITION].count }, (_, i) => i);
  return Uint32Array.from(readAccessor(g, bins, p.indices));
}

/** A primitive's positions transformed by m, flattened xyz. */
export function primitivePositions(g: Gltf, bins: readonly Buffer[], p: GltfPrimitive, m: M4): Float64Array {
  const src = readAccessor(g, bins, p.attributes.POSITION);
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) out.set(apply(m, [src[i], src[i + 1], src[i + 2]]), i);
  return out;
}

export interface Box {
  min: V3;
  max: V3;
}

export const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

export function growBox(b: Box, p: readonly number[]): Box {
  for (let i = 0; i < 3; i++) {
    b.min[i] = Math.min(b.min[i], p[i]);
    b.max[i] = Math.max(b.max[i], p[i]);
  }
  return b;
}

export const boxCentre = (b: Box): V3 => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2) as V3;

/** Box of a mesh under matrix m, from its accessors' min/max corners (no buffer reads). */
export function meshBox(g: Gltf, mesh: number, m: M4, into: Box = emptyBox()): Box {
  for (const p of g.meshes![mesh].primitives) {
    const a = g.accessors![p.attributes.POSITION];
    if (!a.min || !a.max) continue;
    for (const x of [a.min[0], a.max[0]]) for (const y of [a.min[1], a.max[1]]) for (const z of [a.min[2], a.max[2]]) growBox(into, apply(m, [x, y, z]));
  }
  return into;
}

/** Box of a node's own mesh and every mesh below it, in world space. */
export function nodeBox(g: Gltf, world: Map<number, M4>, node: number, into: Box = emptyBox()): Box {
  const n = g.nodes![node];
  if (n.mesh !== undefined) meshBox(g, n.mesh, world.get(node)!, into);
  for (const c of n.children ?? []) nodeBox(g, world, c, into);
  return into;
}

/**
 * The canonical vehicle frame from world space (y up): `forward` (x, z) becomes +z, the driver's left +x,
 * and `origin` (between the axles, on the ground) the origin.
 */
export function canonicalMatrix(forward: readonly [number, number], origin: V3): M4 {
  const l = Math.hypot(forward[0], forward[1]);
  const fx = forward[0] / l;
  const fz = forward[1] / l;
  // Rows: left = up x forward = (fz, 0, -fx), up, forward.
  const r: M4 = [fz, 0, fx, 0, 0, 1, 0, 0, -fx, 0, fz, 0, 0, 0, 0, 1];
  const t = apply(r, origin);
  r[12] = -t[0];
  r[13] = -t[1];
  r[14] = -t[2];
  return r;
}

/**
 * Pair four wheel centres (x, z) into two axles: the pairing with the shortest total in-pair distance
 * (track widths are shorter than wheelbases and diagonals). Returns the index pairs and their midpoints.
 */
export function pairAxles(c: readonly (readonly [number, number])[]): { axles: [number, number][]; mids: [number, number][] } {
  const pairings: [number, number][][] = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];
  const d = (a: number, b: number) => Math.hypot(c[a][0] - c[b][0], c[a][1] - c[b][1]);
  let best = pairings[0];
  for (const p of pairings) if (d(...p[0]) + d(...p[1]) < d(...best[0]) + d(...best[1])) best = p;
  const mid = ([a, b]: [number, number]): [number, number] => [(c[a][0] + c[b][0]) / 2, (c[a][1] + c[b][1]) / 2];
  return { axles: best, mids: best.map(mid) };
}

/**
 * Order four wheel centres (world x, z) as FL, FR, RL, RR. `frontNear` is any world point nearer the front
 * axle than the rear one. Returns the order and the forward direction (rear axle to front axle).
 */
export function orderWheels(
  c: readonly (readonly [number, number])[],
  frontNear: readonly [number, number],
): { order: [number, number, number, number]; forward: [number, number] } {
  const { axles, mids } = pairAxles(c);
  const dist = (m: [number, number]) => Math.hypot(m[0] - frontNear[0], m[1] - frontNear[1]);
  const fi = dist(mids[0]) <= dist(mids[1]) ? 0 : 1;
  const front = axles[fi];
  const rear = axles[1 - fi];
  const forward: [number, number] = [mids[fi][0] - mids[1 - fi][0], mids[fi][1] - mids[1 - fi][1]];
  // Left of forward (x, z) is (fz, -fx): the wheel further along it is the left one.
  const leftOf = (i: number) => c[i][0] * forward[1] - c[i][1] * forward[0];
  const lr = (p: [number, number]): [number, number] => (leftOf(p[0]) >= leftOf(p[1]) ? p : [p[1], p[0]]);
  const f = lr(front);
  const r = lr(rear);
  return { order: [f[0], f[1], r[0], r[1]], forward };
}

/** A wheel found in a single mesh: axle centre (canonical frame), tyre radius and half width. */
export interface FoundWheel {
  centre: V3;
  r: number;
  halfW: number;
}

/**
 * Find the two wheels of a bike drawn as one mesh (canonical frame, positions flattened xyz). The tyres are
 * what touches the ground: the lowest vertices form a front and a rear cluster; each tyre's radius is half its
 * length at axle height, and its width the tread's.
 */
export function findBikeWheels(pos: Float64Array): [FoundWheel, FoundWheel] {
  let minY = Infinity;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  const contacts: V3[] = [];
  for (let i = 0; i < pos.length; i += 3) if (pos[i + 1] < minY + 0.012) contacts.push([pos[i], pos[i + 1], pos[i + 2]]);
  const zs = contacts.map((p) => p[2]).sort((a, b) => a - b);
  // The widest gap in contact z splits front from rear.
  let gap = 0;
  let split = 0;
  for (let i = 1; i < zs.length; i++) if (zs[i] - zs[i - 1] > gap) [gap, split] = [zs[i] - zs[i - 1], (zs[i] + zs[i - 1]) / 2];
  if (gap < 0.5) throw new Error('bike: could not find two separate tyre contacts');
  const find = (front: boolean): FoundWheel => {
    const pts = contacts.filter((p) => (p[2] > split) === front);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz0 = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    // The tyre's front-most and rear-most points at axle height (only the tyre reaches out there; the
    // fork and fenders sit inside or above it): their half distance is the radius, their middle the axle.
    let r = 0.33;
    let cz = cz0;
    for (let it = 0; it < 4; it++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        if (Math.abs(pos[i] - cx) > 0.06 || Math.abs(pos[i + 1] - minY - r) > 0.02 || Math.abs(pos[i + 2] - cz) > r + 0.08) continue;
        lo = Math.min(lo, pos[i + 2]);
        hi = Math.max(hi, pos[i + 2]);
      }
      if (!(hi > lo)) throw new Error('bike: could not measure a tyre');
      r = (hi - lo) / 2;
      cz = (hi + lo) / 2;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      // The bottom of the tyre only (tread and sidewall bulge): shocks, swingarm and fenders are higher up.
      if (Math.abs(pos[i] - cx) > 0.2 || pos[i + 1] > minY + 0.35 * r) continue;
      const d = Math.hypot(pos[i + 2] - cz, pos[i + 1] - (minY + r));
      if (d > r - 0.09 && d < r + 0.006) {
        lo = Math.min(lo, pos[i]);
        hi = Math.max(hi, pos[i]);
      }
    }
    return { centre: [(lo + hi) / 2, minY + r, cz], r, halfW: (hi - lo) / 2 };
  };
  return [find(true), find(false)];
}

/** True when the point lies in the wheel's cylinder (about x), with a small margin. */
export function inWheel(w: FoundWheel, x: number, y: number, z: number, margin = 0.008): boolean {
  return Math.abs(x - w.centre[0]) <= w.halfW + margin && Math.hypot(y - w.centre[1], z - w.centre[2]) <= w.r + margin;
}

/**
 * Split a triangle list into the triangles wholly inside each wheel's cylinder and the rest. A triangle
 * straddling the boundary (a fork leg, the swingarm end) stays with the body, so nothing static spins.
 */
export function splitWheels(pos: Float64Array, idx: Uint32Array, wheels: readonly FoundWheel[]): { body: number[]; wheels: number[][] } {
  const body: number[] = [];
  const out = wheels.map(() => [] as number[]);
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    const w = wheels.findIndex((wh) => tri.every((v) => inWheel(wh, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])));
    (w < 0 ? body : out[w]).push(...tri);
  }
  return { body, wheels: out };
}

// ---- PNG (8-bit grey, grey+alpha, RGB, RGBA; no interlace), for the paint whitening -----------------

export interface Image {
  width: number;
  height: number;
  /** 1, 2, 3 or 4 channels, 8-bit, rows packed. */
  channels: number;
  data: Uint8Array;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 4: 2, 2: 3, 6: 4 };

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let o = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString('latin1', o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      depth = d[8];
      type = d[9];
      interlace = d[12];
    } else if (kind === 'IDAT') idat.push(d);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  const channels = CHANNELS[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const row = width * channels;
  const data = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (row + 1)];
    const src = y * (row + 1) + 1;
    const dst = y * row;
    for (let x = 0; x < row; x++) {
      const a = x >= channels ? data[dst + x - channels] : 0;
      const b = y ? data[dst - row + x] : 0;
      const c = x >= channels && y ? data[dst - row + x - channels] : 0;
      let p: number;
      switch (f) {
        case 0: p = 0; break;
        case 1: p = a; break;
        case 2: p = b; break;
        case 3: p = (a + b) >> 1; break;
        case 4: {
          const q = a + b - c;
          const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      data[dst + x] = (raw[src + x] + p) & 255;
    }
  }
  return { width, height, channels, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: Image): Buffer {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[img.channels as 1 | 2 | 3 | 4];
  const row = img.width * img.channels;
  const raw = Buffer.alloc((row + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (row + 1)] = 0;
    raw.set(img.data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  }
  const chunk = (kind: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(kind, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Paint brightness reference: the 90th percentile of the brightest channel over strongly coloured pixels. */
export function paintLevel(img: Image): number {
  const hist = new Array<number>(256).fill(0);
  let n = 0;
  const ch = img.channels;
  if (ch < 3) return 255;
  for (let i = 0; i < img.data.length; i += ch) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const mx = Math.max(r, g, b);
    if (mx < 40 || (mx - Math.min(r, g, b)) / mx < 0.4) continue;
    hist[mx]++;
    n++;
  }
  if (!n) return 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= n * 0.9) return Math.max(40, v);
  return 255;
}

/**
 * Turn a baked paint colour into a tintable grey: coloured pixels become their brightest channel scaled so
 * the paint reads near white (the material colour then sets it), keeping the baked shading; neutral pixels
 * (black trim, grey grilles, chrome) keep their brightness. A smooth ramp on saturation avoids seams.
 */
export function whitenPaint(img: Image, target = 235): Image {
  const ch = img.channels;
  if (ch < 3) return img;
  const k = target / paintLevel(img);
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b);
    const sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    const t = Math.min(1, Math.max(0, (sat - 0.15) / 0.25));
    const s = t * t * (3 - 2 * t);
    // Neutral: luminance; paint: brightest channel scaled to the target.
    const neutral = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const v = Math.min(255, Math.round(neutral + (mx * k - neutral) * s));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return { ...img, data };
}

// ---- GLB reading and statistics (the shipped files) --------------------------------------------------

export function parseGlb(buf: Buffer): { json: Gltf; bin: Buffer } {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB: first chunk is not JSON');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)) as Gltf;
  const o = 20 + jsonLen;
  const bin = o + 8 <= buf.length && buf.readUInt32LE(o + 4) === 0x004e4942 ? buf.subarray(o + 8, o + 8 + buf.readUInt32LE(o)) : Buffer.alloc(0);
  return { json, bin };
}

export interface GlbStats {
  triangles: number;
  vertices: number;
  drawCalls: number;
  materials: number;
  textures: { width: number; height: number; bytes: number }[];
  nodeNames: string[];
  materialNames: string[];
}

/** Triangles, vertices and draw calls as drawn (per mesh instance), and the KTX2 images' sizes. */
export function glbStats(json: Gltf, bin: Buffer): GlbStats {
  let triangles = 0, vertices = 0, drawCalls = 0;
  const world = worldMatrices(json);
  for (const i of world.keys()) {
    const n = json.nodes![i];
    if (n.mesh === undefined) continue;
    const seen = new Set<number>();
    for (const p of json.meshes![n.mesh].primitives) {
      drawCalls++;
      const pos = p.attributes.POSITION;
      const count = json.accessors![pos].count;
      triangles += (p.indices !== undefined ? json.accessors![p.indices].count : count) / 3;
      if (!seen.has(pos)) vertices += count;
      seen.add(pos);
    }
  }
  const textures = (json.images ?? []).map((im) => {
    const bv = json.bufferViews![im.bufferView!];
    const o = bv.byteOffset ?? 0;
    return { width: bin.readUInt32LE(o + 20), height: bin.readUInt32LE(o + 24), bytes: bv.byteLength };
  });
  return {
    triangles,
    vertices,
    drawCalls,
    materials: json.materials?.length ?? 0,
    textures,
    nodeNames: (json.nodes ?? []).map((n) => n.name ?? '').filter(Boolean),
    materialNames: (json.materials ?? []).map((m) => m.name ?? '').filter(Boolean),
  };
}

/** Extensions the runtime loader supports (GLTFLoader with MeshoptDecoder and KTX2Loader): nothing else may be used. */
export const ALLOWED_EXTENSIONS: readonly string[] = [
  'EXT_meshopt_compression',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'KHR_materials_emissive_strength',
];

/** Material extensions kept by the prep (everything else, clearcoat, specular, transmission..., is stripped). */
export const KEPT_MATERIAL_EXTENSIONS: readonly string[] = ['KHR_materials_emissive_strength'];

/** Drop every material extension but the kept ones, and say which extensions remain in use. */
export function stripMaterialExtensions(g: Gltf): void {
  const used = new Set<string>();
  for (const m of g.materials ?? []) {
    if (m.extensions) {
      for (const k of Object.keys(m.extensions)) if (!KEPT_MATERIAL_EXTENSIONS.includes(k)) delete m.extensions[k];
      for (const k of Object.keys(m.extensions)) used.add(k);
      if (!Object.keys(m.extensions).length) delete m.extensions;
    }
    const infos = [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture];
    for (const t of infos) for (const k of Object.keys(t?.extensions ?? {})) used.add(k);
  }
  if (used.size) g.extensionsUsed = [...used];
  else delete g.extensionsUsed;
  delete g.extensionsRequired;
}

/** The texture slots of a material. */
function textureInfos(m: GltfMaterial): TextureInfo[] {
  const p = m.pbrMetallicRoughness;
  return [p?.baseColorTexture, p?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture].filter((t): t is TextureInfo => !!t);
}

/**
 * Keep only the meshes the scene's nodes use, and the materials, textures, images and samplers those reach
 * (re-indexed in order of first use). gltfpack would otherwise encode every image of a 10-car pack.
 */
export function pruneUnused(g: Gltf): void {
  const remap = <T>(list: T[] | undefined, used: number[]): { list: T[]; map: Map<number, number> } => {
    const map = new Map(used.map((u, i) => [u, i] as const));
    return { list: used.map((u) => list![u]), map };
  };
  const firstUse = (xs: (number | undefined)[]): number[] => [...new Set(xs.filter((x): x is number => x !== undefined))];

  const meshes = remap(g.meshes, firstUse((g.nodes ?? []).map((n) => n.mesh)));
  for (const n of g.nodes ?? []) if (n.mesh !== undefined) n.mesh = meshes.map.get(n.mesh);
  g.meshes = meshes.list;

  const mats = remap(g.materials, firstUse(g.meshes.flatMap((m) => m.primitives.map((p) => p.material))));
  g.meshes = g.meshes.map((m) => ({ ...m, primitives: m.primitives.map((p) => (p.material === undefined ? p : { ...p, material: mats.map.get(p.material) })) }));
  g.materials = mats.list.map((m) => JSON.parse(JSON.stringify(m)) as GltfMaterial);

  const texs = remap(g.textures, firstUse(g.materials.flatMap((m) => textureInfos(m).map((t) => t.index))));
  for (const m of g.materials) for (const t of textureInfos(m)) t.index = texs.map.get(t.index)!;
  g.textures = texs.list.map((t) => ({ ...t }));

  const imgs = remap(g.images, firstUse(g.textures.map((t) => t.source)));
  const samps = remap(g.samplers, firstUse(g.textures.map((t) => t.sampler)));
  for (const t of g.textures) {
    if (t.source !== undefined) t.source = imgs.map.get(t.source);
    if (t.sampler !== undefined) t.sampler = samps.map.get(t.sampler);
  }
  g.images = imgs.list;
  if (g.samplers) g.samplers = samps.list;
  for (const k of ['materials', 'textures', 'images', 'samplers'] as const) if (!(g[k] as unknown[] | undefined)?.length) delete g[k];
}

// ---- Baking: geometry into the canonical frame, merged by material -----------------------------------

/** One source primitive placed by `matrix`, optionally with another material or a subset of its triangles. */
export interface PlacedPrim {
  prim: GltfPrimitive;
  matrix: M4;
  material?: number;
  indices?: Uint32Array;
}

/** A node of the baked scene: named ones (wheels, lamps) stay apart; unnamed ones merge by material. */
export interface BakeGroup {
  name?: string;
  prims: PlacedPrim[];
}

/** The attributes a material can read (the rest, extra UV sets and colours, are dropped). */
export const BAKED_ATTRIBUTES = ['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0'] as const;
const SIZE: Record<string, number> = { POSITION: 3, NORMAL: 3, TANGENT: 4, TEXCOORD_0: 2 };
const TYPE: Record<number, string> = { 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };

/** Inverse transpose of a matrix's upper 3x3 (for normals), column-major 3x3. */
function normalMatrix(m: M4): number[] {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  // Columns of the 3x3: (a b c), (d e f), (g h i). Cofactor matrix = det * inverse transpose.
  const co = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
  // Only the direction matters (normals are renormalised), but a mirroring matrix must not flip them.
  const s = Math.sign(a * co[0] + d * co[3] + g * co[6]) || 1;
  return co.map((v) => v * s);
}

export const det3 = (m: M4): number => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

/**
 * Bake every group's primitives into one buffer: positions, normals and tangents transformed by their
 * matrices (a mirroring matrix flips the winding and the tangent sign), unnamed groups merged per material and
 * attribute set. Returns meshes, nodes (one per output mesh, named when the group is) and the binary data.
 */
export function bakeGroups(
  g: Gltf,
  bins: readonly Buffer[],
  groups: readonly BakeGroup[],
): { meshes: { primitives: GltfPrimitive[] }[]; nodes: GltfNode[]; accessors: GltfAccessor[]; bufferViews: NonNullable<Gltf['bufferViews']>; data: Buffer } {
  // Output meshes: one per named group, one per (material, attributes) over the unnamed ones.
  interface Out {
    name?: string;
    byKey: Map<string, PlacedPrim[]>;
  }
  const outs: Out[] = [];
  const shared: Out = { byKey: new Map() };
  const keyOf = (p: PlacedPrim) => `${p.material ?? p.prim.material}|${BAKED_ATTRIBUTES.filter((a) => p.prim.attributes[a] !== undefined).join(',')}`;
  for (const grp of groups) {
    const o = grp.name ? { name: grp.name, byKey: new Map() } : shared;
    if (grp.name) outs.push(o);
    for (const p of grp.prims) {
      const k = keyOf(p);
      if (!o.byKey.has(k)) o.byKey.set(k, []);
      o.byKey.get(k)!.push(p);
    }
  }
  if (shared.byKey.size) outs.unshift(shared);

  const chunks: Buffer[] = [];
  let len = 0;
  const accessors: GltfAccessor[] = [];
  const bufferViews: NonNullable<Gltf['bufferViews']> = [];
  const push = (arr: Float32Array | Uint32Array, type: string, componentType: number, target: number, minmax?: { min: number[]; max: number[] }): number => {
    const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length, target });
    chunks.push(b);
    len += b.length;
    const n = componentType === 5125 ? arr.length : arr.length / SIZE_OF_TYPE[type];
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: n, type, ...(minmax ?? {}) });
    return accessors.length - 1;
  };

  const meshes: { primitives: GltfPrimitive[] }[] = [];
  const nodes: GltfNode[] = [];
  for (const o of outs) {
    const primitives: GltfPrimitive[] = [];
    for (const [, list] of o.byKey) {
      const attrs = BAKED_ATTRIBUTES.filter((a) => list[0].prim.attributes[a] !== undefined);
      const data: Record<string, number[]> = Object.fromEntries(attrs.map((a) => [a, [] as number[]]));
      const idx: number[] = [];
      let base = 0;
      for (const p of list) {
        const m = p.matrix;
        const nm = normalMatrix(m);
        const flip = det3(m) < 0;
        let count = 0;
        for (const a of attrs) {
          const src = readAccessor(g, bins, p.prim.attributes[a]);
          const n = SIZE[a];
          count = src.length / n;
          const dst = data[a];
          for (let i = 0; i < src.length; i += n) {
            if (a === 'POSITION') dst.push(...apply(m, [src[i], src[i + 1], src[i + 2]]));
            else if (a === 'NORMAL' || a === 'TANGENT') {
              const M3 = a === 'NORMAL' ? nm : [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
              const x = M3[0] * src[i] + M3[3] * src[i + 1] + M3[6] * src[i + 2];
              const y = M3[1] * src[i] + M3[4] * src[i + 1] + M3[7] * src[i + 2];
              const z = M3[2] * src[i] + M3[5] * src[i + 1] + M3[8] * src[i + 2];
              const l = Math.hypot(x, y, z) || 1;
              dst.push(x / l, y / l, z / l);
              if (a === 'TANGENT') dst.push(flip ? -src[i + 3] : src[i + 3]);
            } else for (let j = 0; j < n; j++) dst.push(src[i + j]);
          }
        }
        const tri = p.indices ?? primitiveIndices(g, bins, p.prim);
        for (let t = 0; t < tri.length; t += 3) {
          if (flip) idx.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
          else idx.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
        }
        base += count;
      }
      if (!idx.length) continue;
      const attributes: Record<string, number> = {};
      for (const a of attrs) {
        const arr = Float32Array.from(data[a]);
        let mm: { min: number[]; max: number[] } | undefined;
        if (a === 'POSITION') {
          const b = emptyBox();
          for (let i = 0; i < arr.length; i += 3) growBox(b, [arr[i], arr[i + 1], arr[i + 2]]);
          mm = { min: [...b.min], max: [...b.max] };
        }
        attributes[a] = push(arr, TYPE[SIZE[a]], 5126, 34962, mm);
      }
      const mat = list[0].material ?? list[0].prim.material;
      primitives.push({ attributes, indices: push(Uint32Array.from(idx), 'SCALAR', 5125, 34963), ...(mat !== undefined ? { material: mat } : {}) });
    }
    if (!primitives.length) continue;
    meshes.push({ primitives });
    nodes.push({ mesh: meshes.length - 1, ...(o.name ? { name: o.name } : {}) });
  }
  return { meshes, nodes, accessors, bufferViews, data: Buffer.concat(chunks) };
}

const SIZE_OF_TYPE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
