// Renderer, sky, lighting, stadium surroundings and the current track's meshes.

import * as THREE from 'three';
import { isTouchDevice } from '../input/input';
import type { Track } from '../track/track';
import { CAR_FX } from './carView';
import type { Post } from './post';
import { pixelRatioFor, QUALITY, type Quality } from './quality';
import {
  buildEnvScene,
  ENV_LIGHT,
  makeBackground,
  makeFog,
  markEnvLit,
  refreshEnvLit,
  shadowFocus,
  skyMesh,
  SUN_OFFSET,
} from './sky';
import { buildStadium, type Extents, type Stadium } from './stadium';
import { disposeMaterial, setAnisotropy } from './texUtil';
import { buildTrackVisual, type TrackVisual } from './trackMesh';

export type { Quality } from './quality';

/** Hemisphere light alone (no environment yet, or none on this tier for the world). */
const HEMI_ALONE = 1.05;
/** With the environment on every surface (High), it provides most of the sky light. */
const HEMI_WITH_ENV = 0.5;
/** A quality change waits this long before re-baking, so stepping through the options bakes once. */
const ENV_DEBOUNCE_MS = 400;
/** The editor's empty stadium. */
const EDITOR_EXTENTS: Extents = { x0: 0, z0: 0, x1: 1024, z1: 1024 };

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private readonly hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a7a3a, HEMI_ALONE);
  private stadium: Stadium | null = null;
  private stadiumKey = '';
  private extents: Extents = EDITOR_EXTENTS;
  trackVisual: TrackVisual | null = null;
  /** The track on show, so a tier change can rebuild its meshes with the tier's materials. */
  private track: Track | null = null;
  /** Whether trackVisual was built with the cheap (Lambert) surfaces. */
  private trackCheap = false;
  private quality: Quality = 'high';
  /** Pixel ratio set by the frame-rate governor (App), within the tier; null = the tier's cap. */
  private renderScale: number | null = null;
  /** A line about the frame-rate governor for the ?fps overlay (App sets it). */
  fpsNote = '';
  /** Baked PMREM environment and the cube size it was baked (or attempted) at; 0 = none. */
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envSize = 0;
  /** performance.now() after which a pending bake may run; 0 = nothing pending. */
  private envDue = 0;
  private envQueued = false;
  private frames = 0;
  /** Compile programs and upload textures before the next frame (new track, stadium or post target). */
  private needWarm = false;
  private post: Post | null = null;
  private postLoading = false;
  private readonly fps: FpsOverlay | null = null;
  private readonly look = new THREE.Vector3();
  /** Frame count when the environment was last baked: the next frame recompiles the env-lit programs. */
  private bakedAt = -1;
  private settle: (() => void) | null = null;
  /**
   * The canvas was resized (setSize clears it) and nothing has been drawn on it since: the next frame must
   * render even where the loop thins frames out (paused, results), or the screen flashes black.
   */
  dirty = false;
  /**
   * Resolves once the first frames are done: stadium and track programs compiled, and the tier's
   * environment baked and drawn with (or skipped). Together a second or two on a phone, so the boot
   * screen stays up over them rather than the menu freezing just after it appears.
   */
  readonly ready = new Promise<void>((r) => (this.settle = r));

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral keeps saturated paint true to the garage swatch (ACES turned the default red maroon).
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = makeBackground();
    this.scene.fog = makeFog();
    this.scene.add(this.hemi);
    this.sun.position.copy(SUN_OFFSET);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.near = 10;
    sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(skyMesh());
    // three re-creates its GL state on a restored context, but render-target contents (the baked
    // environment) are gone: fall back to the hemisphere light and bake again.
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored());
    if (location.search.includes('fps')) {
      this.fps = new FpsOverlay();
      this.renderer.info.autoReset = false;
    }
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const p = QUALITY[q];
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (p.shadows) {
      const sc = this.sun.shadow.camera;
      sc.left = sc.bottom = -p.shadowExtent;
      sc.right = sc.top = p.shadowExtent;
      sc.updateProjectionMatrix();
      this.sun.shadow.mapSize.set(p.shadowMap, p.shadowMap);
      this.sun.shadow.radius = p.shadowRadius;
      // About three texels, as the old 0.6 m was at 17.6 cm texels.
      this.sun.shadow.normalBias = ((2 * p.shadowExtent) / p.shadowMap) * 3;
    }
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    setAnisotropy(Math.min(p.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    CAR_FX.contactOpacity = p.contactOpacity;
    CAR_FX.halos = p.halos;
    this.applyEnv();
    this.requestEnv(this.frames ? ENV_DEBOUNCE_MS : 0);
    this.syncPost();
    // Trees, stand rows and halos are per tier.
    if (this.stadium) this.placeStadium(this.extents);
    // Low draws the road with the cheap shader.
    if (this.track && this.trackCheap !== p.cheapGround) this.buildTrack(this.track);
    this.renderScale = null;
    this.resize();
  }

  /**
   * The pixel ratio to draw at (the frame-rate governor's, within the tier), or null for the tier's cap.
   * Never above the device's own ratio. A canvas resize, cheap enough to do between two frames.
   */
  setRenderScale(dpr: number | null): void {
    const v = dpr !== null && Number.isFinite(dpr) && dpr > 0 ? dpr : null;
    if (v === this.renderScale) return;
    this.renderScale = v;
    this.resize();
  }

  /** The pixel ratio drawn at now. */
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /** Where the scene is drawn (the bloom target, else the canvas): programs compiled ahead of time must match it. */
  get compileTarget(): THREE.WebGLRenderTarget | null {
    return this.post?.target ?? null;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const d = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(this.renderScale !== null ? Math.min(d, this.renderScale) : pixelRatioFor(this.quality, d));
    this.renderer.setSize(w, h, false);
    this.dirty = true;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
  }

  setTrack(track: Track | null): void {
    this.track = track;
    // The editor calls this with null on every edit: the stadium is cached by extents and tier.
    this.placeStadium(track ? track.extents() : EDITOR_EXTENTS);
    CAR_FX.ground = track ? (x, y, z) => track.surfaceAt(x, y, z, 0.2) : null;
    this.buildTrack(track);
  }

  private buildTrack(track: Track | null): void {
    if (this.trackVisual) {
      this.scene.remove(this.trackVisual.group);
      this.trackVisual.dispose();
      this.trackVisual = null;
    }
    if (!track) return;
    this.trackCheap = QUALITY[this.quality].cheapGround;
    this.trackVisual = buildTrackVisual(track, { cheap: this.trackCheap });
    markEnvLit(this.trackVisual.group);
    this.scene.add(this.trackVisual.group);
    this.needWarm = true;
  }

  private placeStadium(e: Extents): void {
    this.extents = e;
    const key = `${e.x0},${e.z0},${e.x1},${e.z1},${this.quality}`;
    if (key === this.stadiumKey) return;
    if (this.stadium) {
      this.scene.remove(this.stadium.group);
      this.stadium.dispose();
    }
    this.stadium = buildStadium(e, QUALITY[this.quality]);
    markEnvLit(this.stadium.group);
    this.stadiumKey = key;
    this.scene.add(this.stadium.group);
    this.needWarm = true;
  }

  /**
   * Keep the shadow box on the action: centred a little ahead of the camera's view, moved in whole
   * shadow texels so edges don't crawl. With shadows off the sun just follows the car.
   */
  focusShadow(x: number, y: number, z: number): void {
    this.camera.getWorldDirection(this.look);
    const t = shadowFocus(this.sun.target.position, x, y, z, this.look.x, this.look.z, QUALITY[this.quality]);
    this.sun.position.copy(t).add(SUN_OFFSET);
  }

  update(dt: number): void {
    this.trackVisual?.update(dt);
  }

  render(): void {
    if (this.needWarm) this.warm();
    if (this.fps) this.renderer.info.reset();
    if (this.post) this.post.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    this.dirty = false;
    this.fps?.frame(this.renderer, this.quality, this.fpsNote);
    this.frames++;
    // The first bake waits until a frame is on screen, and runs outside the animation frame.
    if (this.envDue && !this.envQueued && this.frames >= 2 && performance.now() >= this.envDue) {
      this.envQueued = true;
      setTimeout(() => {
        this.envQueued = false;
        this.bakeEnvironment();
      }, 0);
    }
    if (this.settle && !this.envDue && !this.envQueued && this.frames > this.bakedAt + 1) {
      this.settle();
      this.settle = null;
    }
  }

  /**
   * Bake again unless the current tier has no environment or its cube size is already baked (or
   * known unsupported).
   */
  private requestEnv(delay: number): void {
    const size = QUALITY[this.quality].envSize;
    // A bake at least this sharp is kept: Auto stepping High -> Medium mid-session bakes nothing new.
    this.envDue = size === 0 || size <= this.envSize ? 0 : performance.now() + delay;
  }

  private bakeEnvironment(): void {
    if (!this.envDue || performance.now() < this.envDue) return;
    this.envDue = 0;
    const size = QUALITY[this.quality].envSize;
    // Low bakes nothing; an earlier bake stays cached for a step back up (and serves a smaller tier).
    if (size === 0 || size <= this.envSize) return;
    if (this.renderer.getContext().isContextLost()) return; // the restore handler asks again
    const ext = this.renderer.extensions;
    if (!(ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float'))) {
      // No half-float render targets: PMREM would come out black. Keep the hemisphere-only look.
      this.envSize = size;
      return;
    }
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = buildEnvScene();
    const rt = pmrem.fromScene(env, 0, 0.1, 100, { size });
    disposeTree(env);
    pmrem.dispose();
    this.envRT?.dispose();
    this.envRT = rt;
    this.envSize = size;
    this.bakedAt = this.frames;
    this.applyEnv();
    // Every env-lit material now needs a new program: build them all before the next frame.
    this.needWarm = true;
  }

  /** Point the scene and the car materials at the current bake, by tier. */
  private applyEnv(): void {
    const p = QUALITY[this.quality];
    // A tier without an environment (Low) keeps the hemisphere light alone, even with a cached bake.
    const map = p.envSize ? (this.envRT?.texture ?? null) : null;
    const all = map !== null && p.envAll;
    this.scene.environment = all ? map : null;
    this.scene.environmentIntensity = 0.9;
    this.hemi.intensity = all ? HEMI_WITH_ENV : HEMI_ALONE;
    ENV_LIGHT.map = map;
    // Cars on Medium also keep the full hemisphere light, so their reflections are dimmer.
    ENV_LIGHT.intensity = p.envAll ? 0.9 : 0.6;
    refreshEnvLit(this.scene);
  }

  private onContextRestored(): void {
    this.envRT?.dispose();
    this.envRT = null;
    this.envSize = 0;
    this.applyEnv();
    this.requestEnv(0);
    this.needWarm = true;
  }

  /** Bloom on High for non-touch devices with half-float targets; the code loads on first use. */
  private syncPost(): void {
    const ext = this.renderer.extensions;
    const want =
      QUALITY[this.quality].bloom &&
      !isTouchDevice() &&
      (ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float'));
    if (!want) {
      this.post?.dispose();
      this.post = null;
      return;
    }
    if (this.post || this.postLoading) return;
    this.postLoading = true;
    import('./post')
      .then(({ Post }) => {
        this.postLoading = false;
        if (this.post || !QUALITY[this.quality].bloom) return;
        this.post = new Post(this.renderer);
        this.resize();
        this.needWarm = true;
      })
      .catch(() => {
        this.postLoading = false;
      });
  }

  /**
   * Build the scene's shader programs before the next frame, as after a track change: a vehicle built in
   * place (the garage's or the Campaign header's class switch) would otherwise compile on its first frame.
   */
  requestWarm(): void {
    this.needWarm = true;
  }

  /**
   * Build every shader program the scene needs now (hidden objects included: boost flames, the
   * ghost's materials) and upload its textures, so the first boost or the first look at a far stand
   * does not stall mid-race. With bloom the programs are built for its render target.
   */
  private warm(): void {
    this.needWarm = false;
    const r = this.renderer;
    if (r.getContext().isContextLost()) return;
    r.setRenderTarget(this.post?.target ?? null);
    const mats = r.compile(this.scene, this.camera);
    r.setRenderTarget(null);
    const seen = new Set<THREE.Texture>();
    const upload = (v: unknown) => {
      if (!(v instanceof THREE.Texture) || v.isRenderTargetTexture || seen.has(v)) return;
      seen.add(v);
      r.initTexture(v);
    };
    for (const m of mats) {
      Object.values(m).forEach(upload);
      const u = (m as THREE.ShaderMaterial).uniforms;
      if (u) Object.values(u).forEach((x) => upload(x.value));
    }
  }
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: THREE.Material) => disposeMaterial(m));
    }
  });
}

/** On-device check with ?fps in the URL: frame rate, draw calls, triangles and pixel ratio. */
class FpsOverlay {
  private readonly el = document.createElement('div');
  private n = 0;
  private t0 = performance.now();

  constructor() {
    this.el.style.cssText =
      'position:fixed;left:4px;bottom:4px;z-index:99;padding:2px 6px;font:11px/1.3 monospace;color:#fff;background:rgba(0,0,0,0.55);pointer-events:none;white-space:pre';
    document.body.appendChild(this.el);
  }

  frame(r: THREE.WebGLRenderer, q: Quality, note: string): void {
    this.n++;
    const now = performance.now();
    if (now - this.t0 < 500) return;
    const fps = (this.n * 1000) / (now - this.t0);
    const i = r.info.render;
    this.el.textContent = `${fps.toFixed(0)} fps  ${i.calls} calls  ${(i.triangles / 1000).toFixed(0)}k tris  dpr ${r.getPixelRatio().toFixed(2)}  ${q}${note ? `
${note}` : ''}`;
    this.n = 0;
    this.t0 = now;
  }
}
