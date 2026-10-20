// CarView pieces that are not the car mesh itself: the suspension ray it shares with the physics,
// the contact shadow (on the ground, also in replays and jumps), the environment tagging, and per
// vehicle class the wheels on the rays, the bike's lean, the truck's roll and the flames.

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAVITY } from '../src/core/constants';
import { VEHICLE_CLASSES } from '../src/core/vehicles';
import { createCar, forwardOf, NITRO_TIME, upOf, vehicleSpec, type CarState } from '../src/physics/vehicle';
import { BIKE_LEAN_MAX } from '../src/render/bikeMesh';
import { FLAME_LEN } from '../src/render/carMesh';
import {
  BODY_TAU,
  CAR_FX,
  CarView,
  easeToward,
  leanFor,
  NITRO_FLAME,
  nitroFlame,
  nitroKick,
  RAY,
  rollFor,
  vehicleFx,
} from '../src/render/carView';
import { DECK_LIFT } from '../src/render/trackMesh';
import { TRUCK_ROLL_MAX } from '../src/render/truckMesh';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

const track = new Track(campaign()[0].data);

const blobOf = (scene: THREE.Scene) => scene.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh | undefined;

describe('CarView', () => {
  afterEach(() => {
    CAR_FX.ground = null;
  });

  it('uses the suspension ray of the physics (wheels touch the road at rest)', () => {
    const c = createCar(track);
    const y = track.spawn().y;
    for (let i = 0; i < 4; i++) expect(c.pos.y - 0.15 - (RAY - c.comp[i])).toBeCloseTo(y, 6);
  });

  it('lays the contact shadow on the road and fades it out in the air', () => {
    CAR_FX.ground = (x, y, z) => track.surfaceAt(x, y, z, 0.2);
    const scene = new THREE.Scene();
    const v = new CarView(scene, { color: '#e8452c' });
    const blob = blobOf(scene)!;
    expect(blob).toBeDefined();
    const c = createCar(track);
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    const mat = blob.material as THREE.MeshBasicMaterial;
    expect(blob.visible).toBe(true);
    expect(blob.position.y).toBeCloseTo(track.spawn().y + DECK_LIFT + 0.015, 6);
    expect(mat.opacity).toBeCloseTo(CAR_FX.contactOpacity, 2);

    // Replays pose the car without wheel data: a jump must not leave the shadow hanging in mid-air.
    v.applyPose({ ...c.pos, y: c.pos.y + 0.75 }, c.rot, 0, 0);
    expect(blob.visible).toBe(true);
    expect(blob.position.y).toBeCloseTo(track.spawn().y + DECK_LIFT + 0.015, 6);
    expect(mat.opacity).toBeLessThan(CAR_FX.contactOpacity * 0.7);
    v.applyPose({ ...c.pos, y: c.pos.y + 3 }, c.rot, 0, 0);
    expect(blob.visible).toBe(false);

    v.applyPose(c.pos, c.rot, 0, 0);
    expect(blob.visible).toBe(true);
    v.setVisible(false);
    expect(blob.visible).toBe(false);
    v.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('gives ghosts no contact shadow', () => {
    const scene = new THREE.Scene();
    const v = new CarView(scene, { color: '#7fd3ff', ghost: true });
    expect(scene.children).toEqual([v.visual.root]);
    v.dispose();
  });

  it('tags the metallic car materials for the environment map', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c' });
    const tagged = new Set<THREE.Material>();
    v.visual.root.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.Material).userData.envLit) tagged.add(o.material);
    });
    expect(tagged.size).toBeGreaterThanOrEqual(3);
    v.dispose();
  });
});

/** A state turning at `yawRate` (rad/s, + left) at `speed` (m/s) along its own heading. */
function turning(c: CarState, speed: number, yawRate: number): CarState {
  const f = forwardOf(c);
  const u = upOf(c);
  return { ...c, vel: { x: f.x * speed, y: f.y * speed, z: f.z * speed }, angVel: { x: u.x * yawRate, y: u.y * yawRate, z: u.z * yawRate } };
}

