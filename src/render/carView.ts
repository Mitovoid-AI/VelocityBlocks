// Binds a vehicle mesh (car, bike or truck) to simulation state (interpolated) and drives particle
// effects. Wheels sit on the class's suspension rays (physics/vehicle.ts vehicleSpec); the bike's lean
// and the truck's body roll are drawn from the cornering force, visual only.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GRAVITY } from '../core/constants';
import { clamp, qrotate, qslerp, vdot, vlerp, type Quat, type V3 } from '../core/vec';
import {
  forwardOf,
  maxSteerAngle,
  NITRO_FADE,
  NITRO_TIME,
  speedOf,
  upOf,
  vehicleSpec,
  type CarState,
  type VehicleSpec,
} from '../physics/vehicle';
import { DEFAULT_CAR_BODY, type CarBody } from '../core/cars';
import type { ModelId } from '../core/vehicleModels';
import { DEFAULT_VEHICLE, type VehicleClass } from '../core/vehicles';
import type { SurfaceHit } from '../track/track';
import { avatarLift, AvatarBadge, type AvatarSpec } from './avatar';
import { BIKE_LEAN_MAX } from './bikeMesh';
import { stretchFlame, type CarLight, type CarVisual } from './carMesh';
import { markEnvLit } from './sky';
import { blobTexture, haloTexture, smokeTexture } from './textures';
import { DECK_LIFT } from './trackMesh';
import { TRUCK_ROLL_MAX } from './truckMesh';
import { buildVehicle } from './vehicleMesh';

/** The car's suspension ray length (rest + wheel radius in physics/vehicle.ts); tests check it still matches. */
export const RAY = 0.81;

/** Share of a real bike's lean, atan(a/g), that is drawn (the rider's head stays nearer the bike's footprint). */
const LEAN_SHARE = 0.8;
/** Truck body roll per g of cornering (rad). */
const ROLL_PER_G = 0.04;
/** Time constant (s) of the lean and roll: smooths barrier knocks and the ghost's steps. */
export const BODY_TAU = 0.12;
/** Lateral acceleration cap for a ghost's estimate from its steering (m/s^2). */
const GHOST_LAT_MAX = 2.5 * GRAVITY;
/** Flame colours: boost pads (cyan) and the nitro (violet). */
const BOOST_FLAME = 0x66ccff;
export const NITRO_FLAME = 0xb07cff;

/**
 * Strength of a nitro push for the visuals, 0..1, from its seconds left: full at the press, fading to
 * NITRO_FADE as the push itself does (physics/vehicle.ts nitroAccel), 0 when not boosting. Scales the flames
 * and the camera's FOV kick (CarView.boost -> CameraRig.boost), so both read the push and drop the moment it ends.
 */
export function nitroKick(nitroTime: number): number {
  return nitroTime > 0 ? NITRO_FADE + (1 - NITRO_FADE) * Math.min(1, nitroTime / NITRO_TIME) : 0;
}

/** Flame length and width (x the modelled cone) for a nitro push of strength k (nitroKick): bigger than a pad's. */
export function nitroFlame(k: number): { len: number; width: number } {
  return { len: 1.4 + 0.9 * k, width: 1 + 0.45 * k };
}

/** Bike lean (rad; + leans right, the -x side down) for a lateral acceleration (m/s^2; + turns left). */
export function leanFor(lat: number): number {
  return clamp(-LEAN_SHARE * Math.atan(lat / GRAVITY), -BIKE_LEAN_MAX, BIKE_LEAN_MAX);
}

/** Truck body roll (rad, the same sign convention as leanFor): the body rolls out of the turn. */
export function rollFor(lat: number): number {
  return clamp((ROLL_PER_G * lat) / GRAVITY, -TRUCK_ROLL_MAX, TRUCK_ROLL_MAX);
}

