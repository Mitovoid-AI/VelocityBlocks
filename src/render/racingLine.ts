// Racing-line ribbon: one mesh along the whole line, coloured per sample by game/racingLine.ts lineColors
// (green throttle, violet nitro, yellow lift, orange to red brake), with chevrons so the two that matter
// most read without colour too: dark ones in brake zones, light ones where the pace car fired its nitro.
// It lies just above the road, fades in a few metres ahead of the car and out far ahead; following the car
// costs one uniform and a draw range per frame, with no buffer uploads.

import * as THREE from 'three';
import type { V3 } from '../core/vec';
import { lineColors, lineDistanceAt, nearestSample, Phase, type RacingLineData } from '../game/racingLine';

/**
 * Before the other transparents (ghost car and smoke at 0, the photo badge at 1), which write no depth
 * and would be painted over; after the boost pads and gate light bars (-1), so it shows on them.
 */
export const RACING_LINE_RENDER_ORDER = -0.5;
/** Half the ribbon width (m). */
const HALF_W = 0.55;
/** Height above the road surface: over the pads (+0.06) and gate light bars (+0.07). */
const LIFT = 0.09;
/** Drawn from this far behind the car's place on the line to this far ahead (m); the shader fades both ends. */
const BEHIND = 2;
const AHEAD = 220;
/** Chevron spacing along the line (m). */
const CHEVRON = 2.4;

/** Chevrons per phase: dark in brake zones (1), light on nitro (-1), none on throttle and lifts (0). */
export function chevronMark(phase: number): number {
  return phase === Phase.Brake ? 1 : phase === Phase.Nitro ? -1 : 0;
}

/** Vertex and index arrays of a ribbon: two vertices per sample (left, right). */
export interface Ribbon {
  position: Float32Array;
  color: Float32Array;
  /** Distance along the line. */
  s: Float32Array;
  /** -1 on the left edge, +1 on the right. */
  edge: Float32Array;
  /** Chevrons (chevronMark): 1 dark in brake zones, -1 light on nitro, else 0. */
  mark: Float32Array;
  index: Uint16Array | Uint32Array;
  /** Index count before each segment (segment i joins samples i and i + 1); the last entry is the total. */
  firstIndex: Uint32Array;
}

/**
 * Builds the ribbon arrays: a strip `halfW` either side of the samples, `lift` above them, with a
 * segment only where both of its samples are visible (no line in the air or on the grass).
 */
export function buildRibbon(d: RacingLineData, colors: Float32Array, halfW = HALF_W, lift = LIFT): Ribbon {
  const n = d.x.length;
  const position = new Float32Array(n * 6);
  const color = new Float32Array(n * 6);
  const s = new Float32Array(n * 2);
  const edge = new Float32Array(n * 2);
  const mark = new Float32Array(n * 2);
  let rx = 1, rz = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const tx = d.x[b] - d.x[a], tz = d.z[b] - d.z[a];
    const l = Math.hypot(tx, tz);
    if (l > 1e-6) {
      rx = -tz / l;
      rz = tx / l;
    }
    const y = d.y[i] + lift;
    position.set([d.x[i] - rx * halfW, y, d.z[i] - rz * halfW, d.x[i] + rx * halfW, y, d.z[i] + rz * halfW], i * 6);
    for (const k of [0, 3]) color.set(colors.subarray(i * 3, i * 3 + 3), i * 6 + k);
    s[2 * i] = s[2 * i + 1] = d.s[i];
    edge[2 * i] = -1;
    edge[2 * i + 1] = 1;
    mark[2 * i] = mark[2 * i + 1] = chevronMark(d.phase[i]);
  }
  let segs = 0;
  for (let i = 0; i < n - 1; i++) if (d.visible[i] && d.visible[i + 1]) segs++;
  const index = n * 2 < 65536 ? new Uint16Array(segs * 6) : new Uint32Array(segs * 6);
  const firstIndex = new Uint32Array(Math.max(1, n));
  let at = 0;
  for (let i = 0; i < n - 1; i++) {
    firstIndex[i] = at;
    if (!d.visible[i] || !d.visible[i + 1]) continue;
    const v = 2 * i;
    index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], at);
    at += 6;
  }
  firstIndex[Math.max(0, n - 1)] = at;
  return { position, color, s, edge, mark, index, firstIndex };
}

/** First index i with a[i] >= v (a non-decreasing). */
function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Index range [start, count] of the segments from `behind` metres before `carS` to `ahead` metres after it. */
export function drawWindow(
  s: ArrayLike<number>,
  firstIndex: Uint32Array,
  carS: number,
  behind = BEHIND,
  ahead = AHEAD,
): [number, number] {
  const n = s.length;
  if (n < 2) return [0, 0];
  const a = Math.max(0, lowerBound(s, carS - behind) - 1);
  const b = Math.min(n - 1, Math.max(a, lowerBound(s, carS + ahead)));
  return [firstIndex[a], firstIndex[b] - firstIndex[a]];
}