describe.each(VEHICLE_CLASSES)('%s CarView', (cls) => {
  const S = vehicleSpec(cls);

  it('stands its drawn wheels on the suspension rays (a bike wheel between its front and rear pairs)', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: cls });
    expect(v.vehicle).toBe(cls);
    expect(v.visual.vehicle).toBe(cls);
    expect(v.visual.wheels.length).toBe(cls === 'bike' ? 2 : 4);
    const restZ = v.visual.pivots.map((p) => p.position.z);
    const c = createCar(track, cls);
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    v.visual.root.updateMatrixWorld(true);
    const y = track.spawn().y;
    for (const w of v.visual.wheels) expect(w.getWorldPosition(new THREE.Vector3()).y - S.wheelRadius).toBeCloseTo(y, 6);

    // Uneven compressions: a wheel on its own ray rides it; a bike wheel rides the line between the front
    // and rear pairs' means at its drawn z (not the far pair's mean, which leaves the road first on a crest).
    const settled = S.ray - S.wheels[0].y - S.rideHeight;
    const comps = [0.05, 0.12, 0.2, 0.31].map((k) => k * (settled / 0.21));
    const drawn = (i: number, cs: readonly number[]) => {
      const src = v.visual.wheelSrc[i];
      if (src.length === 1) return cs[src[0]];
      const cf = (cs[0] + cs[1]) / 2, cr = (cs[2] + cs[3]) / 2;
      const k = (restZ[i] - S.wheels[2].z) / (S.wheels[0].z - S.wheels[2].z);
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(1);
      return cr + (cf - cr) * k;
    };
    const check = (cs: number[]) => {
      v.apply({ pos: c.pos, rot: c.rot }, { ...c, comp: cs }, 1);
      v.visual.wheels.forEach((w, i) => {
        const src = v.visual.wheelSrc[i];
        const comp = Math.min(drawn(i, cs), settled + v.visual.maxRise);
        expect(w.parent!.position.y).toBeCloseTo(S.wheels[src[0]].y - (S.ray - comp) + S.wheelRadius, 9);
      });
    };
    check(comps);
    // The bike's front pair off the road over a crest: the drawn front wheel stays near the rear pair's.
    check([0, 0, settled, settled]);
    // Bottomed out: the car's open wheels follow the springs; the bike's and the truck's stop at maxRise,
    // where their bodywork still clears them (tests/vehicleBodies.test.ts).
    check([S.ray, S.ray, S.ray, S.ray]);
    const top = Math.max(...v.visual.wheels.map((w) => w.parent!.position.y));
    if (cls === 'car') expect(v.visual.maxRise).toBe(Infinity);
    else expect(top).toBeCloseTo(S.wheels[0].y - (S.ray - settled - v.visual.maxRise) + S.wheelRadius, 9);
    // A pose (ghost, replay) is capped the same way.
    CAR_FX.ground = () => ({ y: c.pos.y + 0.2, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null });
    v.applyPose(c.pos, c.rot, 0, 0);
    for (const w of v.visual.wheels) expect(w.parent!.position.y).toBeLessThanOrEqual(top + 1e-9);
    CAR_FX.ground = null;
    v.dispose();
  });

  it('turns only the steered wheels, by the class lock', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: cls });
    const c = { ...createCar(track, cls), steer: 1 };
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    v.visual.wheels.forEach((w, i) => {
      if (v.visual.steered[i]) expect(w.parent!.rotation.y).toBeCloseTo(-S.steerLock * v.visual.steerScale, 6);
      else expect(w.parent!.rotation.y).toBe(0);
    });
    v.dispose();
  });

  it('draws its ghost without shadow, lamps or flames, and poses it without a track', () => {
    const scene = new THREE.Scene();
    const g = new CarView(scene, { color: '#7fd3ff', ghost: true, vehicle: cls });
    expect(scene.children).toEqual([g.visual.root]);
    expect(g.visual.flames).toEqual([]);
    expect(g.visual.root.getObjectByName('halos')).toBeUndefined();
    const c = createCar(track, cls);
    // No ground query: every wheel at the settled compression, so on a road rideHeight under the centre.
    g.applyPose(c.pos, c.rot, 0, 0.1, 0);
    g.visual.root.updateMatrixWorld(true);
    for (const w of g.visual.wheels) {
      expect(w.getWorldPosition(new THREE.Vector3()).y - S.wheelRadius).toBeCloseTo(c.pos.y - S.rideHeight, 6);
    }
    g.dispose();
    expect(scene.children.length).toBe(0);
  });
});

