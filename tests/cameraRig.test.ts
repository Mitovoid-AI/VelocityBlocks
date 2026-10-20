// Driving cameras per vehicle class: the car's offsets unchanged, the hood eye of the bike and the
// truck clear of their own bodies at the near plane, chase sight lines over the vehicle, the bike's
// leaning hood view, and the nitro FOV kick.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VEHICLE_CLASSES, type VehicleClass } from '../src/core/vehicles';
import { NITRO_TIME, vehicleSpec } from '../src/physics/vehicle';
import { BIKE_LEAN_MAX } from '../src/render/bikeMesh';
import { camOffsets, CameraRig, hoodLeanMax, type CamMode } from '../src/render/cameraRig';
import type { CarVisual } from '../src/render/carMesh';
import { nitroKick } from '../src/render/carView';
import { buildVehicle } from '../src/render/vehicleMesh';

const NEAR = 0.3;
const ORIGIN = { x: 0, y: 0, z: 0 };
const LEVEL = { x: 0, y: 0, z: 0, w: 1 };
const STILL = { x: 0, y: 0, z: 0 };

function rigFor(vehicle: VehicleClass, mode: CamMode, aspect = 16 / 9): CameraRig {
  const rig = new CameraRig(new THREE.PerspectiveCamera(70, aspect, NEAR, 4000));
  rig.vehicle = vehicle;
  rig.mode = mode;
  return rig;
}

/**
 * Camera-facing triangle points (corners, edge midpoints, centroids) of the visual that lie in front
 * of the camera but nearer than the near plane, inside a frustum of the given half-angles: they would
 * be cut open on screen.
 */
function nearClips(cam: THREE.PerspectiveCamera, v: CarVisual, vHalf: number, hHalf: number): string[] {
  cam.updateMatrixWorld(true);
  v.root.updateMatrixWorld(true);
  const inv = cam.matrixWorldInverse;
  const eye = cam.position;
  const tv = Math.tan(vHalf);
  const th = Math.tan(hHalf);
  const flames = new Set<THREE.Object3D>(v.flames);
  const out: string[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p = new THREE.Vector3();
  v.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || flames.has(o)) return;
    const pos = o.geometry.attributes.position;
    const ix = o.geometry.index;
    const tris = (ix ? ix.count : pos.count) / 3;
    for (let t = 0; t < tris; t++) {
      const [i0, i1, i2] = [0, 1, 2].map((k) => (ix ? ix.getX(t * 3 + k) : t * 3 + k));
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      if (n.dot(e1.subVectors(eye, a)) <= 0) continue; // seen from behind: culled
      const samples = [a, b, c, a.clone().add(b).multiplyScalar(0.5), b.clone().add(c).multiplyScalar(0.5), c.clone().add(a).multiplyScalar(0.5), a.clone().add(b).add(c).divideScalar(3)];
      for (const s of samples) {
        p.copy(s).applyMatrix4(inv);
        const depth = -p.z;
        if (depth > 1e-4 && depth < NEAR && Math.abs(p.x) < depth * th && Math.abs(p.y) < depth * tv) {
          out.push(`${(o.material as THREE.MeshStandardMaterial).color.getHexString()} depth ${depth.toFixed(3)} at ${s.toArray().map((x) => x.toFixed(2))}`);
        }
      }
    }
  });
  return out;
}

const deg = (d: number) => (d * Math.PI) / 180;
/** Widest hood view: 78 degrees + 20 at speed + 6 for the nitro, vertical, on a 16:9 screen. */
const HOOD_V = deg(52);
const HOOD_H = Math.atan(Math.tan(HOOD_V) * (16 / 9));

