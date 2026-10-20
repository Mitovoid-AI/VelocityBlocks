// Builds the realistic vehicle models (src/core/vehicleModels.ts) from their downloaded sources into
// public/vehicles/<id>.glb, and writes public/vehicles/CREDITS.md. Run it from the project root:
//   npx esbuild scripts/build-vehicles.ts --bundle --platform=node --format=esm --outfile=<tmp>/bv.mjs && node <tmp>/bv.mjs [id...]
// Sources (never committed): the unzipped Sketchfab glTF downloads in ../assets-src/<folder>/ (scene.gltf,
// scene.bin, textures/, license.txt); override with VB_ASSETS_SRC. gltfpack 1.3: ../tools/gltfpack/gltfpack.exe,
// or GLTFPACK.
//
// Step 1, prep (plain JSON and binary edits, in a temp folder): pick the vehicle's meshes out of the source and
// bake them into the canonical frame (+z forward, +x left, +y up, the ground at y = 0, the origin between the
// axles), name the wheel nodes vb_wheel_* (FL, FR, RL, RR; the bike's front and rear), the lamp meshes vb_lamp*,
// the paint material vb_paint and the window glass vb_glass, clear every other name (so gltfpack merges the
// rest by material), strip material extensions (clearcoat, specular...: no MeshPhysicalMaterial at runtime),
// darken the glass and whiten baked paint so the profile colour tints it. The bike's wheels are one mesh with
// the frame: its triangles inside each tyre's cylinder are split out.
// Step 2, gltfpack: meshopt compression, KTX2 textures (ETC1S colour <= 1024 px, UASTC normal maps <= 512 px),
// optional simplification. Step 3: check the output against the phone budget (tests/vehicleAssets.test.ts
// checks the shipped files again).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { creditGroups, MODEL_GLASS, MODEL_LAMP, MODEL_PAINT, VEHICLE_MODELS, type ModelId } from '../src/core/vehicleModels';
import {
  bakeGroups,
  canonicalMatrix,
  decodePng,
  encodePng,
  findBikeWheels,
  glbStats,
  mul,
  nodeBox,
  orderWheels,
  parseGlb,
  primitiveIndices,
  primitivePositions,
  pruneUnused,
  splitWheels,
  stripMaterialExtensions,
  whitenPaint,
  worldMatrices,
  type Gltf,
  type GltfMaterial,
  type BakeGroup,
  type PlacedPrim,
  type M4,
} from './vehiclePrep';

const ROOT = process.cwd();
const SRC = resolve(process.env.VB_ASSETS_SRC ?? join(ROOT, '..', 'assets-src'));
const GLTFPACK = process.env.GLTFPACK ?? join(ROOT, '..', 'tools', 'gltfpack', 'gltfpack.exe');
const OUT = join(ROOT, 'public', 'vehicles');
const TMP = join(tmpdir(), 'vb-build-vehicles');

/** The phone budget per vehicle (tests/carBodies.test.ts: 20 meshes, 20k vertices for a procedural car). */
export const BUDGET = { drawCalls: 20, vertices: 25000, triangles: 26000, bytes: 3_500_000, texture: 1024, total: 10_000_000 };

const GLASS: Partial<GltfMaterial> = {
  // Dark and nearly opaque, like the procedural glass: the interiors are not shipped.
  pbrMetallicRoughness: { baseColorFactor: [0.05, 0.07, 0.09, 0.88], metallicFactor: 0.5, roughnessFactor: 0.08 },
  alphaMode: 'BLEND',
  doubleSided: false,
};

interface Prep {
  /** Named groups (wheels, lamps) stay apart; the rest is merged by material. */
  parts: BakeGroup[];
  /** Images to replace (index -> PNG bytes). */
  images?: Map<number, Buffer>;
  simplify?: number;
}

interface Source {
  dir: string;
  g: Gltf;
  bins: Buffer[];
  world: Map<number, M4>;
}

function loadSource(folder: string): Source {
  const dir = join(SRC, folder);
  const g = JSON.parse(readFileSync(join(dir, 'scene.gltf'), 'utf8')) as Gltf;
  const bins = (g.buffers ?? []).map((b) => readFileSync(join(dir, decodeURIComponent(b.uri!))));
  return { dir, g, bins, world: worldMatrices(g) };
}

const findNodes = (g: Gltf, name: string): number[] => g.nodes!.flatMap((n, i) => (n.name === name ? [i] : []));