/** One step of a frame-rate independent low-pass from `cur` towards `target` over dt seconds. */
export function easeToward(cur: number, target: number, dt: number, tau = BODY_TAU): number {
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

/** Per-class placement of the modes' effects in the body frame: rear-tyre smoke and dust, and the ghost's hide distance. */
export interface VehicleFx {
  /** Emitters behind the driven rear tyres: z, the x of each, and their height (y) from the centre. */
  readonly smokeZ: number;
  readonly smokeX: readonly number[];
  readonly smokeY: number;
  /** Hide the PB ghost while it is closer than this to the player (m). */
  readonly ghostHide: number;
}

const TRUCK_REAR = vehicleSpec('truck').wheels[2];
/** Emitter height for the other classes: as high above the road as the car's (0.42 m). */
const smokeY = (vehicle: VehicleClass): number => 0.42 - vehicleSpec(vehicle).rideHeight;
const FX: Record<VehicleClass, VehicleFx> = {
  // The car's are the values raceMode has always used (dust goes 5 cm lower).
  car: { smokeZ: -1.4, smokeX: [-0.9, 0.9], smokeY: -0.45, ghostHide: 3.5 },
  // One rear tyre on the centre line, just behind the drawn rear axle.
  bike: { smokeZ: -0.75, smokeX: [0], smokeY: smokeY('bike'), ghostHide: 2.5 },
  truck: { smokeZ: TRUCK_REAR.z, smokeX: [-TRUCK_REAR.x, TRUCK_REAR.x], smokeY: smokeY('truck'), ghostHide: 5.5 },
};

export function vehicleFx(vehicle: VehicleClass): VehicleFx {
  return FX[vehicle] ?? FX.car;
}

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
  /** Vehicle class (default car); `body` is the car's body style and applies to cars only. */
  vehicle?: VehicleClass;
  body?: CarBody;
  /**
   * A realistic model of the class (vehicleModels.ts). Drawn only when it is already loaded (modelCache.ts);
   * otherwise the procedural vehicle stands in, so building a CarView never waits.
   */
  model?: ModelId | null;
  /** Floating photo badge; null or omitted for none. */
  avatar?: AvatarSpec | null;
}

/** Contact shadow size per class (width, length in m); the shared quad is the car's. */
const BLOB: Record<VehicleClass, readonly [number, number]> = { car: [2.6, 5.4], bike: [1.0, 2.6], truck: [3.1, 6.9] };

export class CarView {
  readonly visual: CarVisual;
  readonly avatar: AvatarBadge | null;
  /** Vehicle class drawn, and its physics geometry (suspension rays, steering lock). */
  readonly vehicle: VehicleClass;
  readonly spec: VehicleSpec;
  /** Compression that puts the wheels on the ground with the body at its ride height (no ground query, or upside down). */
  private readonly settled: number;
  /** Most compression a drawn wheel shows (settled + CarVisual.maxRise): past it the tyre would enter the bodywork. */
  private readonly maxComp: number;
  /**
   * Per drawn wheel standing for a front and a rear ray pair (the bike's): its share of the way from the rear
   * pair to the front one at its rest z, so it rides the line between their compressions, not their mean
   * at a pair 0.6 m away (which leaves the road first over a crest). Null for a wheel on its own ray.
   */
  private readonly wheelK: readonly (number | null)[];
  /** Drawn compression per drawn wheel this frame (wheelComps). */
  private readonly comps: number[];
  /**
   * Ride up rather than sink the tyres (a realistic model, whose free travel is its own and can be 2 cm):
   * see wheelComps. Procedural vehicles keep the cap.
   */
  private readonly liftBody: boolean;
  private readonly ghost: boolean;
  /** Soft contact shadow on the ground (not on ghosts); grounds the car on every tier, even without shadows. */
  private readonly blob: THREE.Mesh | null = null;
  /** Lamp glow (not on ghosts), shown while CAR_FX.halos is on. */
  private readonly halo: THREE.Mesh | null;
  private spin = 0;
  private shown = true;
  private avatarFade = 1;
  /** Drawn bike lean or truck roll (rad), and when it was last eased (performance.now ms; -1: snap to the next value). */
  private body = 0;
  private bodyAt = -1;
  private flameNitro = false;
  private kick = 0;

