// Binds a car mesh to simulation state (interpolated) and drives particle effects.

import * as THREE from 'three';
import { qslerp, vlerp, type Quat, type V3 } from '../core/vec';
import { WHEEL_RADIUS, type CarState } from '../physics/vehicle';
import { DEFAULT_CAR_BODY, type CarBody } from '../core/cars';
import { AvatarBadge, type AvatarSpec } from './avatar';
import { buildCar, type CarVisual } from './carMesh';
import { smokeTexture } from './textures';

const RAY = 0.81;

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
  private spin = 0;
  private shown = true;
  private avatarFade = 1;

  constructor(
    readonly scene: THREE.Scene,
    opts: CarViewOptions,
  ) {
    this.ghost = opts.ghost ?? false;
    this.visual = buildCar(opts.color, this.ghost, opts.body ?? DEFAULT_CAR_BODY);
    scene.add(this.visual.root);
    // A scene sibling rather than a child of the car, so it stays above the car in world up
    // when the car rolls or flips.
    this.avatar = opts.avatar ? new AvatarBadge(opts.avatar) : null;
    if (this.avatar) scene.add(this.avatar.sprite);
  }

  /** Place the car at an interpolated pose and animate wheels. */
  apply(prev: PoseSnapshot, cur: CarState, alpha: number): void {
    const p = vlerp(prev.pos, cur.pos, alpha);
    const q = qslerp(prev.rot, cur.rot, alpha);
    this.setPose(p, q);
    this.spin = cur.wheelSpin;
    const steerVis = cur.steer * 0.45;
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

  /** Ghost / replay pose without wheel physics. */
  applyPose(p: V3, q: Quat, steer: number, spinDelta: number): void {
    this.setPose(p, q);
    this.spin += spinDelta;
    this.visual.wheels.forEach((w, i) => {
      w.parent!.position.y = -0.15 - (RAY - 0.1) + WHEEL_RADIUS;
      w.rotation.x = this.spin;
      if (i < 2) w.parent!.rotation.y = -steer * 0.45;
    });
  }

  /** Hides the car and its badge together. */
  setVisible(v: boolean): void {
    this.visual.root.visible = v;
    this.shown = v;
    this.syncAvatar();
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
    // Wall-clock bob: visual only, so the simulation stays deterministic.
    this.avatar?.place(p.x, p.y, p.z, performance.now() * 0.001);
  }

  dispose(): void {
    this.scene.remove(this.visual.root);
    this.visual.dispose();
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
      fragmentShader: `uniform sampler2D map; varying float vA;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vec3(0.92), t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
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