describe('camera offsets', () => {
  it('keeps the car where it always was', () => {
    expect(camOffsets('car')).toEqual({ hood: [0.85, 0.4], chase: [7.2, 2.6], far: [10.5, 4.2], look: 1.1, showcase: [8.5, 1.7, 0.4] });
  });

  it('sits the bike closer and the truck further back and higher', () => {
    const [car, bike, truck] = (['car', 'bike', 'truck'] as const).map(camOffsets);
    for (const k of ['chase', 'far'] as const) {
      expect(bike[k][0]).toBeLessThan(car[k][0]);
      expect(truck[k][0]).toBeGreaterThan(car[k][0]);
      expect(truck[k][1]).toBeGreaterThan(car[k][1]);
    }
    expect(truck.showcase[0]).toBeGreaterThan(car.showcase[0]);
  });

  it.each(['bike', 'truck'] as const)('keeps the %s hood eye clear of its own body at the near plane', (cls) => {
    const v = buildVehicle(cls, '#e8452c');
    const rig = rigFor(cls, 'hood');
    rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
    expect(nearClips(rig.cam, v, HOOD_V, HOOD_H)).toEqual([]);
  });

  it('keeps the leaning bike clear of the hood eye, with and without the camera following the lean', () => {
    for (const lean of [-BIKE_LEAN_MAX, BIKE_LEAN_MAX]) {
      for (const follow of [false, true]) {
        const v = buildVehicle('bike', '#e8452c');
        v.lean!.rotation.z = lean;
        const rig = rigFor('bike', 'hood');
        rig.lean = follow ? lean : 0;
        rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
        expect(nearClips(rig.cam, v, HOOD_V, HOOD_H), `lean ${lean} follow ${follow}`).toEqual([]);
      }
    }
  });

  it('rolls the bike hood view half as much as the bike, and rides with the rider', () => {
    const upright = rigFor('bike', 'hood');
    upright.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
    const rig = rigFor('bike', 'hood');
    rig.lean = 0.6;
    rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
    // Leaning right (+): the eye moves to the right (-x) and down, the horizon tilts by half the lean.
    expect(rig.cam.position.x).toBeLessThan(-0.3);
    expect(rig.cam.position.y).toBeLessThan(upright.cam.position.y);
    const roll = Math.atan2(-rig.cam.up.x, rig.cam.up.y);
    expect(roll).toBeCloseTo(0.3, 6);
    // Other classes ignore it.
    const car = rigFor('car', 'hood');
    car.lean = 0.6;
    car.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
    expect(car.cam.up.x).toBeCloseTo(0, 9);
  });

  it('keeps the leaning bike hood eye over its hull, so a barrier the hull is against never hides it', () => {
    const w = vehicleSpec('bike').foot.w;
    expect(hoodLeanMax()).toBeGreaterThan(0.2);
    expect(hoodLeanMax()).toBeLessThan(BIKE_LEAN_MAX);
    for (const lean of [-BIKE_LEAN_MAX, -0.4, 0.4, BIKE_LEAN_MAX]) {
      const rig = rigFor('bike', 'hood');
      rig.lean = lean;
      rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
      expect(Math.abs(rig.cam.position.x), `lean ${lean}`).toBeLessThanOrEqual(w - 0.05 + 1e-9);
      // Still on the lean's side.
      expect(Math.sign(rig.cam.position.x)).toBe(-Math.sign(lean));
    }
  });

  it.each(VEHICLE_CLASSES)('looks over the %s from the chase and far cameras', (cls) => {
    for (const mode of ['chase', 'far'] as const) {
      const v = buildVehicle(cls, '#e8452c');
      v.root.updateMatrixWorld(true);
      const rig = rigFor(cls, mode);
      rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
      const look = new THREE.Vector3(0, camOffsets(cls).look, 4);
      const from = rig.cam.position.clone();
      const ray = new THREE.Raycaster(from, look.clone().sub(from).normalize(), 0, from.distanceTo(look));
      const meshes: THREE.Mesh[] = [];
      v.root.traverse((o) => {
        if (o instanceof THREE.Mesh) meshes.push(o);
      });
      // The screen centre shows the road ahead, not the vehicle's roof or box.
      expect(ray.intersectObjects(meshes, false), `${cls} ${mode}`).toEqual([]);
    }
  });
});

describe('nitro FOV kick', () => {
  /** The FOV a camera settles at after many frames (setFov eases towards its target). */
  function settled(rig: CameraRig): number {
    for (let i = 0; i < 200; i++) rig.follow(ORIGIN, LEVEL, STILL, 1 / 60, null);
    return rig.cam.fov;
  }

  it('widens the chase and far views by 8 degrees and the hood view by 6 while boosting', () => {
    for (const [mode, kick] of [
      ['chase', 8],
      ['far', 8],
      ['hood', 6],
    ] as const) {
      const base = settled(rigFor('car', mode));
      const rig = rigFor('car', mode);
      rig.boost = 1;
      expect(settled(rig) - base, mode).toBeCloseTo(kick, 0);
    }
  });

  it('kicks out at the press, eases back with the push and settles once it ends (CarView.boost feed)', () => {
    const base = settled(rigFor('car', 'chase'));
    const rig = rigFor('car', 'chase');
    settled(rig);
    const fov: number[] = [];
    const dt = 1 / 60;
    // A whole push at 60 fps, then a second without one.
    for (let t = NITRO_TIME; t > -1; t -= dt) {
      rig.boost = nitroKick(t);
      rig.follow(ORIGIN, LEVEL, STILL, dt, null);
      fov.push(rig.cam.fov - base);
    }
    const pushFrames = Math.round(NITRO_TIME / dt);
    const peak = fov.indexOf(Math.max(...fov));
    // Most of the 8 degrees within a quarter second of the press, never past them.
    expect(Math.max(...fov.slice(0, 15))).toBeGreaterThan(6);
    expect(Math.max(...fov)).toBeLessThanOrEqual(8 + 1e-9);
    expect(peak).toBeLessThan(pushFrames / 2);
    // Easing back while the push fades, then gone within half a second of its end.
    expect(fov[pushFrames - 1]).toBeLessThan(fov[peak] - 3);
    expect(Math.abs(fov[pushFrames + 30])).toBeLessThan(0.5);
  });

  it('leaves the menu orbit and the garage alone', () => {
    const rig = rigFor('truck', 'chase');
    rig.boost = 1;
    for (let i = 0; i < 200; i++) rig.orbit(0, 0, 0, 50, i);
    expect(rig.cam.fov).toBeCloseTo(55, 0);
    for (let i = 0; i < 200; i++) rig.showcase(ORIGIN, i * 0.1, 0.5);
    expect(rig.cam.fov).toBeCloseTo(50, 0);
  });
});

describe('garage view', () => {
  it.each(VEHICLE_CLASSES)('frames the %s at its own distance', (cls) => {
    const rig = rigFor(cls, 'chase');
    rig.showcase(ORIGIN, 0, 0);
    const [R, h] = camOffsets(cls).showcase;
    expect(Math.hypot(rig.cam.position.x, rig.cam.position.z)).toBeCloseTo(R, 9);
    expect(rig.cam.position.y).toBeCloseTo(h, 9);
    // Clear of the body.
    expect(R).toBeGreaterThan(vehicleSpec(cls).wheels[0].z + 2);
  });
});
