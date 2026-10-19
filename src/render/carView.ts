// Binds a car mesh to simulation state (interpolated) and drives particle effects.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { qrotate, qslerp, vlerp, type Quat, type V3 } from '../core/vec';
import { maxSteerAngle, speedOf, WHEEL_ANCHORS, WHEEL_RADIUS, type CarState } from '../physics/vehicle';
import { DEFAULT_CAR_BODY, type CarBody } from '../core/cars';
import type { SurfaceHit } from '../track/track';
import { AvatarBadge, type AvatarSpec } from './avatar';
import { buildCar, type CarLight, type CarVisual } from './carMesh';
import { markEnvLit } from './sky';
import { blobTexture, haloTexture, smokeTexture } from './textures';
import { DECK_LIFT } from './trackMesh';

/** Suspension ray length (rest + wheel radius in physics/vehicle.ts); tests check it still matches. */
export const RAY = 0.81;
/** Height of the car's centre above the ground when settled on its springs. */
const RIDE_H = 0.866;

/** Per-tier car effects (set by World.setQuality) and the ground under the cars (set by World.setTrack). */
export const CAR_FX: {
  contactOpacity: number;
  /** Additive halos on head and tail lights. */
  halos: boolean;
  ground: ((x: number, y: number, z: number) => SurfaceHit) | null;
} = { contactOpacity: 0.35, halos: true, ground: null };

let blobGeo: THREE.BufferGeometry | null = null;
/** Shared by every car and never disposed, like three's sprite quad. */
function blobGeometry(): THREE.BufferGeometry {
  return (blobGeo ??= new THREE.PlaneGeometry(2.6, 5.4).rotateX(-Math.PI / 2));
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpN = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

const HEAD_GLOW = new THREE.Color(1, 0.86, 0.62).multiplyScalar(0.5);
const TAIL_GLOW = new THREE.Color(1, 0.1, 0.06).multiplyScalar(0.6);

/**
 * Glow cards just in front of the head lamps and behind the tail lamps, merged into one additive
 * mesh. A card faces along its lamp, so it is back-face culled from behind (no glow through the
 * car from the chase camera) and shrinks away as it turns edge-on.
 */
export function haloMesh(lights: readonly CarLight[]): THREE.Mesh | null {
  if (!lights.length) return null;
  const geos = lights.map((l) => {
    const tail = l.kind === 'tail';
    const g = new THREE.PlaneGeometry(l.size, l.size * 0.7);
    if (tail) g.rotateY(Math.PI);
    g.translate(l.pos[0], l.pos[1], l.pos[2] + (tail ? -0.03 : 0.03));
    const c = tail ? TAIL_GLOW : HEAD_GLOW;
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  const geo = mergeGeometries(geos)!;
  geos.forEach((g) => g.dispose());
  const halo = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: haloTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      // Fog would add sky colour to an additive card.
      fog: false,
    }),
  );
  halo.name = 'halos';
  return halo;
}

export interface PoseSnapshot {
  pos: V3;
  rot: Quat;
}

export interface CarViewOptions {
  color: string;
  ghost?: boolean;
  body?: CarBody;
  /** Floating photo badge; null or omitted for none. */
  avatar?: AvatarSpec | null;
}

export class CarView {
  readonly visual: CarVisual;
  readonly avatar: AvatarBadge | null;
  private readonly ghost: boolean;
  /** Soft contact shadow on the ground (not on ghosts); grounds the car on every tier, even without shadows. */
  private readonly blob: THREE.Mesh | null = null;
  /** Lamp glow (not on ghosts), shown while CAR_FX.halos is on. */
  private readonly halo: THREE.Mesh | null;
  private spin = 0;
  private shown = true;
  private avatarFade = 1;

