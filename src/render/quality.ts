// Graphics quality tiers: everything that changes between Low, Medium and High, in one table.

export type Quality = 'low' | 'medium' | 'high';

export interface QualityProfile {
  /** Device pixel ratio cap (today's caps; no dynamic resolution yet). */
  maxDpr: number;
  shadows: boolean;
  shadowMap: 1024 | 2048;
  /** Half-size of the shadow box in metres; 0 with shadows off. */
  shadowExtent: number;
  /** PCF softness in texels. Keep it small: r186 rotates a 5-tap disk per pixel, so wide radii look grainy. */
  shadowRadius: number;
  /**
   * PMREM cube size of the baked environment; 0 = no bake (hemisphere light only, as before the
   * environment existed), which saves Low the bake and shader-recompile stall at launch.
   */
  envSize: 0 | 64 | 128 | 256;
  /**
   * Environment lighting on every lit surface (scene.environment). Otherwise only metallic materials
   * (car paint, glass, chrome, gate posts) get it, which keeps the cube-map fetches off the road,
   * lawn, stands and roofs.
   */
  envAll: boolean;
  anisotropy: number;
  /** Bloom post-processing (lazy-loaded, and only on non-touch devices). */
  bloom: boolean;
  /** Cheap additive halos around lamps and gate light strips. */
  halos: boolean;
  /** Peak opacity of the contact shadow under each car. */
  contactOpacity: number;
  trees: number;
  standRows: number;
  /** Lambert instead of Standard on the lawn and stands. */
  cheapGround: boolean;
}

export const QUALITY: Readonly<Record<Quality, QualityProfile>> = {
  low: {
    maxDpr: 1,
    shadows: false,
    shadowMap: 1024,
    shadowExtent: 0,
    shadowRadius: 0,
    envSize: 0,
    envAll: false,
    anisotropy: 2,
    bloom: false,
    halos: true,
    contactOpacity: 0.55,
    trees: 80,
    standRows: 6,
    cheapGround: true,
  },
  medium: {
    maxDpr: 1.5,
    shadows: true,
    shadowMap: 1024,
    shadowExtent: 60,
    shadowRadius: 1.25,
    envSize: 128,
    envAll: false,
    anisotropy: 4,
    bloom: false,
    halos: true,
    contactOpacity: 0.35,
    trees: 220,
    standRows: 10,
    cheapGround: false,
  },
  high: {
    maxDpr: 2,
    shadows: true,
    shadowMap: 2048,
    shadowExtent: 80,
    shadowRadius: 1.5,
    envSize: 256,
    envAll: true,
    anisotropy: 8,
    bloom: true,
    halos: true,
    contactOpacity: 0.3,
    trees: 400,
    standRows: 14,
    cheapGround: false,
  },
};

/**
 * Renderer pixel ratio for a tier on a device. Today's caps; a pixel budget per tier only makes
 * sense together with a frame-time controller, which does not exist yet.
 */
export function pixelRatioFor(q: Quality, dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, QUALITY[q].maxDpr);
}