const VERTEX = `attribute vec3 aCol; attribute float aS; attribute float aEdge; attribute float aMark;
  uniform float uCarS;
  varying vec3 vCol; varying float vA; varying float vE; varying float vM; varying float vC;
  void main(){
    float d = aS - uCarS;
    vA = smoothstep(3.0, 12.0, d) * (1.0 - smoothstep(150.0, ${AHEAD.toFixed(1)}, d));
    vCol = aCol; vE = aEdge; vM = aMark;
    // Chevron phase relative to the car keeps the fragment maths small (mediump) on long tracks.
    vC = d + mod(uCarS, ${CHEVRON.toFixed(1)});
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAGMENT = `uniform float uOpacity;
  varying vec3 vCol; varying float vA; varying float vE; varying float vM; varying float vC;
  void main(){
    float a = uOpacity * vA * (1.0 - smoothstep(0.65, 1.0, abs(vE)));
    if (a < 0.01) discard;
    // Chevrons pointing down the road: darker in brake zones (vM > 0), lighter on nitro (vM < 0).
    float c = step(0.55, fract((vC + abs(vE) * 0.9) / ${CHEVRON.toFixed(1)}));
    vec3 col = mix(vCol, vCol * 0.45, max(vM, 0.0) * c);
    col = mix(col, mix(col, vec3(1.0), 0.45), max(-vM, 0.0) * c);
    // The colours are display sRGB: decode, then let three encode for the target (once on the
    // canvas, not at all into the bloom target, whose output pass encodes).
    gl_FragColor = sRGBTransferEOTF(vec4(col, a));
    #include <colorspace_fragment>
  }`;

/** The line's material. No fog (the far fade ends before the fog starts) and no tone mapping; colour-managed, as the smoke. */
function lineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    // Both faces in one draw (and one program): three draws a transparent DoubleSide material twice,
    // back faces then front, and only one face of the flat ribbon is ever seen.
    forceSinglePass: true,
    uniforms: { uCarS: { value: 0 }, uOpacity: { value: 0.85 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
}

/** Holds the compiled program for the session (every view's material shares it). */
let keeper: THREE.ShaderMaterial | null = null;

/**
 * Compiles the line's shader now (call it at race start, during the countdown, while the racing line
 * setting is on), so a line that arrives mid-race never compiles on the first frame it is drawn.
 * `target` is where the scene is drawn (World.compileTarget: the bloom target on High, else null),
 * which is part of the program.
 */
export function warmRacingLine(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget | null = null,
): void {
  if (!keeper) keeper = lineMaterial();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(3), 3));
  for (const k of ['aS', 'aEdge', 'aMark']) geo.setAttribute(k, new THREE.BufferAttribute(new Float32Array(1), 1));
  const mesh = new THREE.Mesh(geo, keeper);
  mesh.renderOrder = RACING_LINE_RENDER_ORDER;
  renderer.setRenderTarget(target);
  renderer.compile(mesh, camera, scene);
  renderer.setRenderTarget(null);
  geo.dispose();
}

/**
 * The racing line in the scene. Usage: `new RacingLineView(data)`, `attach(scene)`, then
 * `update(carPos)` every frame; `resetTracking()` after a teleport (respawn, restart); `dispose()` when
 * the race ends or the setting is turned off.
 */
export class RacingLineView {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly ribbon: Ribbon;
  private hint = -1;

  constructor(
    readonly data: RacingLineData,
    opts: { liftAsThrottle?: boolean } = {},
  ) {
    this.ribbon = buildRibbon(data, lineColors(data, opts.liftAsThrottle));
    const r = this.ribbon;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(r.color, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(r.s, 1));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(r.edge, 1));
    geo.setAttribute('aMark', new THREE.BufferAttribute(r.mark, 1));
    geo.setIndex(new THREE.BufferAttribute(r.index, 1));
    geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geo, lineMaterial());
    this.mesh.renderOrder = RACING_LINE_RENDER_ORDER;
    // The ribbon spans the whole track; the draw range does the culling.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  attach(scene: THREE.Object3D): void {
    scene.add(this.mesh);
  }

  detach(): void {
    this.mesh.removeFromParent();
  }

  setVisible(on: boolean): void {
    this.mesh.visible = on;
  }

  /** Auto-accelerate cannot lift: paint lifts as throttle. */
  setLiftAsThrottle(on: boolean): void {
    const c = lineColors(this.data, on);
    const attr = this.mesh.geometry.getAttribute('aCol') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < c.length / 3; i++) for (const k of [0, 3]) arr.set(c.subarray(i * 3, i * 3 + 3), i * 6 + k);
    attr.needsUpdate = true;
  }

  /** Follows the car: the fade near it and the drawn window move with its place on the line. */
  update(carPos: V3): void {
    const d = this.data;
    if (d.x.length < 2) return;
    this.hint = nearestSample(d, carPos.x, carPos.y, carPos.z, this.hint);
    // Between samples, so the fade glides at low speed instead of stepping a metre at a time.
    const s = lineDistanceAt(d, this.hint, carPos.x, carPos.z);
    this.mesh.material.uniforms.uCarS.value = s;
    const [start, count] = drawWindow(d.s, this.ribbon.firstIndex, s);
    this.mesh.geometry.setDrawRange(start, count);
  }

  /** Forget the tracked place on the line (after a respawn or restart teleport). */
  resetTracking(): void {
    this.hint = -1;
  }

  dispose(): void {
    this.detach();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