  constructor(
    readonly scene: THREE.Scene,
    opts: CarViewOptions,
  ) {
    this.ghost = opts.ghost ?? false;
    this.vehicle = opts.vehicle ?? DEFAULT_VEHICLE;
    this.spec = vehicleSpec(this.vehicle);
    this.settled = this.spec.ray - this.spec.wheels[0].y - this.spec.rideHeight;
    this.visual = buildVehicle(this.vehicle, opts.color, this.ghost, opts.body ?? DEFAULT_CAR_BODY, opts.model ?? null);
    this.maxComp = this.settled + this.visual.maxRise;
    this.comps = this.visual.wheels.map(() => 0);
    this.liftBody = !!this.visual.model && Number.isFinite(this.visual.maxRise);
    const W = this.spec.wheels;
    const zf = W[0].z, zr = W[2].z;
    this.wheelK = this.visual.wheelSrc.map((src, i) =>
      src.length > 1 && zf > zr ? (this.visual.pivots[i].position.z - zr) / (zf - zr) : null,
    );
    markEnvLit(this.visual.root);
    this.halo = haloMesh(this.visual.lights);
    // In the lamps' own group, so the glow leans and rolls with them.
    if (this.halo) this.visual.lamps.add(this.halo);
    scene.add(this.visual.root);
    // A scene sibling rather than a child of the car, so it stays above the car in world up
    // when the car rolls or flips. Taller bodies (the truck) lift it clear of their roof.
    this.avatar = opts.avatar ? new AvatarBadge(opts.avatar, avatarLift(this.visual.top)) : null;
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
      const [w, l] = BLOB[this.vehicle] ?? BLOB.car;
      this.blob.scale.set(w / 2.6, 1, l / 5.4);
      scene.add(this.blob);
    }
  }

  /** Drawn bike lean (rad, + to the right; 0 for other classes): the hood camera can roll with it (CameraRig.lean). */
  get lean(): number {
    return this.visual.lean ? this.body : 0;
  }

  /**
   * Nitro push strength from the last apply() or applyPose() (nitroKick: 1 at the press, fading with the
   * push, 0 when not boosting): the mode hands it to CameraRig.boost each frame for the FOV kick.
   */
  get boost(): number {
    return this.kick;
  }

  /** Place the car at an interpolated pose and animate wheels. */
  apply(prev: PoseSnapshot, cur: CarState, alpha: number): void {
    const p = vlerp(prev.pos, cur.pos, alpha);
    const q = qslerp(prev.rot, cur.rot, alpha);
    this.setPose(p, q);
    this.placeBlob(p, q, cur);
    this.spin = cur.wheelSpin;
    const S = this.spec;
    const v = this.visual;
    // The lock the physics allows at this speed, so the front wheels show the steering easing off when fast.
    const steerVis = cur.steer * maxSteerAngle(speedOf(cur), S) * v.steerScale;
    const compOf = (k: number): number => (cur.contact[k] ? cur.comp[k] : Math.max(0, cur.comp[k]));
    const lift = this.wheelComps(compOf);
    if (lift > 0) v.root.translateY(lift);
    v.wheels.forEach((w, i) => {
      // Wheel centre sits where the suspension ray meets the ground, lifted by the radius (wheelComps).
      const src = v.wheelSrc[i];
      const comp = this.comps[i];
      const r = v.wheelR?.[i] ?? S.wheelRadius;
      w.parent!.position.y = S.wheels[src[0]].y - (S.ray - comp) + r;
      // The physics spins its own radius: a smaller drawn tyre turns faster to roll at the same speed.
      w.rotation.x = v.wheelR ? (this.spin * S.wheelRadius) / r : this.spin;
      if (v.steered[i]) w.parent!.rotation.y = -steerVis;
    });
    v.update?.();
    // Cornering force from the yaw rate: forward speed times yaw rate (+ when turning left).
    if (v.lean || v.roll) this.poseBody(vdot(cur.vel, forwardOf(cur)) * vdot(cur.angVel, upOf(cur)));
    this.showBoost(cur.nitroTime, cur.boostTime, cur.boostPower);
  }

  /**
   * Ghost / replay pose: no wheel data is recorded, so each wheel is put on the ground with the
   * same ray as the physics (downforce squats the body at speed), and the front wheels turn by the
   * lock allowed at `speed` (m/s), as the live car shows. A bike leans for `yawRate` (rad/s, +
   * turning left) when one is given, else for the turn its steering makes at that speed.
   * `nitroTime` is the recorded push's seconds left (game/ghost.ts ghostNitro): a replay shows its
   * flames and hands its FOV kick to the camera (boost), as a live run does; pad boosts are not recorded.
   */
  applyPose(p: V3, q: Quat, steer: number, spinDelta: number, speed = 0, yawRate?: number, nitroTime = 0): void {
    this.setPose(p, q);
    this.placeBlob(p, q, null);
    this.showBoost(nitroTime, 0, 0);
    this.spin += spinDelta;
    const S = this.spec;
    const v = this.visual;
    const up = qrotate(q, { x: 0, y: 1, z: 0 });
    const g = CAR_FX.ground;
    const lock = maxSteerAngle(speed, S);
    const compAt = (k: number): number => {
      // Without a ground query (the editor) or upside down: the settled compression.
      if (!g || up.y <= 0.15) return this.settled;
      // Same ray as stepCar: distance along -up from the wheel anchor to the surface plane.
      const a = qrotate(q, S.wheels[k]);
      const ay = p.y + a.y;
      const h = g(p.x + a.x, ay, p.z + a.z);
      const den = up.x * h.nx + up.y * h.ny + up.z * h.nz;
      return den > 0.2 ? Math.min(S.ray, Math.max(0, S.ray - ((ay - h.y) * h.ny) / den)) : 0;
    };
    const lift = this.wheelComps(compAt);
    if (lift > 0) v.root.translateY(lift);
    v.wheels.forEach((w, i) => {
      const src = v.wheelSrc[i];
      const comp = this.comps[i];
      const r = v.wheelR?.[i] ?? S.wheelRadius;
      w.parent!.position.y = S.wheels[src[0]].y - (S.ray - comp) + r;
      w.rotation.x = v.wheelR ? (this.spin * S.wheelRadius) / r : this.spin;
      if (v.steered[i]) w.parent!.rotation.y = -steer * lock * v.steerScale;
    });
    v.update?.();
    if (v.lean || v.roll) {
      const lat =
        yawRate !== undefined
          ? speed * yawRate
          : (-speed * speed * Math.tan(clamp(steer, -1, 1) * lock)) / Math.max(1, S.wheels[0].z - S.wheels[2].z);
      this.poseBody(clamp(lat, -GHOST_LAT_MAX, GHOST_LAT_MAX));
    }
  }

  /**
   * The drawn wheels' compressions (into this.comps) from their rays' (`at`), capped at maxComp so a tyre
   * never rises into the cab, the fairing or the arch. A procedural vehicle's tyre then sinks into the road
   * on a hard landing. A realistic model rides up instead: its free travel is measured from its own arches
   * (riseLimit, as little as 2 cm), so a Sport car's squat at speed would sink its tyres all the time. It
   * is drawn higher by the mean compression beyond maxComp (the returned lift, m along the body's up) and
   * its wheels are drawn from there, on the road and still clear of the arches.
   */
  private wheelComps(at: (k: number) => number): number {
    const c = this.comps;
    let over = 0;
    for (let i = 0; i < c.length; i++) {
      c[i] = this.wheelComp(i, at);
      over += Math.max(0, c[i] - this.maxComp);
    }
    const lift = this.liftBody && c.length ? over / c.length : 0;
    for (let i = 0; i < c.length; i++) c[i] = Math.min(c[i] - lift, this.maxComp);
    return lift;
  }

  /**
   * Compression of drawn wheel i from its rays' compressions (`at`), uncapped: its own ray's, or for a wheel
   * standing for a front and a rear pair (the bike's) the pairs' means interpolated to where it is drawn.
   */
  private wheelComp(i: number, at: (k: number) => number): number {
    const src = this.visual.wheelSrc[i];
    const k = this.wheelK[i];
    let comp: number;
    if (k === null) {
      comp = 0;
      for (const r of src) comp += at(r);
      comp /= src.length;
    } else {
      const cf = (at(0) + at(1)) / 2;
      const cr = (at(2) + at(3)) / 2;
      comp = cr + (cf - cr) * k;
    }
    return comp;
  }

  /** Hides the car, its badge and its contact shadow together. */
  setVisible(v: boolean): void {
    this.visual.root.visible = v;
    this.shown = v;
    if (this.blob && !v) this.blob.visible = false;
    // Back in view, the lean snaps to the current turn rather than easing from a stale one.
    if (!v) this.bodyAt = -1;
    this.syncAvatar();
  }

  /** Bike lean or truck roll for a lateral acceleration (m/s^2, + turning left), eased over BODY_TAU. */
  private poseBody(lat: number): void {
    const v = this.visual;
    const target = v.lean ? leanFor(lat) : rollFor(lat);
    const now = performance.now();
    this.body = this.bodyAt < 0 ? target : easeToward(this.body, target, Math.min(0.1, (now - this.bodyAt) / 1000));
    this.bodyAt = now;
    (v.lean ?? v.roll)!.rotation.z = this.body;
  }

  /** Flames and the FOV kick for a nitro push (seconds left) or, without one, a boost pad's push. */
  private showBoost(nitroTime: number, boostTime: number, boostPower: number): void {
    this.kick = nitroKick(nitroTime);
    if (this.kick > 0) {
      const f = nitroFlame(this.kick);
      this.setFlames(true, f.len, true, f.width);
    } else this.setFlames(boostTime > 0, boostPower > 20 ? 1.6 : 1.1, false);
  }

  /**
   * Exhaust flames while a boost pad or the nitro pushes: longer, wider and violet for the nitro, grown
   * from their base at the pipe (stretchFlame). All flames share one material, so the colour change is a
   * uniform, not a new shader. Ghosts have none. The flicker is render-only (Math.random), so the
   * simulation stays deterministic.
   */
  private setFlames(on: boolean, len: number, nitro: boolean, width = 1): void {
    const fl = this.visual.flames;
    if (!fl.length) return;
    if (nitro !== this.flameNitro) {
      this.flameNitro = nitro;
      (fl[0].material as THREE.MeshBasicMaterial).color.setHex(nitro ? NITRO_FLAME : BOOST_FLAME);
    }
    for (const f of fl) {
      f.visible = on;
      if (on) stretchFlame(f, (0.7 + Math.random() * 0.6) * len, width);
    }
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
      k = Math.min(1, Math.max(0, 1 - (p.y - g.y - this.spec.rideHeight) / 1.5));
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
        // A pose has no wheel data: the same settled compression applyPose stands its wheels on.
        comp += cur ? cur.comp[i] : this.settled;
      }
      k = n / 4;
      b.position.copy(this.visual.root.position);
      b.quaternion.copy(this.visual.root.quaternion);
      if (n) b.translateY(this.spec.wheels[0].y - this.spec.ray + comp / n + DECK_LIFT + 0.015);
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
    // The lamp glow is this view's own (a realistic model's dispose frees only what the instance owns,
    // and never sees it). Safe to run twice; the halo texture is shared and stays.
    if (this.halo) {
      this.halo.removeFromParent();
      this.halo.geometry.dispose();
      (this.halo.material as THREE.Material).dispose();
    }
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
  /** Particles alive after the last update (or emitted since): 0 means nothing to draw or upload. */
  private live = 0;
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
    // Hidden while no particle is alive: no draw call and no buffer upload on a clean straight.
    this.points.visible = false;
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
    this.live++;
  }

  update(dt: number): void {
    // Nothing alive: the buffers already say so (alpha 0), so skip the loop and the uploads.
    if (this.live === 0) return;
    let live = 0;
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
      if (this.life[i] > 0) live++;
    }
    this.live = live;
    this.points.visible = live > 0;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.live = 0;
    this.points.visible = false;
  }

  dispose(): void {
    this.points.parent?.remove(this.points);
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
