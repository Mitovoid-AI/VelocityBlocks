// Chase, far and hood cameras for driving, plus a slow orbit for menus and replays and a
// close garage orbit for the profile editor. Distances follow the vehicle class (CameraRig.vehicle).

import * as THREE from 'three';
import { WATER_SURFACE_Y } from '../core/constants';
import type { Quat, V3 } from '../core/vec';
import type { VehicleClass } from '../core/vehicles';
import { vehicleSpec } from '../physics/vehicle';
import type { Track } from '../track/track';
import { bikeEye } from './bikeMesh';
import { truckEye } from './truckMesh';

export type CamMode = 'chase' | 'far' | 'hood';
export const CAM_MODES: CamMode[] = ['chase', 'far', 'hood'];

/**
 * Share of the requested vertical FOV kept on screens wider than 16:9. At 0 a 20:9 phone gets
 * exactly the 16:9 horizontal FOV (no fisheye edges, but less speed kick); at 1 nothing changes.
 */
export const FOV_KEEP = 0.3;

/**
 * Vertical FOV for a screen of the given aspect: unchanged up to 16:9; wider screens narrow it
 * towards the one that shows a 16:9 screen's horizontal FOV, blended by `keep`.
 */
export function fitFov(v: number, aspect: number, keep = FOV_KEEP): number {
  const ref = 16 / 9;
  if (!(aspect > ref)) return v;
  const h = Math.atan(Math.tan((v * Math.PI) / 360) * ref);
  const fitted = (Math.atan(Math.tan(h) / aspect) * 360) / Math.PI;
  return fitted + (v - fitted) * keep;
}

/** Camera placement for a vehicle class, in metres from its body centre. */
export interface CamOffsets {
  /** Hood (driver's eye): up and forward. */
  readonly hood: readonly [number, number];
  /** Chase and far: back and up; the camera looks 4 m ahead at `look` up. */
  readonly chase: readonly [number, number];
  readonly far: readonly [number, number];
  readonly look: number;
  /** Garage orbit: radius, height and the height it looks at. */
  readonly showcase: readonly [number, number, number];
}

let offsets: Record<VehicleClass, CamOffsets> | null = null;

/**
 * Per-class offsets. The car's are the original ones. The bike's eye is just over the rider's helmet
 * and the truck's in the cab behind the screen (both from their meshes, so nothing of the vehicle
 * comes inside the near plane in view); their chase cameras sit closer (bike) or further back and
 * higher (truck), so the box never hides the road ahead.
 */
export function camOffsets(vehicle: VehicleClass): CamOffsets {
  if (!offsets) {
    const bike = vehicleSpec('bike');
    const truck = vehicleSpec('truck');
    const be = bikeEye(bike);
    const te = truckEye(truck);
    offsets = {
      car: { hood: [0.85, 0.4], chase: [7.2, 2.6], far: [10.5, 4.2], look: 1.1, showcase: [8.5, 1.7, 0.4] },
      bike: { hood: [be.h - bike.rideHeight, be.z], chase: [6.4, 2.3], far: [9.6, 3.9], look: 0.95, showcase: [6.6, 1.35, 0.3] },
      truck: { hood: [te.h - truck.rideHeight, te.z], chase: [9.6, 3.9], far: [13, 5.4], look: 1.7, showcase: [12, 2.6, 0.9] },
    };
  }
  return offsets[vehicle] ?? offsets.car;
}

/** Share of the bike's lean the hood camera rolls with (a rider holds the head nearer level than the bike). */
const HOOD_ROLL = 0.5;

let leanCap = -1;
/**
 * Largest lean (rad) the bike's hood eye follows: its sideways travel about the ground line stays 5 cm
 * inside the hull's half width (VehicleSpec.foot.w), so it cannot reach into a barrier the hull is against.
 */
export function hoodLeanMax(): number {
  if (leanCap < 0) {
    const S = vehicleSpec('bike');
    const reach = camOffsets('bike').hood[0] + S.rideHeight;
    leanCap = Math.asin(Math.min(1, (S.foot.w - 0.05) / reach));
  }
  return leanCap;
}

