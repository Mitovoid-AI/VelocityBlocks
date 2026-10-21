// Realistic vehicle models (third-party, CC BY 4.0), the "Realistic" look next to the procedural
// "Classic" vehicles. One list for the runtime loader, the profile picker, the in-game credits and
// scripts/build-vehicles.ts. The procedural car bodies stay in cars.ts (CAR_BODIES), apart from these.
// Dependency-free, like cars.ts: storage, the UI and node tests import it without three.js.

import type { IconWheel } from './cars';
import type { VehicleClass } from './vehicles';

export type ModelId = 'sport' | 'coupe' | 'sedan' | 'cafe' | 'lct3000';

/** Who made a model and on what terms: shown as plain text in Settings > Credits (no external links). */
export interface AssetCredit {
  /** The source's own title. */
  readonly title: string;
  readonly author: string;
  readonly authorUrl: string;
  readonly sourceUrl: string;
  readonly license: 'CC BY 4.0';
  readonly licenseUrl: string;
  /** The attribution line from the license.txt shipped with the download, verbatim. */
  readonly line: string;
  /** What was changed (CC BY 4.0 asks for it). */
  readonly changes: string;
}

export interface VehicleModel {
  readonly id: ModelId;
  readonly name: string;
  readonly cls: VehicleClass;
  /** Path under public/, loaded relative to the page ('./vehicles/x.glb'). */
  readonly file: string;
  readonly blurb: string;
  /** Picker icon: a 64x24 SVG path, nose to the right, and its wheels. */
  readonly icon: string;
  readonly wheels: readonly IconWheel[];
  /**
   * The paint is a texture the build whitened (or a plain colour), so the profile colour tints it. False:
   * the factory colours stay and only the rider wears the profile colour.
   */
  readonly tintable: boolean;
  readonly credit: AssetCredit;
  /** Needs the Full Game (app/fullGame.ts); a locked model falls back to the Classic look. */
  readonly premium: boolean;
}

const CC_BY = 'http://creativecommons.org/licenses/by/4.0/';

const CAR_PACK: AssetCredit = {
  title: 'Generic passenger car pack',
  author: 'Comrade1280',
  authorUrl: 'https://sketchfab.com/comrade1280',
  sourceUrl: 'https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5',
  license: 'CC BY 4.0',
  licenseUrl: CC_BY,
  line:
    'This work is based on "Generic passenger car pack" (https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5) by Comrade1280 (https://sketchfab.com/comrade1280) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
  changes:
    'Three of the ten cars (Sport, Coupe, Sedan) taken out of the pack, re-oriented and rescaled; paint textures turned grey so the game can colour them; glass darkened; textures resized to 1024 px and converted to KTX2; meshes meshopt-compressed.',
};