  constructor(
    readonly scene: THREE.Scene,
    opts: CarViewOptions,
  ) {
    this.ghost = opts.ghost ?? false;
    this.visual = buildCar(opts.color, this.ghost, opts.body ?? DEFAULT_CAR_BODY);
    markEnvLit(this.visual.root);
    this.halo = haloMesh(this.visual.lights);
    if (this.halo) this.visual.root.add(this.halo);
    scene.add(this.visual.root);
    // A scene sibling rather than a child of the car, so it stays above the car in world up
    // when the car rolls or flips.
    this.avatar = opts.avatar ? new AvatarBadge(opts.avatar) : null;
    if (this.avatar) scene.add(this.avatar.sprite);
    // Also a scene sibling: it lies on the ground, whatever the car does.
    if (!this.ghost) {
      this.blob = new THREE.Mesh(
        blobGeometry(),
        new THREE.MeshBasicMaterial({
          map: blobTexture(),
          color: 0x000000,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          toneMapped: false,
        }),
      );
      this.blob.visible = false;
      scene.add(this.blob);
    }
  }

  /** Place the car at an interpolated pose and animate wheels. */
  apply(prev: PoseSnapshot, cur: CarState, alpha: number): void {
    const p = vlerp(prev.pos, cur.pos, alpha);
    const q = qslerp(prev.rot, cur.rot, alpha);
    this.setPose(p, q);
    this.placeBlob(p, q, cur);
    this.spin = cur.wheelSpin;
    // The lock the physics allows at this speed, so the front wheels show the steering easing off when fast.
    const steerVis = cur.steer * maxSteerAngle(speedOf(cur));
    this.visual.wheels.forEach((w, i) => {
      // Wheel centre sits where the suspension ray meets the ground, lifted by the radius.
      const comp = cur.contact[i] ? cur.comp[i] : Math.max(0, cur.comp[i]);
      w.parent!.position.y = -0.15 - (RAY - comp) + WHEEL_RADIUS;
      w.rotation.x = this.spin;
      if (i < 2) w.parent!.rotation.y = -steerVis;
    });
    const boosting = cur.boostTime > 0;
    this.visual.flames.forEach((f) => {
      f.visible = boosting;
      if (boosting) {
        const s = 0.7 + Math.random() * 0.6;
        f.scale.set(1, s * (cur.boostPower > 20 ? 1.6 : 1.1), 1);
      }
    });
  }

  /**
   * Ghost / replay pose: no wheel data is recorded, so each wheel is put on the ground with the
   * same ray as the physics (downforce squats the body at speed), and the front wheels turn by the
   * lock allowed at `speed` (m/s), as the live car shows.
   */
  applyPose(p: V3, q: Quat, steer: number, spinDelta: number, speed = 0): void {
    this.setPose(p, q);
    this.placeBlob(p, q, null);
    this.spin += spinDelta;
    const up = qrotate(q, { x: 0, y: 1, z: 0 });
    const g = CAR_FX.ground;
    const lock = maxSteerAngle(speed);
    this.visual.wheels.forEach((w, i) => {
      // Same ray as stepCar: distance along -up from the wheel anchor to the surface plane.
      let comp = 0.1; // editor (no ground query): the settled value
      if (g && up.y > 0.15) {
        const a = qrotate(q, WHEEL_ANCHORS[i]);
        const ay = p.y + a.y;
        const h = g(p.x + a.x, ay, p.z + a.z);
        const den = up.x * h.nx + up.y * h.ny + up.z * h.nz;
        comp = den > 0.2 ? Math.min(RAY, Math.max(0, RAY - ((ay - h.y) * h.ny) / den)) : 0;
      }
      w.parent!.position.y = -0.15 - (RAY - comp) + WHEEL_RADIUS;
      w.rotation.x = this.spin;
      if (i < 2) w.parent!.rotation.y = -steer * lock;
    });
  }

  /** Hides the car, its badge and its contact shadow together. */
  setVisible(v: boolean): void {
    this.visual.root.visible = v;
    this.shown = v;
    if (this.blob && !v) this.blob.visible = false;
    this.syncAvatar();
  }