const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const left = new THREE.Vector3();
/** follow()'s scratch objects: it runs every frame, so it allocates nothing. */
const quat = new THREE.Quaternion();
const want = new THREE.Vector3();
const lookAt = new THREE.Vector3();

export class CameraRig {
  mode: CamMode = 'chase';
  /** Vehicle class being followed (camera offsets per class). */
  vehicle: VehicleClass = 'car';
  /**
   * The followed bike's drawn lean (CarView.lean, rad), set by the mode each frame: the hood camera
   * rides with the rider's head and rolls half as much. Ignored for other classes; 0 = upright.
   */
  lean = 0;
  /**
   * Nitro push 0..1 (CarView.boost: 1 at the press, fading with the push, 0 after it), set by the mode each
   * frame: a short FOV kick on the driving views (up to 8 degrees chase and far, 6 hood), eased in and out
   * by setFov. Orbit, garage and trackside views ignore it.
   */
  boost = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private init = false;
  // Stadium extents, cached per track for the wall clamp.
  private extTrack: Track | null = null;
  private ext: { x0: number; z0: number; x1: number; z1: number } | null = null;
  shake = 0;

  constructor(readonly cam: THREE.PerspectiveCamera) {}

  reset(): void {
    this.init = false;
  }

  follow(p: V3, q: Quat, vel: V3, dt: number, track: Track | null): void {
    quat.set(q.x, q.y, q.z, q.w);
    fwd.set(0, 0, 1).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const o = camOffsets(this.vehicle);

    if (this.mode === 'hood') {
      const [hu, hf] = o.hood;
      tmp.set(p.x, p.y, p.z).addScaledVector(fwd, hf);
      const a = this.vehicle === 'bike' ? this.lean : 0;
      if (a) {
        // The eye leans with the bike about the ground line under the centre, but never further out than
        // the hull (hoodLeanMax): leaning against a barrier, a full lean would put it inside the wall.
        const rh = vehicleSpec('bike').rideHeight;
        const e = Math.max(-hoodLeanMax(), Math.min(hoodLeanMax(), a));
        left.set(1, 0, 0).applyQuaternion(quat);
        tmp.addScaledVector(left, -(hu + rh) * Math.sin(e)).addScaledVector(up, (hu + rh) * Math.cos(e) - rh);
        this.cam.up.copy(up).multiplyScalar(Math.cos(a * HOOD_ROLL)).addScaledVector(left, -Math.sin(a * HOOD_ROLL));
      } else {
        tmp.addScaledVector(up, hu);
        this.cam.up.copy(up);
      }
      this.cam.position.copy(tmp);
      this.look.copy(tmp).addScaledVector(fwd, 20).addScaledVector(up, 0.5);
      this.cam.lookAt(this.look);
      this.setFov(78 + Math.min(20, speed * 0.1) + this.boost * 6);
      return;
    }
    this.cam.up.set(0, 1, 0);

    // Heading: car nose, blended towards the direction of travel when sliding fast.
    let hx = fwd.x, hz = fwd.z;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    if (speed > 8) {
      const vx = vel.x / speed, vz = vel.z / speed;
      const vl = Math.hypot(vx, vz) || 1;
      const k = 0.35;
      hx = hx * (1 - k) + (vx / vl) * k;
      hz = hz * (1 - k) + (vz / vl) * k;
      const l2 = Math.hypot(hx, hz) || 1;
      hx /= l2;
      hz /= l2;
    }
    const [back, height] = this.mode === 'far' ? o.far : o.chase;
    const dist = back + Math.min(2.5, speed * 0.02);
    want.set(p.x - hx * dist, p.y + height, p.z - hz * dist);
    if (track) {
      // Off-road the car often stops at the perimeter facing inward: keep the camera inside
      // the stadium so the 3 m wall and the stands never hide the car. The wall's inner face
      // is 0.5 m in and the near plane is 0.3 m. Clamped before the lift so the ground is
      // sampled where the camera will actually be.
      if (track !== this.extTrack || !this.ext) {
        this.extTrack = track;
        this.ext = track.extents();
      }
      const e = this.ext, m = 1.5;
      want.x = Math.min(e.x1 - m, Math.max(e.x0 + m, want.x));
      want.z = Math.min(e.z1 - m, Math.max(e.z0 + m, want.z));
      // Over water the floor is the surface, not the bed below it: the camera stays out of the lake.
      const hit = track.surfaceAt(want.x, want.y, want.z, 0.5);
      const g = hit.surf === 'water' ? WATER_SURFACE_Y : hit.y;
      if (want.y < g + 1.2) want.y = g + 1.2;
      // On the grass beside a slope rising from the floor, the spot behind the car can be inside the
      // solid embankment, where its faces are culled; lift the camera over the top instead.
      const top = track.embankTopAt(want.x, want.z);
      if (top !== null && want.y < top + 1.2) want.y = top + 1.2;
    }
    lookAt.set(p.x + hx * 4, p.y + o.look, p.z + hz * 4);
    if (!this.init) {
      this.pos.copy(want);
      this.look.copy(lookAt);
      this.init = true;
    }
    const kp = 1 - Math.exp(-dt * 9);
    const kl = 1 - Math.exp(-dt * 14);
    this.pos.lerp(want, kp);
    // Never lag too far behind at very high speed.
    const maxLag = dist * 1.6;
    tmp.set(p.x, p.y, p.z);
    if (this.pos.distanceTo(tmp) > maxLag) this.pos.sub(tmp).setLength(maxLag).add(tmp);
    this.look.lerp(lookAt, kl);
    this.cam.position.copy(this.pos);
    if (this.shake > 0) {
      this.cam.position.x += (Math.random() - 0.5) * this.shake;
      this.cam.position.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    this.cam.lookAt(this.look);
    this.setFov(66 + Math.min(24, speed * 0.11) + this.boost * 8);
  }

  /** Slow orbit around a point (menus, replay overviews). */
  orbit(cx: number, cy: number, cz: number, radius: number, t: number): void {
    const a = t * 0.08;
    this.cam.up.set(0, 1, 0);
    this.cam.position.set(cx + Math.cos(a) * radius, cy + radius * 0.38, cz + Math.sin(a) * radius);
    this.cam.lookAt(cx, cy, cz);
    this.setFov(55);
    this.init = false;
  }

  /**
   * Close slow orbit around a parked car (garage view), shifted so the car sits right of
   * centre beside a left-hand panel. shift is in NDC, 0..1.
   */
  showcase(p: V3, t: number, shift: number): void {
    const a = t * 0.3;
    const [R, h, ly] = camOffsets(this.vehicle).showcase;
    const ca = Math.cos(a), sa = Math.sin(a);
    this.cam.up.set(0, 1, 0);
    this.cam.position.set(p.x + ca * R, p.y + h, p.z + sa * R);
    this.setFov(50);
    // Camera right on the ground plane is (sa, 0, -ca); looking k metres left of the car puts
    // it at about +shift NDC.
    const k = R * Math.tan((this.cam.fov * Math.PI) / 360) * this.cam.aspect * shift;
    this.cam.lookAt(p.x - sa * k, p.y + ly, p.z + ca * k);
    this.init = false;
  }

  /** Static trackside camera looking at a target (replays). */
  trackside(from: V3, at: V3): void {
    this.cam.up.set(0, 1, 0);
    this.cam.position.set(from.x, from.y, from.z);
    this.cam.lookAt(at.x, at.y, at.z);
    const d = Math.hypot(from.x - at.x, from.y - at.y, from.z - at.z);
    this.setFov(Math.max(18, Math.min(60, 1400 / Math.max(10, d))));
    this.init = false;
  }

  private setFov(f: number): void {
    const t = fitFov(f, this.cam.aspect);
    if (Math.abs(this.cam.fov - t) > 0.05) {
      this.cam.fov += (t - this.cam.fov) * 0.15;
      this.cam.updateProjectionMatrix();
    }
  }
}