export const VEHICLE_MODELS: readonly VehicleModel[] = [
  {
    id: 'sport',
    name: 'Sport',
    cls: 'car',
    file: 'vehicles/sport.glb',
    blurb: 'Mid-engine supercar',
    icon: 'M3 17 L4 13 L10 12 L22 9 L30 6 L40 6 L48 10 L58 12 L61 15 L61 17 Z',
    wheels: [
      [15, 19, 5],
      [48, 19, 5],
    ],
    tintable: true,
    credit: CAR_PACK,
    premium: true,
  },
  {
    id: 'coupe',
    name: 'Coupe',
    cls: 'car',
    file: 'vehicles/coupe.glb',
    blurb: 'Two-door coupe',
    icon: 'M3 17 L3 12 L14 11 L22 6 L36 6 L44 11 L59 12 L61 17 Z',
    wheels: [
      [15, 19, 5],
      [48, 19, 5],
    ],
    tintable: true,
    credit: CAR_PACK,
    premium: true,
  },
  {
    id: 'sedan',
    name: 'Sedan',
    cls: 'car',
    file: 'vehicles/sedan.glb',
    blurb: 'Four-door saloon',
    icon: 'M3 17 L3 11 L13 10 L20 4 L40 4 L47 10 L60 11 L61 17 Z',
    wheels: [
      [15, 19, 5],
      [48, 19, 5],
    ],
    tintable: true,
    credit: CAR_PACK,
    premium: true,
  },
  {
    id: 'cafe',
    name: 'Cafe Racer',
    cls: 'bike',
    file: 'vehicles/cafe.glb',
    blurb: 'Classic cafe racer',
    icon: 'M10 12 L20 10 L26 8 L40 8 L46 6 L52 4 L55 6 L52 11 L44 14 L22 14 Z',
    wheels: [
      [13, 18, 5.5],
      [51, 18, 5.5],
    ],
    tintable: false,
    premium: true,
    credit: {
      title: 'Cafe Racer',
      author: 'Milin Andrei',
      authorUrl: 'https://sketchfab.com/milinam2002',
      sourceUrl: 'https://sketchfab.com/3d-models/cafe-racer-c02dec85ac0541b8ab6dd56098706b50',
      license: 'CC BY 4.0',
      licenseUrl: CC_BY,
      line:
        'This work is based on "Cafe Racer" (https://sketchfab.com/3d-models/cafe-racer-c02dec85ac0541b8ab6dd56098706b50) by Milin Andrei (https://sketchfab.com/milinam2002) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
      changes:
        'Re-oriented and rescaled; front and rear wheels split out of the body so they can turn; meshes simplified and meshopt-compressed; textures resized (1024 px colour, 512 px normal map) and converted to KTX2. The rider is the game\'s own.',
    },
  },
  {
    id: 'lct3000',
    name: "LCT 3000 '95",
    cls: 'truck',
    file: 'vehicles/lct3000.glb',
    blurb: 'Cab-over box truck',
    icon: 'M3 4 L44 4 L44 17 L3 17 Z M46 6 L56 6 L61 11 L61 17 L46 17 Z',
    wheels: [
      [14, 19, 4],
      [52, 19, 4],
    ],
    tintable: true,
    premium: true,
    credit: {
      title: "LCT 3000 '95 - Low poly model",
      author: 'Daniel Zhabotinsky',
      authorUrl: 'https://sketchfab.com/DanielZhabotinsky',
      sourceUrl: 'https://sketchfab.com/3d-models/lct-3000-95-low-poly-model-663a0953c038434a918cb85725c88ffa',
      license: 'CC BY 4.0',
      licenseUrl: CC_BY,
      line:
        'This work is based on "LCT 3000 \'95 - Low poly model" (https://sketchfab.com/3d-models/lct-3000-95-low-poly-model-663a0953c038434a918cb85725c88ffa) by Daniel Zhabotinsky (https://sketchfab.com/DanielZhabotinsky) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
      changes:
        'Re-oriented and rescaled; interior, steering wheel, badges and number plates removed; clearcoat and specular material extensions removed; window glass darkened; textures resized to 1024 px and converted to KTX2; meshes meshopt-compressed.',
    },
  },
];

export const DEFAULT_CAR_MODEL: ModelId = 'sport';

export function isModelId(v: unknown): v is ModelId {
  return VEHICLE_MODELS.some((m) => m.id === v);
}

export function vehicleModel(id: ModelId): VehicleModel {
  return VEHICLE_MODELS.find((m) => m.id === id)!;
}

/** The realistic models of a class, in picker order. */
export function modelsOf(cls: VehicleClass): readonly VehicleModel[] {
  return VEHICLE_MODELS.filter((m) => m.cls === cls);
}

/** Each distinct source once (several cars come from one pack), with the models made from it, for the credits. */
export function creditGroups(): { credit: AssetCredit; models: readonly VehicleModel[] }[] {
  const out: { credit: AssetCredit; models: VehicleModel[] }[] = [];
  for (const m of VEHICLE_MODELS) {
    const g = out.find((x) => x.credit.sourceUrl === m.credit.sourceUrl);
    if (g) g.models.push(m);
    else out.push({ credit: m.credit, models: [m] });
  }
  return out;
}

/** Wheel node names in a model file, in physics order: FL, FR, RL, RR (the bike: front, rear). */
export function modelWheelNames(cls: VehicleClass): readonly string[] {
  return cls === 'bike' ? ['vb_wheel_f', 'vb_wheel_r'] : ['vb_wheel_fl', 'vb_wheel_fr', 'vb_wheel_rl', 'vb_wheel_rr'];
}

/** Material and node names the runtime looks for: the tinted paint, the dark glass, and lamp meshes (node prefix). */
export const MODEL_PAINT = 'vb_paint';
export const MODEL_GLASS = 'vb_glass';
export const MODEL_LAMP = 'vb_lamp';
