// Bloom for the High tier on non-touch devices. Loaded with import() so other tiers never pay for
// the code. The scene renders into one multisampled half-float target (EffectComposer would clone
// it into a second MSAA target that these passes never write), bloom is added onto it in place,
// and OutputPass applies the renderer's tone mapping and sRGB conversion once for the whole image.

import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Linear luminance above which pixels bloom: lamps, light strips and headlights, not sunlit white paint. */
const THRESHOLD = 1.5;

export class Post {
  readonly target: THREE.WebGLRenderTarget;
  private readonly bloom: UnrealBloomPass;
  private readonly output = new OutputPass();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(s.x, s.y, { type: THREE.HalfFloatType, samples: 4 });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(s.x, s.y), 0.6, 0.4, THRESHOLD);
    this.output.renderToScreen = true;
  }

  setSize(w: number, h: number, dpr: number): void {
    const x = Math.max(1, Math.floor(w * dpr));
    const y = Math.max(1, Math.floor(h * dpr));
    this.target.setSize(x, y);
    this.bloom.setSize(x, y);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    this.bloom.render(r, this.target, this.target, 0, false);
    this.output.render(r, this.target, this.target, 0, false);
    r.setRenderTarget(null);
  }

  dispose(): void {
    this.target.dispose();
    this.bloom.dispose();
    this.output.dispose();
  }
}