  /**
   * Contact shadow: on the ground under the car (the track's surface query, so replays and jumps
   * are right too), fading out as the car rises. Without a track it follows the wheel contacts.
   */
  private placeBlob(p: V3, q: Quat, cur: CarState | null): void {
    const b = this.blob;
    if (!b) return;
    const mat = b.material as THREE.MeshBasicMaterial;
    let k: number;
    const g = CAR_FX.ground?.(p.x, p.y, p.z) ?? null;
    if (g) {
      k = Math.min(1, Math.max(0, 1 - (p.y - g.y - RIDE_H) / 1.5));
      const f = qrotate(q, { x: 0, y: 0, z: 1 });
      tmpQ.setFromUnitVectors(UP, tmpN.set(g.nx, g.ny, g.nz));
      b.quaternion.setFromAxisAngle(UP, Math.atan2(f.x, f.z)).premultiply(tmpQ);
      b.position.set(p.x, g.y + (g.road ? DECK_LIFT : 0) + 0.015, p.z);
    } else {
      let n = 0;
      let comp = 0;
      for (let i = 0; i < 4; i++) {
        if (cur && !cur.contact[i]) continue;
        n++;
        comp += cur ? cur.comp[i] : 0.1;
      }
      k = n / 4;
      b.position.copy(this.visual.root.position);
      b.quaternion.copy(this.visual.root.quaternion);
      if (n) b.translateY(-0.15 - RAY + comp / n + DECK_LIFT + 0.015);
    }
    mat.opacity = CAR_FX.contactOpacity * k;
    b.visible = this.shown && mat.opacity > 0.01;
  }

  /** Badge opacity 0..1 (hood view, ghost distance). Out-of-range input is clamped, so raw ratios are fine. */
  setAvatarFade(k: number): void {
    const f = k <= 0.01 ? 0 : Math.min(1, k);
    if (f === this.avatarFade) return;
    this.avatarFade = f;
    this.syncAvatar();
  }

  /** Repaint the car; the badge ring follows unless this is a ghost (its ring stays ghost blue). */
  setColor(c: string): void {
    this.visual.setColor(c);
    if (!this.ghost) this.avatar?.setRing(c);
  }

  private syncAvatar(): void {
    const a = this.avatar;
    if (!a) return;
    a.sprite.visible = this.shown && this.avatarFade > 0;
    a.setFade(this.avatarFade);
  }

  private setPose(p: V3, q: Quat): void {
    this.visual.root.position.set(p.x, p.y, p.z);
    this.visual.root.quaternion.set(q.x, q.y, q.z, q.w);
    if (this.halo) this.halo.visible = CAR_FX.halos;
    // Wall-clock bob: visual only, so the simulation stays deterministic.
    this.avatar?.place(p.x, p.y, p.z, performance.now() * 0.001);
  }

  dispose(): void {
    this.scene.remove(this.visual.root);
    this.visual.dispose();
    if (this.blob) {
      this.scene.remove(this.blob);
      (this.blob.material as THREE.Material).dispose();
    }
    if (this.avatar) {
      this.scene.remove(this.avatar.sprite);
      this.avatar.dispose();
    }
  }
}

/** Pooled tyre smoke particles. */
export class Smoke {
  private readonly max = 260;
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private next = 0;
  readonly points: THREE.Points;

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(this.max * 3);
    this.alpha = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: smokeTexture() }, scale: { value: 600 } },
      vertexShader: `attribute float alpha; attribute float size; varying float vA; uniform float scale;
        void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      // Linear 0.83 is the old display 0.92; colour-managed so it also holds under the bloom target.
      fragmentShader: `uniform sampler2D map; varying float vA;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vec3(0.83), t.a * vA); if (gl_FragColor.a < 0.01) discard;
        #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * 2;
    this.vel[i * 3 + 1] = vy + Math.random() * 1.5;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 2;
    this.life[i] = 1;
    this.size[i] = 0.8;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt * 0.9;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 2;
      this.vel[i * 3 + 2] *= 1 - dt * 2;
      this.size[i] += dt * 3.5;
      this.alpha[i] = Math.max(0, this.life[i]) * 0.55;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
