// Chase, far and hood cameras for driving, plus a slow orbit for menus and replays and a
// close garage orbit for the profile editor.

import * as THREE from 'three';
import type { Quat, V3 } from '../core/vec';
import type { Track } from '../track/track';

export type CamMode = 'chase' | 'far' | 'hood';
export const CAM_MODES: CamMode[] = ['chase', 'far', 'hood'];

const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();

export class CameraRig {
  mode: CamMode = 'chase';
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
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    fwd.set(0, 0, 1).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);
    const speed = Math.hypot(vel.x, vel.y, vel.z);

    if (this.mode === 'hood') {
      tmp.set(p.x, p.y, p.z).addScaledVector(up, 0.85).addScaledVector(fwd, 0.4);
      this.cam.position.copy(tmp);
      this.look.copy(tmp).addScaledVector(fwd, 20).addScaledVector(up, 0.5);
      this.cam.up.copy(up);
      this.cam.lookAt(this.look);
      this.setFov(78 + Math.min(20, speed * 0.1));
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
    const far = this.mode === 'far';
    const dist = (far ? 10.5 : 7.2) + Math.min(2.5, speed * 0.02);
    const height = far ? 4.2 : 2.6;
    const want = new THREE.Vector3(p.x - hx * dist, p.y + height, p.z - hz * dist);
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
      const g = track.surfaceAt(want.x, want.y, want.z, 0.5).y;
      if (want.y < g + 1.2) want.y = g + 1.2;
      // On the grass beside a slope rising from the floor, the spot behind the car can be inside the
      // solid embankment, where its faces are culled; lift the camera over the top instead.
      const top = track.embankTopAt(want.x, want.z);
      if (top !== null && want.y < top + 1.2) want.y = top + 1.2;
    }
    const lookAt = new THREE.Vector3(p.x + hx * 4, p.y + 1.1, p.z + hz * 4);
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
    this.setFov(66 + Math.min(24, speed * 0.11));
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
    const R = 8.5;
    const ca = Math.cos(a), sa = Math.sin(a);
    this.cam.up.set(0, 1, 0);
    this.cam.position.set(p.x + ca * R, p.y + 1.7, p.z + sa * R);
    this.setFov(50);
    // Camera right on the ground plane is (sa, 0, -ca); looking k metres left of the car puts
    // it at about +shift NDC.
    const k = R * Math.tan((this.cam.fov * Math.PI) / 360) * this.cam.aspect * shift;
    this.cam.lookAt(p.x - sa * k, p.y + 0.4, p.z + ca * k);
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
    if (Math.abs(this.cam.fov - f) > 0.05) {
      this.cam.fov += (f - this.cam.fov) * 0.15;
      this.cam.updateProjectionMatrix();
    }
  }
}