describe('vehicle body motion', () => {
  it('leans the bike into a turn, about atan(a/g), capped', () => {
    expect(leanFor(0)).toBeCloseTo(0, 12);
    // A right turn (negative lateral) leans right: +z rotation, the -x side down.
    expect(leanFor(-9)).toBeCloseTo(0.8 * Math.atan(9 / GRAVITY), 9);
    expect(leanFor(9)).toBeCloseTo(-0.8 * Math.atan(9 / GRAVITY), 9);
    expect(leanFor(-1000)).toBe(BIKE_LEAN_MAX);
    expect(BIKE_LEAN_MAX).toBeLessThanOrEqual(0.7);
  });

  it('rolls the truck out of a turn, a few degrees at most', () => {
    expect(rollFor(-6)).toBeLessThan(0);
    expect(rollFor(6)).toBeGreaterThan(0);
    expect(rollFor(-1000)).toBe(-TRUCK_ROLL_MAX);
    expect(TRUCK_ROLL_MAX).toBeLessThanOrEqual(0.1);
  });

  it('eases the lean independently of the frame rate', () => {
    expect(easeToward(0, 1, 0)).toBe(0);
    expect(easeToward(easeToward(0, 1, 0.05), 1, 0.05)).toBeCloseTo(easeToward(0, 1, 0.1), 12);
    expect(easeToward(0, 1, BODY_TAU)).toBeCloseTo(1 - Math.exp(-1), 12);
  });

  it('leans a live bike from its yaw rate', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: 'bike' });
    const c = turning(createCar(track, 'bike'), 30, -0.3);
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    expect(v.visual.lean!.rotation.z).toBeCloseTo(leanFor(-9), 9);
    expect(v.lean).toBeGreaterThan(0.4);
    v.dispose();
  });

  it('rolls a live truck outward, capped', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: 'truck' });
    const c = turning(createCar(track, 'truck'), 40, -1);
    v.apply({ pos: c.pos, rot: c.rot }, c, 1);
    expect(v.visual.roll!.rotation.z).toBe(-TRUCK_ROLL_MAX);
    expect(v.lean).toBe(0);
    v.dispose();
  });

  it('leans a ghost bike from its yaw rate, or from its steering when none is given', () => {
    const g = new CarView(new THREE.Scene(), { color: '#7fd3ff', ghost: true, vehicle: 'bike' });
    const c = createCar(track, 'bike');
    g.applyPose(c.pos, c.rot, 0, 0, 30, -0.3);
    expect(g.lean).toBeCloseTo(leanFor(-9), 9);
    // Hidden and shown again, the lean snaps to the next pose instead of easing.
    g.setVisible(false);
    g.setVisible(true);
    g.applyPose(c.pos, c.rot, 0.5, 0, 25);
    expect(g.lean).toBeGreaterThan(0.2);
    g.setVisible(false);
    g.setVisible(true);
    g.applyPose(c.pos, c.rot, -0.5, 0, 25);
    expect(g.lean).toBeLessThan(-0.2);
    g.dispose();
  });

  it('keeps cars upright: no lean or roll', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c' });
    expect(v.visual.lean).toBeNull();
    expect(v.visual.roll).toBeNull();
    const c = turning(createCar(track), 30, -0.5);
    expect(() => v.apply({ pos: c.pos, rot: c.rot }, c, 1)).not.toThrow();
    expect(v.lean).toBe(0);
    v.dispose();
  });

  it('shows violet flames while the nitro pushes and cyan ones on a boost pad', () => {
    for (const cls of VEHICLE_CLASSES) {
      const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: cls });
      const fl = v.visual.flames;
      expect(fl.length).toBeGreaterThan(0);
      const c = createCar(track, cls);
      v.apply({ pos: c.pos, rot: c.rot }, { ...c, nitroTime: 1 }, 1);
      expect(fl.every((f) => f.visible)).toBe(true);
      expect((fl[0].material as THREE.MeshBasicMaterial).color.getHex()).toBe(NITRO_FLAME);
      v.apply({ pos: c.pos, rot: c.rot }, { ...c, boostTime: 1, boostPower: 16 }, 1);
      expect(fl.every((f) => f.visible)).toBe(true);
      expect((fl[0].material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x66ccff);
      v.apply({ pos: c.pos, rot: c.rot }, c, 1);
      expect(fl.some((f) => f.visible)).toBe(false);
      v.dispose();
    }
    // A ghost has no flames: a nitro state must not throw.
    const g = new CarView(new THREE.Scene(), { color: '#7fd3ff', ghost: true, vehicle: 'truck' });
    const c = createCar(track, 'truck');
    expect(() => g.apply({ pos: c.pos, rot: c.rot }, { ...c, nitroTime: 1 }, 1)).not.toThrow();
    g.dispose();
  });

  it('fades the nitro kick with the push: full at the press, 35% at its end, nothing after', () => {
    expect(nitroKick(0)).toBe(0);
    expect(nitroKick(-0.01)).toBe(0);
    expect(nitroKick(NITRO_TIME)).toBeCloseTo(1, 12);
    expect(nitroKick(NITRO_TIME * 2)).toBeCloseTo(1, 12);
    expect(nitroKick(1e-6)).toBeCloseTo(0.35, 4);
    let last = 0;
    for (let t = 0.01; t <= NITRO_TIME; t += 0.01) {
      const k = nitroKick(t);
      expect(k).toBeGreaterThan(last);
      last = k;
    }
    // Nitro flames outsize the biggest pad flame (the turbo's 1.6 long, 1 wide) for the whole push.
    for (const k of [0.35, 0.7, 1]) {
      expect(nitroFlame(k).len).toBeGreaterThan(1.6);
      expect(nitroFlame(k).width).toBeGreaterThan(1.1);
    }
    expect(nitroFlame(1).len).toBeGreaterThan(nitroFlame(0.35).len);
  });

  it('draws bigger flames for the nitro and hands the push to the camera (CarView.boost)', () => {
    for (const cls of VEHICLE_CLASSES) {
      const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: cls });
      const fl = v.visual.flames;
      const c = createCar(track, cls);
      const pose = { pos: c.pos, rot: c.rot };
      expect(v.boost).toBe(0);
      // The flicker's middle (Math.random 0.5 scales by exactly 1).
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      v.apply(pose, { ...c, boostTime: 1, boostPower: 30 }, 1);
      for (const f of fl) expect(f.scale.toArray()).toEqual([1, 1.6, 1]);
      expect(v.boost).toBe(0);
      v.apply(pose, { ...c, nitroTime: NITRO_TIME }, 1);
      const big = nitroFlame(1);
      for (const f of fl) {
        expect(f.scale.x).toBeCloseTo(big.width, 12);
        expect(f.scale.y).toBeCloseTo(big.len, 12);
        expect(f.scale.z).toBeCloseTo(big.width, 12);
      }
      rnd.mockRestore();
      expect(v.boost).toBeCloseTo(1, 12);
      v.apply(pose, { ...c, nitroTime: NITRO_TIME / 2 }, 1);
      expect(v.boost).toBeCloseTo(nitroKick(NITRO_TIME / 2), 12);
      // The push ends (or braking cancels it): the kick and the flames go at once.
      v.apply(pose, c, 1);
      expect(v.boost).toBe(0);
      expect(fl.some((f) => f.visible)).toBe(false);
      // A pose (ghost, replay) without a recorded push: flames off, no kick.
      v.apply(pose, { ...c, nitroTime: 1 }, 1);
      v.applyPose(c.pos, c.rot, 0, 0, 20);
      expect(v.boost).toBe(0);
      expect(fl.some((f) => f.visible)).toBe(false);
      // A replay's recorded push (ghostNitro): violet flames and the kick, as live.
      v.applyPose(c.pos, c.rot, 0, 0, 20, undefined, NITRO_TIME / 2);
      expect(v.boost).toBeCloseTo(nitroKick(NITRO_TIME / 2), 12);
      expect(fl.every((f) => f.visible)).toBe(true);
      expect((fl[0].material as THREE.MeshBasicMaterial).color.getHex()).toBe(NITRO_FLAME);
      v.applyPose(c.pos, c.rot, 0, 0, 20, -0.2, 0);
      expect(v.boost).toBe(0);
      expect(fl.some((f) => f.visible)).toBe(false);
      v.dispose();
    }
    // The PB ghost has no flames: a recorded push neither throws nor draws any.
    const g = new CarView(new THREE.Scene(), { color: '#7fd3ff', ghost: true });
    const c = createCar(track);
    expect(() => g.applyPose(c.pos, c.rot, 0, 0, 20, 0, NITRO_TIME)).not.toThrow();
    expect(g.visual.flames).toEqual([]);
    g.dispose();
  });

  it('grows the flames from their base at the pipe: a big flame never reaches into the vehicle', () => {
    for (const cls of VEHICLE_CLASSES) {
      const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: cls });
      const root = v.visual.root;
      const c = createCar(track, cls);
      // The cone's wide end in its parent's frame, and the flame's box in the vehicle's own frame.
      const baseOf = (f: THREE.Mesh) => {
        f.updateMatrix();
        return new THREE.Vector3(0, -FLAME_LEN / 2, 0).applyMatrix4(f.matrix);
      };
      const boxOf = (f: THREE.Mesh) => {
        root.position.set(0, 0, 0);
        root.quaternion.identity();
        root.updateMatrixWorld(true);
        return new THREE.Box3().setFromObject(f);
      };
      const rest = v.visual.flames.map((f) => ({ base: baseOf(f), box: boxOf(f) }));
      // The longest flicker (Math.random 1) of the biggest nitro flame, and of a turbo pad's.
      const rnd = vi.spyOn(Math, 'random').mockReturnValue(1);
      for (const state of [{ nitroTime: NITRO_TIME }, { boostTime: 1, boostPower: 30 }]) {
        v.apply({ pos: c.pos, rot: c.rot }, { ...c, ...state }, 1);
        v.visual.flames.forEach((f, i) => {
          expect(f.scale.y, cls).toBeGreaterThan(2);
          expect(baseOf(f).distanceTo(rest[i].base), cls).toBeLessThan(1e-6);
          const box = boxOf(f);
          const r = rest[i].box;
          if (cls === 'truck') {
            // Up the stacks: nothing grows down into the stack, the cab or the box.
            expect(box.min.y, cls).toBeGreaterThan(r.min.y - 1e-6);
            expect(box.max.y, cls).toBeGreaterThan(r.max.y + 0.5);
          } else {
            // Back from the pipes: nothing grows forward into the muffler, the rider or the bumper.
            expect(box.max.z, cls).toBeLessThan(r.max.z + 1e-6);
            expect(box.min.z, cls).toBeLessThan(r.min.z - 0.5);
          }
        });
      }
      rnd.mockRestore();
      v.dispose();
    }
  });

  it('puts the contact shadow under the wheels of a pose without a ground query', () => {
    for (const cls of VEHICLE_CLASSES) {
      const S = vehicleSpec(cls);
      const scene = new THREE.Scene();
      const v = new CarView(scene, { color: '#e8452c', vehicle: cls });
      const blob = blobOf(scene)!;
      const c = createCar(track, cls);
      v.applyPose(c.pos, c.rot, 0, 0);
      v.visual.root.updateMatrixWorld(true);
      // The wheels stand rideHeight under the centre; the shadow lies there (plus the deck lift).
      for (const w of v.visual.wheels) expect(w.getWorldPosition(new THREE.Vector3()).y - S.wheelRadius).toBeCloseTo(c.pos.y - S.rideHeight, 6);
      expect(blob.visible).toBe(true);
      expect(blob.position.y, cls).toBeCloseTo(c.pos.y - S.rideHeight + DECK_LIFT + 0.015, 6);
      v.dispose();
    }
  });

  it('hangs the lamp glow in the lamps group, so it leans with the bike', () => {
    const v = new CarView(new THREE.Scene(), { color: '#e8452c', vehicle: 'bike' });
    expect(v.visual.lamps.getObjectByName('halos')).toBeDefined();
    v.dispose();
  });

  it('keeps the car on its suspension ray and its original effect placement', () => {
    expect(RAY).toBeCloseTo(vehicleSpec('car').ray, 12);
    expect(vehicleFx('car')).toEqual({ smokeZ: -1.4, smokeX: [-0.9, 0.9], smokeY: -0.45, ghostHide: 3.5 });
    expect(vehicleFx('truck').smokeY).toBeLessThan(vehicleFx('car').smokeY);
    expect(vehicleFx('bike').smokeX).toEqual([0]);
    expect(vehicleFx('truck').smokeZ).toBe(vehicleSpec('truck').wheels[2].z);
    expect(vehicleFx('truck').ghostHide).toBeGreaterThan(vehicleFx('car').ghostHide);
  });
});
