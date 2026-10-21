// Per-theme look: sky, fog and light colours (sky.ts, world.ts) and the surroundings' palette (stadium.ts).
// The Stadium look is the game's original one, value for value (SKY in sky.ts is its sky).

import * as THREE from 'three';
import type { SkyKind, Theme } from '../track/track';

/** Linear colours of a sky (THREE.Color converts the sRGB hex). */
export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** The band below the horizon in the environment bake (the stands, or the theme's skyline). */
  stands: THREE.Color;
  ground: THREE.Color;
  /** Cloud cover on the dome, 0..1, and the clouds' colour. */
  clouds: number;
  cloudColor: THREE.Color;
  /** Sun glow on the dome: its colour, and how far below the light's own direction it is drawn (radians; a sunset sits low). */
  glow: THREE.Color;
  glowDrop: number;
}

export interface ThemeLook {
  key: string;
  sky: SkyPalette;
  /** Directional sun light colour and intensity. */
  sun: THREE.Color;
  sunIntensity: number;
  /** Hemisphere light: sky and ground colours. */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  /** Distant hills: foot and top colours, height (m). */
  hillLow: THREE.Color;
  hillHigh: THREE.Color;
  hillHeight: number;
  /** The flat field around the stadium. */
  field: THREE.Color;
  /** Perimeter wall. */
  wall: THREE.Color;
  /** Water: deep and shallow colours. */
  waterDeep: THREE.Color;
  waterShallow: THREE.Color;
}

const c = (hex: string) => new THREE.Color(hex);

const STADIUM_SKY: SkyPalette = {
  zenith: c('#1f63d8'),
  horizon: c('#cfe6ff'),
  stands: c('#30353d'),
  ground: c('#3f6a32'),
  clouds: 0.6,
  cloudColor: new THREE.Color(0.93, 0.95, 0.98),
  glow: new THREE.Color(1.0, 0.92, 0.75),
  glowDrop: 0,
};

const LOOKS: Record<string, ThemeLook> = {
  'stadium-day': {
    key: 'stadium-day',
    sky: STADIUM_SKY,
    sun: new THREE.Color(0xfff1dc),
    sunIntensity: 2.4,
    hemiSky: new THREE.Color(0xcfe6ff),
    hemiGround: new THREE.Color(0x4a7a3a),
    hillLow: c('#5d8a4a'),
    hillHigh: c('#8794a3'),
    hillHeight: 260,
    field: new THREE.Color(0x5c8f45),
    wall: new THREE.Color(0x30353d),
    waterDeep: c('#0f4f73'),
    waterShallow: c('#2f8fa6'),
  },
  'desert-day': {
    key: 'desert-day',
    sky: {
      zenith: c('#2f6fc4'),
      horizon: c('#f2dcb8'),
      stands: c('#9c7650'),
      ground: c('#c39a62'),
      clouds: 0.18,
      cloudColor: new THREE.Color(0.98, 0.95, 0.9),
      glow: new THREE.Color(1.0, 0.9, 0.7),
      glowDrop: 0,
    },
    sun: new THREE.Color(0xfff0d2),
    sunIntensity: 2.6,
    hemiSky: new THREE.Color(0xf4e2c4),
    hemiGround: new THREE.Color(0xa07c4e),
    hillLow: c('#d6b07c'),
    hillHigh: c('#c4a286'),
    hillHeight: 110,
    field: new THREE.Color(0xd8b682),
    wall: new THREE.Color(0xb88a5c),
    waterDeep: c('#2f6f7a'),
    waterShallow: c('#5fa3a0'),
  },
  'desert-sunset': {
    key: 'desert-sunset',
    sky: {
      zenith: c('#2c3470'),
      horizon: c('#f4ae7c'),
      stands: c('#6b4a3c'),
      ground: c('#7a5a44'),
      clouds: 0.35,
      cloudColor: new THREE.Color(1.0, 0.66, 0.52),
      glow: new THREE.Color(1.0, 0.58, 0.26),
      glowDrop: 0.95,
    },
    sun: new THREE.Color(0xffcfa6),
    sunIntensity: 2.1,
    hemiSky: new THREE.Color(0xd9c4c8),
    hemiGround: new THREE.Color(0x6a5040),
    hillLow: c('#b07a58'),
    hillHigh: c('#8a6a72'),
    hillHeight: 110,
    field: new THREE.Color(0xc09670),
    wall: new THREE.Color(0x8c6650),
    waterDeep: c('#3a4f6a'),
    waterShallow: c('#8a6f70'),
  },
  'water-day': {
    key: 'water-day',
    sky: {
      zenith: c('#1a6fd6'),
      horizon: c('#d8f1ff'),
      stands: c('#4f6f7a'),
      ground: c('#2f7a8a'),
      clouds: 0.5,
      cloudColor: new THREE.Color(0.95, 0.97, 1.0),
      glow: new THREE.Color(1.0, 0.94, 0.8),
      glowDrop: 0,
    },
    sun: new THREE.Color(0xfff4e2),
    sunIntensity: 2.5,
    hemiSky: new THREE.Color(0xd8f1ff),
    hemiGround: new THREE.Color(0x4f8a7a),
    hillLow: c('#5f8f6a'),
    hillHigh: c('#9aa9b4'),
    hillHeight: 90,
    field: new THREE.Color(0xe2cc98),
    wall: new THREE.Color(0x3a4a55),
    waterDeep: c('#0b5d7e'),
    waterShallow: c('#2fb3b8'),
  },
};
LOOKS['stadium-sunset'] = {
  ...LOOKS['desert-sunset'],
  key: 'stadium-sunset',
  hillLow: LOOKS['stadium-day'].hillLow,
  hillHigh: c('#6a5a66'),
  hillHeight: 260,
  field: new THREE.Color(0x4f7a3c),
  wall: LOOKS['stadium-day'].wall,
};
LOOKS['water-sunset'] = {
  ...LOOKS['desert-sunset'],
  key: 'water-sunset',
  hillLow: c('#4a6a48'),
  hillHigh: c('#5a4f5f'),
  hillHeight: 150,
  field: new THREE.Color(0xc89f78),
  wall: LOOKS['water-day'].wall,
  waterDeep: c('#26405e'),
  waterShallow: c('#b06a52'),
};

/** The look of a theme under a sky (Stadium in daylight is the original). */
export function themeLook(theme: Theme = 'stadium', sky: SkyKind = 'day'): ThemeLook {
  return LOOKS[`${theme}-${sky}`] ?? LOOKS['stadium-day'];
}

/** The original look: the Stadium in daylight. */
export const STADIUM_LOOK: ThemeLook = LOOKS['stadium-day'];
