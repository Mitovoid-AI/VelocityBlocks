// The realistic model catalogue (src/core/vehicleModels.ts) and its credits (src/ui/credits.ts).

import { describe, expect, it } from 'vitest';
import { CAR_BODIES, isCarBody } from '../src/core/cars';
import { creditGroups, isModelId, modelsOf, modelWheelNames, VEHICLE_MODELS, vehicleModel } from '../src/core/vehicleModels';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { creditsHtml } from '../src/ui/credits';

describe('vehicle models', () => {
  it('have unique ids, apart from the procedural car bodies', () => {
    const ids = VEHICLE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isModelId(id)).toBe(true);
      expect(vehicleModel(id).id).toBe(id);
      // CAR_BODIES stays procedural only (buildCar never sees a model id).
      expect(isCarBody(id)).toBe(false);
    }
    expect(CAR_BODIES.map((b) => b.id)).toEqual(['racer', 'buggy', 'muscle', 'formula']);
    expect(isModelId('racer')).toBe(false);
    expect(isModelId(undefined)).toBe(false);
  });

  it('give every class a realistic choice, three for the car', () => {
    expect(modelsOf('car').map((m) => m.id)).toEqual(['sport', 'coupe', 'sedan']);
    for (const cls of VEHICLE_CLASSES) expect(modelsOf(cls).length).toBeGreaterThan(0);
    expect(modelWheelNames('bike')).toHaveLength(2);
    expect(modelWheelNames('truck')).toHaveLength(4);
  });

  it('draw their picker icons inside the 64x24 box', () => {
    for (const m of VEHICLE_MODELS) {
      expect(m.icon, m.id).toMatch(/^M[\d. LZM]+$/);
      const nums = m.icon.match(/[\d.]+/g)!.map(Number);
      nums.forEach((n, i) => expect(n, m.id).toBeLessThanOrEqual(i % 2 ? 24 : 64));
      for (const [cx, cy, r] of m.wheels) {
        expect(cx - r).toBeGreaterThanOrEqual(0);
        expect(cx + r).toBeLessThanOrEqual(64);
        expect(cy + r).toBeLessThanOrEqual(24);
      }
    }
  });

  it('carry a complete CC BY 4.0 credit each', () => {
    for (const m of VEHICLE_MODELS) {
      const c = m.credit;
      expect(c.license).toBe('CC BY 4.0');
      for (const k of ['title', 'author', 'authorUrl', 'sourceUrl', 'licenseUrl', 'line', 'changes'] as const) expect(c[k].length, `${m.id} ${k}`).toBeGreaterThan(0);
      expect(c.line).toContain(`"${c.title}"`);
      expect(c.line).toContain(c.sourceUrl);
      expect(c.line).toContain(c.author);
      expect(c.line).toContain('CC-BY-4.0');
    }
    // The three cars come from one pack: credited once.
    expect(creditGroups()).toHaveLength(3);
  });
});

describe('credits screen', () => {
  it('lists every source as plain text: title, author, source, license and changes, no links', () => {
    const html = creditsHtml();
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/href=/);
    for (const { credit } of creditGroups()) {
      for (const s of [credit.author, credit.sourceUrl, credit.licenseUrl, credit.license]) expect(html).toContain(s);
    }
    // Apostrophes in titles are escaped.
    expect(html).toContain('LCT 3000 &#39;95');
  });
});