/** Every mesh node at or below `node`. */
function meshNodes(g: Gltf, node: number): number[] {
  const n = g.nodes![node];
  return [...(n.mesh !== undefined ? [node] : []), ...(n.children ?? []).flatMap((c) => meshNodes(g, c))];
}

/** Clear a material's name (merged freely by gltfpack) or set one of ours. */
function nameMaterial(g: Gltf, i: number, name?: string): void {
  if (name) g.materials![i].name = name;
  else delete g.materials![i].name;
}

/** A copy of a material (appended): returns its index. */
function addMaterial(g: Gltf, from: number, patch: Partial<GltfMaterial>): number {
  const m = { ...JSON.parse(JSON.stringify(g.materials![from])), ...patch } as GltfMaterial;
  m.pbrMetallicRoughness = { ...(g.materials![from].pbrMetallicRoughness ?? {}), ...(patch.pbrMetallicRoughness ?? {}) };
  if (patch.pbrMetallicRoughness && !('baseColorTexture' in patch.pbrMetallicRoughness)) {
    // Glass is a flat tint: drop the atlas so the window is one even colour.
    delete m.pbrMetallicRoughness.baseColorTexture;
  }
  g.materials!.push(m);
  return g.materials!.length - 1;
}

/** A source mesh's primitives placed by `matrix`, optionally with another material. */
function placed(g: Gltf, mesh: number, matrix: M4, material?: number): PlacedPrim[] {
  return g.meshes![mesh].primitives.map((prim) => ({ prim, matrix, material }));
}

/** Image index of a material's base colour texture. */
const baseImage = (g: Gltf, mat: number): number => g.textures![g.materials![mat].pbrMetallicRoughness!.baseColorTexture!.index].source!;

// ---- The car pack: one body node and four sibling wheel nodes per car ------------------------------------

function prepCar(s: Source, bodyName: string, frontNear: [number, number]): Prep {
  const { g, world } = s;
  const [body] = findNodes(g, bodyName);
  if (body === undefined) throw new Error(`no node "${bodyName}"`);
  const bodies = g.nodes!.flatMap((n, i) => (/ body$/i.test(n.name ?? '') ? [i] : []));
  const centreXZ = (i: number) => {
    const b = nodeBox(g, world, i);
    return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2] as [number, number];
  };
  const bodyC = new Map(bodies.map((i) => [i, centreXZ(i)]));
  // Wheel names repeat across cars: a wheel belongs to the nearest body.
  const wheels = g.nodes!.flatMap((n, i) => {
    // The wheel nodes themselves (Wheel_H, Wheel_H001), not their mesh children (Wheel_H_Wheel_0).
    if (!/^wheel_[a-z]\d*$/i.test(n.name ?? '')) return [];
    const c = centreXZ(i);
    let best = -1;
    let bd = Infinity;
    for (const [b, bc] of bodyC) {
      const d = Math.hypot(bc[0] - c[0], bc[1] - c[1]);
      if (d < bd) [best, bd] = [b, d];
    }
    return best === body ? [i] : [];
  });
  if (wheels.length !== 4) throw new Error(`${bodyName}: found ${wheels.length} wheels, expected 4`);
  const centres = wheels.map(centreXZ);
  const { order, forward } = orderWheels(centres, frontNear);
  let ground = Infinity;
  for (const w of wheels) ground = Math.min(ground, nodeBox(g, world, w).min[1]);
  const mid: [number, number] = [centres.reduce((a, c) => a + c[0], 0) / 4, centres.reduce((a, c) => a + c[1], 0) / 4];
  const C = canonicalMatrix(forward, [mid[0], ground, mid[1]]);

  const parts: BakeGroup[] = [];
  const images = new Map<number, Buffer>();
  for (const mn of meshNodes(g, body)) {
    const n = g.nodes![mn];
    const mesh = g.meshes![n.mesh!];
    const mat = mesh.primitives[0].material!;
    const role = /_glass_/i.test(n.name ?? '') ? 'glass' : /_optics_/i.test(n.name ?? '') ? 'optics' : 'body';
    if (role === 'glass') {
      parts.push({ prims: placed(g, n.mesh!, mul(C, world.get(mn)!), addMaterial(g, mat, { ...GLASS, name: MODEL_GLASS })) });
      continue;
    }
    if (role === 'body') {
      nameMaterial(g, mat, MODEL_PAINT);
      const img = baseImage(g, mat);
      images.set(img, encodePng(whitenPaint(decodePng(readFileSync(join(s.dir, g.images![img].uri!))))));
    } else nameMaterial(g, mat);
    parts.push({ prims: placed(g, n.mesh!, mul(C, world.get(mn)!)), name: role === 'optics' ? MODEL_LAMP : undefined });
  }
  const names = ['vb_wheel_fl', 'vb_wheel_fr', 'vb_wheel_rl', 'vb_wheel_rr'];
  order.forEach((wi, k) => {
    const ms = meshNodes(g, wheels[wi]);
    if (ms.length !== 1) throw new Error(`${bodyName}: wheel ${g.nodes![wheels[wi]].name} has ${ms.length} meshes`);
    const n = g.nodes![ms[0]];
    for (const p of g.meshes![n.mesh!].primitives) nameMaterial(g, p.material!);
    parts.push({ prims: placed(g, n.mesh!, mul(C, world.get(ms[0])!)), name: names[k] });
  });
  return { parts, images };
}

