// The shipped realistic vehicle files (public/vehicles, built by scripts/build-vehicles.ts): only extensions
// the runtime loader handles and no physical materials, the wheel nodes the runtime looks for, the phone
// budget per vehicle (draw calls, vertices, triangles, texture size, bytes) and in total, a fit inside the
// class's visual envelope, and credits for every model. Reads the GLB JSON only (no three.js loader).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_PAINT, modelWheelNames, VEHICLE_MODELS } from '../src/core/vehicleModels';
import { vehicleSpec } from '../src/physics/vehicle';
import { fitTarget, fitVehicle } from '../src/render/vehicleFit';
import { ALLOWED_EXTENSIONS, emptyBox, glbStats, KEPT_MATERIAL_EXTENSIONS, meshBox, nodeBox, parseGlb, worldMatrices } from '../scripts/vehiclePrep';

const DIR = join(__dirname, '..', 'public');
/** Per vehicle on a phone (the procedural car's budget is 20 meshes and 20k vertices; models get a little more). */
const BUDGET = { drawCalls: 20, vertices: 25000, triangles: 26000, bytes: 3_500_000, texture: 1024 };
const TOTAL_BYTES = 10_000_000;

const load = (file: string) => parseGlb(readFileSync(join(DIR, file)));

describe('realistic vehicle files', () => {
  it('stay inside the total download budget', () => {
    const total = VEHICLE_MODELS.reduce((n, m) => n + statSync(join(DIR, m.file)).size, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_BYTES);
  });

  it('are credited in public/vehicles/CREDITS.md with the license line verbatim', () => {
    const md = readFileSync(join(DIR, 'vehicles', 'CREDITS.md'), 'utf8');
    expect(md).toMatch(/NOT covered by the project's MIT license/);
    for (const m of VEHICLE_MODELS) {
      expect(md).toContain(m.credit.line);
      expect(md).toContain(m.credit.changes);
      expect(md).toContain(m.file.replace('vehicles/', ''));
    }
  });

  describe.each(VEHICLE_MODELS.map((m) => [m.id, m] as const))('%s', (_, model) => {
    it('exists as a GLB', () => {
      expect(existsSync(join(DIR, model.file))).toBe(true);
      expect(readFileSync(join(DIR, model.file)).readUInt32LE(0)).toBe(0x46546c67);
      expect(statSync(join(DIR, model.file)).size).toBeLessThanOrEqual(BUDGET.bytes);
    });

    it('uses only extensions the loader supports, and no physical-material extensions', () => {
      const { json } = load(model.file);
      for (const e of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) expect(ALLOWED_EXTENSIONS).toContain(e);
      for (const m of json.materials ?? []) for (const k of Object.keys(m.extensions ?? {})) expect(KEPT_MATERIAL_EXTENSIONS).toContain(k);
      // Meshopt geometry and KTX2 textures, as the build makes them.
      expect(json.extensionsUsed).toContain('EXT_meshopt_compression');
      expect(json.extensionsUsed).toContain('KHR_texture_basisu');
    });

    it('fits the phone budget', () => {
      const { json, bin } = load(model.file);
      const s = glbStats(json, bin);
      expect(s.drawCalls).toBeLessThanOrEqual(BUDGET.drawCalls);
      expect(s.vertices).toBeLessThanOrEqual(BUDGET.vertices);
      expect(s.triangles).toBeLessThanOrEqual(BUDGET.triangles);
      expect(s.textures.length).toBeGreaterThan(0);
      for (const t of s.textures) {
        expect(t.width).toBeLessThanOrEqual(BUDGET.texture);
        expect(t.height).toBeLessThanOrEqual(BUDGET.texture);
      }
      for (const im of json.images ?? []) {
        // Every image is KTX2 (its identifier starts with 0xAB 'KTX 20').
        const bv = json.bufferViews![im.bufferView!];
        expect(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + 7).toString('latin1')).toBe('«KTX 20');
      }
    });

    it('names its wheels (and its paint when the profile colour tints it)', () => {
      const { json, bin } = load(model.file);
      const s = glbStats(json, bin);
      for (const n of modelWheelNames(model.cls)) expect(s.nodeNames).toContain(n);
      if (model.tintable) expect(s.materialNames).toContain(MODEL_PAINT);
    });

    it('fits its class: front wheels ahead, the body inside the visual envelope, tyres on the ground', () => {
      const { json } = load(model.file);
      const world = worldMatrices(json);
      const byName = (n: string) => [...world.keys()].find((i) => json.nodes![i].name === n)!;
      const wheels = modelWheelNames(model.cls).map((n) => {
        const b = nodeBox(json, world, byName(n));
        return { cx: (b.min[0] + b.max[0]) / 2, cy: (b.min[1] + b.max[1]) / 2, cz: (b.min[2] + b.max[2]) / 2, r: Math.max(b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 };
      });
      const all = emptyBox();
      for (const i of world.keys()) if (json.nodes![i].mesh !== undefined) meshBox(json, json.nodes![i].mesh!, world.get(i)!, all);
      const t = fitTarget(model.cls, vehicleSpec(model.cls));
      const v = (a: number[]) => ({ x: a[0], y: a[1], z: a[2] });
      const fit = fitVehicle(wheels, model.cls === 'bike' ? 1 : 2, v(all.min), v(all.max), t);
      const zLo = all.min[2] * fit.scale + fit.offset.z;
      const zHi = all.max[2] * fit.scale + fit.offset.z;
      expect(zHi).toBeLessThanOrEqual(t.front + 1e-6);
      expect(zLo).toBeGreaterThanOrEqual(t.rear - 1e-6);
      expect((all.max[0] - all.min[0]) * fit.scale).toBeLessThanOrEqual(2 * t.halfWidth + 1e-6);
      // Built in the canonical frame: the tyres touch y = 0 and are near the size of real ones.
      for (const w of wheels) expect(Math.abs(w.cy - w.r)).toBeLessThan(0.02);
      for (const w of fit.wheels) {
        expect(w.r).toBeGreaterThan(0.25);
        expect(w.r).toBeLessThan(0.6);
        // At rest every tyre stands on the road (y = -rideHeight).
        expect(w.y - w.r).toBeCloseTo(-t.rideHeight, 1);
      }
      // Not shrunk or stretched beyond reason by the fit.
      expect(fit.scale).toBeGreaterThan(0.7);
      expect(fit.scale).toBeLessThan(1.4);
    });
  });
});