// ---- The Cafe Racer: one node, two meshes, one material; the wheels are split out by position ------------

function prepBike(s: Source): Prep {
  const { g, bins, world } = s;
  const nodes = g.nodes!.flatMap((n, i) => (n.mesh !== undefined ? [i] : []));
  // Front is +x in the source (headlamp and fork; checked in a render).
  const C0 = canonicalMatrix([1, 0], [0, 0, 0]);
  const meshes = nodes.map((i) => {
    const m = mul(C0, world.get(i)!);
    const p = g.meshes![g.nodes![i].mesh!].primitives[0];
    return { node: i, prim: p, m, pos: primitivePositions(g, bins, p, m), idx: primitiveIndices(g, bins, p) };
  });
  const all = new Float64Array(meshes.reduce((n, x) => n + x.pos.length, 0));
  let o = 0;
  for (const x of meshes) {
    all.set(x.pos, o);
    o += x.pos.length;
  }
  const wheels = findBikeWheels(all);
  const [f, r] = wheels;
  console.log(`  cafe: front wheel r ${f.r.toFixed(3)} at z ${f.centre[2].toFixed(3)}, rear r ${r.r.toFixed(3)} at z ${r.centre[2].toFixed(3)}, wheelbase ${(f.centre[2] - r.centre[2]).toFixed(3)}`);
  // Origin between the axles on the ground.
  const ground = Math.min(f.centre[1] - f.r, r.centre[1] - r.r);
  const shift: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -(f.centre[0] + r.centre[0]) / 2, -ground, -(f.centre[2] + r.centre[2]) / 2, 1];

  const m = mul(shift, meshes[0].m);
  for (const x of meshes) if (x.m.some((v, i) => Math.abs(v - meshes[0].m[i]) > 1e-9)) throw new Error('cafe: meshes have different transforms');
  const body: PlacedPrim[] = [];
  const wheelPrims: PlacedPrim[][] = [[], []];
  let stats = '';
  for (const x of meshes) {
    const split = splitWheels(x.pos, x.idx, wheels);
    const prim = (list: number[]): PlacedPrim => ({ prim: x.prim, matrix: m, indices: Uint32Array.from(list) });
    if (split.body.length) body.push(prim(split.body));
    split.wheels.forEach((w, k) => w.length && wheelPrims[k].push(prim(w)));
    stats += ` mesh ${x.node}: body ${split.body.length / 3}, front ${split.wheels[0].length / 3}, rear ${split.wheels[1].length / 3};`;
  }
  console.log(`  cafe triangles:${stats}`);
  for (const mat of g.materials!) delete mat.name;
  return {
    parts: [{ prims: body }, { prims: wheelPrims[0], name: 'vb_wheel_f' }, { prims: wheelPrims[1], name: 'vb_wheel_r' }],
    // About 95k triangles in the source: down to the phone budget.
    simplify: 0.2,
  };
}

// ---- The LCT 3000 '95: named parts, front is +x ------------------------------------------------------------

const LCT_DROP = ['Interior', 'Steering_Wheel', 'Body_Badges', 'Numberplate_front', 'Numberplate_rear'];
const LCT_WHEELS: Record<string, string> = { WheelStock_FL: 'vb_wheel_fl', WheelStock_FR: 'vb_wheel_fr', WheelStock_RL: 'vb_wheel_rl', WheelStock_RR: 'vb_wheel_rr' };
const LCT_LAMPS: Record<string, string> = { Headlights: `${MODEL_LAMP}_head`, Brakelights: `${MODEL_LAMP}_tail` };
const LCT_WINDOWS = ['Windshield', 'Glass_Passenger', 'Glass_Driver'];

function prepTruck(s: Source): Prep {
  const { g, world } = s;
  const prefix = 'LCT300095_';
  // The named parts are the root node's children (their mesh nodes below carry the same prefix).
  const rootNode = g.nodes!.find((n) => n.name === 'RootNode')!;
  const top = (rootNode.children ?? []).filter((i) => g.nodes![i].name?.startsWith(prefix));
  const part = (i: number) => g.nodes![i].name!.slice(prefix.length);
  // Wheel centres decide the frame: forward is +x (cab and headlamps), the ground under the tyres.
  const wheelBoxes = top.filter((i) => LCT_WHEELS[part(i)]).map((i) => nodeBox(g, world, i));
  if (wheelBoxes.length !== 4) throw new Error(`lct3000: found ${wheelBoxes.length} wheels`);
  const ground = Math.min(...wheelBoxes.map((b) => b.min[1]));
  const cx = wheelBoxes.reduce((a, b) => a + (b.min[0] + b.max[0]) / 2, 0) / 4;
  const cz = wheelBoxes.reduce((a, b) => a + (b.min[2] + b.max[2]) / 2, 0) / 4;
  const C = canonicalMatrix([1, 0], [cx, ground, cz]);

  const paint = g.materials!.findIndex((m) => m.name === 'lct3000_Bodymat');
  const glassSrc = g.materials!.findIndex((m) => m.name === 'UCB_Lights_and_Glass_Transperent');
  const tyre = g.materials!.findIndex((m) => m.name === 'RB1c_Tire_1k');
  g.materials!.forEach((_, i) => nameMaterial(g, i, i === paint ? MODEL_PAINT : undefined));
  // The paint colour comes from the profile; the flake texture (tiled by KHR_texture_transform) stays.
  g.materials![paint].pbrMetallicRoughness!.baseColorFactor = [1, 1, 1, 1];
  // Rubber is not metal.
  g.materials![tyre].pbrMetallicRoughness!.metallicFactor = 0;
  const glass = addMaterial(g, glassSrc, { ...GLASS, name: MODEL_GLASS });

  const parts: BakeGroup[] = [];
  for (const i of top) {
    const p = part(i);
    if (LCT_DROP.includes(p)) continue;
    for (const mn of meshNodes(g, i)) {
      const mesh = g.nodes![mn].mesh!;
      const matrix = mul(C, world.get(mn)!);
      if (LCT_WINDOWS.includes(p)) parts.push({ prims: placed(g, mesh, matrix, glass) });
      else parts.push({ prims: placed(g, mesh, matrix), name: LCT_WHEELS[p] ?? LCT_LAMPS[p] });
    }
  }
  return { parts };
}

// ---- Writing the prep glTF and running gltfpack --------------------------------------------------------

function writePrep(s: Source, prep: Prep, dir: string): string {
  const g = s.g;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const baked = bakeGroups(g, s.bins, prep.parts);
  const out: Gltf = {
    asset: { version: '2.0', generator: 'velocity-blocks scripts/build-vehicles.ts' },
    scene: 0,
    scenes: [{ nodes: baked.nodes.map((_, i) => i) }],
    nodes: baked.nodes,
    meshes: baked.meshes,
    accessors: baked.accessors,
    bufferViews: baked.bufferViews,
    buffers: [{ uri: 'geometry.bin', byteLength: baked.data.length }],
    materials: g.materials,
    textures: g.textures,
    // Replaced images first (indices are the source's), then drop everything the vehicle does not use.
    images: (g.images ?? []).map((im, i) => {
      const png = prep.images?.get(i);
      if (!png) return im;
      const uri = `vb_paint_${i}.png`;
      writeFileSync(join(dir, uri), png);
      return { uri, mimeType: 'image/png' };
    }),
    samplers: g.samplers,
    extensionsUsed: g.extensionsUsed,
  };
  writeFileSync(join(dir, 'geometry.bin'), baked.data);
  pruneUnused(out);
  stripMaterialExtensions(out);
  // Material extras are not needed.
  for (const m of out.materials ?? []) delete m.extras;
  for (const im of out.images ?? []) {
    if (!im.uri || existsSync(join(dir, im.uri))) continue;
    mkdirSync(dirname(join(dir, decodeURIComponent(im.uri))), { recursive: true });
    copyFileSync(join(s.dir, decodeURIComponent(im.uri)), join(dir, decodeURIComponent(im.uri)));
  }
  const file = join(dir, 'prep.gltf');
  writeFileSync(file, JSON.stringify(out));
  return file;
}

function pack(input: string, output: string, simplify?: number): void {
  const args = ['-i', input, '-o', output, '-cc', '-kn', '-km', '-tc', '-tu', 'normal', '-tl', '1024', '-tl', 'normal', '512', '-tl', 'attrib', '512'];
  if (simplify) args.push('-si', String(simplify));
  const r = spawnSync(GLTFPACK, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gltfpack failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
  const warn = `${r.stdout}${r.stderr}`.trim();
  if (warn) console.log(`  gltfpack: ${warn.split('\n').join('\n  gltfpack: ')}`);
}

interface Job {
  id: ModelId;
  folder: string;
  prep: (s: Source) => Prep;
}

const JOBS: Job[] = [
  // frontNear: a world point (x, z) nearer the front axle than the rear, read off a render of the pack.
  { id: 'sport', folder: 'generic_passenger_car_pack', prep: (s) => prepCar(s, 'Sport body', [3.3, -4.6]) },
  { id: 'coupe', folder: 'generic_passenger_car_pack', prep: (s) => prepCar(s, 'Coupe Body', [-4.9, 1.6]) },
  { id: 'sedan', folder: 'generic_passenger_car_pack', prep: (s) => prepCar(s, 'Sedan Body', [0, 5.4]) },
  { id: 'cafe', folder: 'cafe_racer', prep: prepBike },
  { id: 'lct3000', folder: 'lct_3000_95_-_low_poly_model', prep: prepTruck },
];

function creditsMd(): string {
  const lines = [
    '# Vehicle model credits',
    '',
    'The files in this folder are NOT covered by the project\'s MIT license. Each keeps its own license, listed below.',
    'They are built by scripts/build-vehicles.ts from the authors\' Sketchfab downloads.',
    '',
  ];
  for (const { credit: c, models } of creditGroups()) {
    lines.push(`## ${c.title}`, '');
    lines.push(`- Used for: ${models.map((m) => `${m.name} (${m.file.replace('vehicles/', '')})`).join(', ')}`);
    lines.push(`- Author: ${c.author} (${c.authorUrl})`);
    lines.push(`- Source: ${c.sourceUrl}`);
    lines.push(`- License: ${c.license} (${c.licenseUrl})`);
    lines.push(`- Attribution: ${c.line}`);
    lines.push(`- Changes: ${c.changes}`, '');
  }
  return lines.join('\n');
}

function main(): void {
  if (!existsSync(GLTFPACK)) throw new Error(`gltfpack not found at ${GLTFPACK} (set GLTFPACK)`);
  const only = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  const rows: string[] = [];
  let failed = false;
  for (const job of JOBS) {
    if (only.length && !only.includes(job.id)) continue;
    const model = VEHICLE_MODELS.find((m) => m.id === job.id)!;
    console.log(`${job.id}: preparing`);
    const s = loadSource(job.folder);
    const prep = job.prep(s);
    const input = writePrep(s, prep, join(TMP, job.id));
    const output = join(ROOT, 'public', model.file);
    mkdirSync(dirname(output), { recursive: true });
    pack(input, output, prep.simplify);
    const { json, bin } = parseGlb(readFileSync(output));
    const st = glbStats(json, bin);
    const bytes = statSync(output).size;
    const over: string[] = [];
    if (st.drawCalls > BUDGET.drawCalls) over.push('draw calls');
    if (st.vertices > BUDGET.vertices) over.push('vertices');
    if (st.triangles > BUDGET.triangles) over.push('triangles');
    if (bytes > BUDGET.bytes) over.push('size');
    if (st.textures.some((t) => t.width > BUDGET.texture || t.height > BUDGET.texture)) over.push('texture size');
    if (over.length) failed = true;
    rows.push(
      `${job.id.padEnd(8)} ${String(st.triangles).padStart(6)} tris ${String(st.vertices).padStart(6)} verts ${String(st.drawCalls).padStart(3)} draws ` +
        `${String(st.textures.length).padStart(2)} tex ${(bytes / 1e6).toFixed(2)} MB${over.length ? `  OVER BUDGET: ${over.join(', ')}` : ''}`,
    );
  }
  writeFileSync(join(OUT, 'CREDITS.md'), creditsMd());
  console.log(rows.join('\n'));
  if (failed) {
    console.error('Over budget: see above.');
    process.exit(1);
  }
}

main();
