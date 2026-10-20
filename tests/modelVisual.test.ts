// Realistic models as vehicles (src/render/modelVisual.ts): a template from a plain three.js scene built like
// a model file (canonical frame, wheel nodes vb_wheel_*, a vb_paint body and vb_lamp meshes), its instances
// (wheels spinning about their own centres, own paint, one ghost material, nothing shared freed), and
// CarView standing each wheel on its ray by its own radius.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_LAMP, MODEL_PAINT, vehicleModel, type ModelId } from '../src/core/vehicleModels';
import { createCar, vehicleSpec } from '../src/physics/vehicle';
import type { CarVisual } from '../src/render/carMesh';
import { CAR_FX, CarView } from '../src/render/carView';
import { readyModel, storeModel } from '../src/render/modelCache';
import { instantiate, lampsFrom, MODEL_METALNESS_MAX, prepareTemplate, type ModelTemplate } from '../src/render/modelVisual';
import { buildVehicle } from '../src/render/vehicleMesh';
import { campaign } from '../src/track/campaign';
import { Track } from '../src/track/track';

/** A 4.2 m car with a 2.6 m wheelbase, tyres of radius 0.32 standing on y = 0, the body 6 cm above them. */
function fakeCar(): THREE.Group {
  const scene = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ name: MODEL_PAINT, metalness: 1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 4.2), paint);
  // From y 0.7 to 1.3: 0.06 above the tyre tops (0.64).
  body.position.set(0, 1.0, 0);
  scene.add(body);
  const lampMat = new THREE.MeshStandardMaterial({ emissive: 0xffffff });
  const lamps = new THREE.Group();
  lamps.name = MODEL_LAMP;
  for (const [x, z] of [
    [0.6, 2.1],
    [-0.6, 2.1],
    [0.6, -2.1],
    [-0.6, -2.1],
  ]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.02), lampMat);
    l.position.set(x, 0.95, z);
    lamps.add(l);
  }
  scene.add(lamps);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111 });
  for (const [name, x, z] of [
    ['vb_wheel_fl', 0.75, 1.3],
    ['vb_wheel_fr', -0.75, 1.3],
    ['vb_wheel_rl', 0.75, -1.3],
    ['vb_wheel_rr', -0.75, -1.3],
  ] as const) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16).rotateZ(Math.PI / 2), tyre);
    w.name = name;
    w.position.set(x, 0.32, z);
    scene.add(w);
  }
  return scene;
}

function fakeBike(): THREE.Group {
  const scene = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 1.6), new THREE.MeshStandardMaterial());
  frame.position.y = 0.75;
  scene.add(frame);
  for (const [name, z] of [
    ['vb_wheel_f', 0.75],
    ['vb_wheel_r', -0.75],
  ] as const) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.12, 16).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial());
    w.name = name;
    w.position.set(0, 0.33, z);
    scene.add(w);
  }
  return scene;
}

const centre = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());

function paintOf(v: CarVisual): THREE.MeshStandardMaterial {
  let m: THREE.MeshStandardMaterial | null = null;
  v.root.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mm?.name === MODEL_PAINT) m = mm;
  });
  return m!;
}

describe('prepareTemplate', () => {
  const tpl = prepareTemplate(fakeCar(), vehicleModel('sport'));
  const spec = vehicleSpec('car');

  it('fits the wheels onto the car axles, every tyre on the road', () => {
    tpl.fit.wheels.forEach((w, i) => expect(w.z).toBeCloseTo(spec.wheels[i].z, 9));
    for (const w of tpl.fit.wheels) expect(w.y - w.r).toBeCloseTo(-spec.rideHeight, 6);
  });

  it('caps metalness, finds lamps at both ends and the free wheel travel under the body', () => {
    tpl.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m) expect(m.metalness).toBeLessThanOrEqual(MODEL_METALNESS_MAX);
    });
    expect(tpl.lights.filter((l) => l.kind === 'head')).toHaveLength(2);
    expect(tpl.lights.filter((l) => l.kind === 'tail')).toHaveLength(2);
    for (const l of tpl.lights) expect(Math.sign(l.pos[2])).toBe(l.kind === 'head' ? 1 : -1);
    // The 6 cm gap at the fitted scale, less the 1 cm margin.
    expect(tpl.maxRise).toBeCloseTo(0.06 * tpl.fit.scale - 0.01, 3);
    expect(tpl.exhausts).toHaveLength(2);
    expect(tpl.top).toBeGreaterThan(0);
  });

  it('refuses a model without its wheel nodes', () => {
    const s = fakeCar();
    s.getObjectByName('vb_wheel_rr')!.name = 'tyre';
    expect(() => prepareTemplate(s, vehicleModel('sport'))).toThrow(/vb_wheel_rr/);
  });
});

describe('instantiate', () => {
  it('spins every wheel about its own centre and steers the front pair', () => {
    const tpl = prepareTemplate(fakeCar(), vehicleModel('coupe'));
    const v = instantiate(tpl, '#ff0000', false);
    expect(v.wheels).toHaveLength(4);
    expect(v.steered).toEqual([true, true, false, false]);
    expect(v.wheelR).toEqual(tpl.fit.wheels.map((w) => w.r));
    v.root.updateMatrixWorld(true);
    v.wheels.forEach((w, i) => {
      expect(w.parent).toBe(v.pivots[i]);
      const o = w.getWorldPosition(new THREE.Vector3());
      expect(centre(w).distanceTo(o)).toBeLessThan(1e-6);
      // Spinning keeps the wheel where it is (no wobble).
      w.rotation.x = 1.3;
      v.root.updateMatrixWorld(true);
      expect(centre(w).distanceTo(o)).toBeLessThan(1e-6);
      expect(v.pivots[i].position.y).toBeCloseTo(tpl.fit.wheels[i].y, 9);
    });
  });

  it('paints each instance on its own and frees only what it owns', () => {
    const tpl = prepareTemplate(fakeCar(), vehicleModel('coupe'));
    const a = instantiate(tpl, '#ff0000', false);
    const b = instantiate(tpl, '#00ff00', false);
    expect(tpl.refs).toBe(2);
    a.setColor('#0000ff');
    expect(paintOf(a).color.getHexString()).toBe('0000ff');
    expect(paintOf(b).color.getHexString()).toBe('00ff00');
    const geos: THREE.BufferGeometry[] = [];
    tpl.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) geos.push((o as THREE.Mesh).geometry);
    });
    const spies = geos.map((g) => vi.spyOn(g, 'dispose'));
    a.dispose();
    a.dispose();
    expect(tpl.refs).toBe(1);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(paintOf(b).color.getHexString()).toBe('00ff00');
  });

  it('draws a ghost with one translucent material and no lamps or flames', () => {
    const tpl = prepareTemplate(fakeCar(), vehicleModel('sedan'));
    const g = instantiate(tpl, '#7fd3ff', true);
    const mats = new Set<THREE.Material>();
    g.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) mats.add((o as THREE.Mesh).material as THREE.Material);
    });
    expect(mats.size).toBe(1);
    const m = [...mats][0];
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(g.lights).toEqual([]);
    expect(g.flames).toEqual([]);
  });

  it('gives the bike its rider and its lean, two wheels on the ray pairs, the fork not steering', () => {
    const tpl = prepareTemplate(fakeBike(), vehicleModel('cafe'));
    const v = instantiate(tpl, '#ff0000', false);
    expect(v.wheels).toHaveLength(2);
    expect(v.wheelSrc).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(v.steered).toEqual([false, false]);
    expect(v.lean).not.toBeNull();
    let meshes = 0;
    v.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    // The model's 3 meshes plus the rider's parts and the flame.
    expect(meshes).toBeGreaterThan(5);
    // The rider's helmet, not the frame (1 m tall), sets the top the badge floats over.
    expect(v.top).toBeGreaterThan(1.0 * tpl.fit.scale + tpl.fit.offset.y + 0.3);
  });
});

describe('lampsFrom', () => {
  it('gives no lamps without lamp meshes', () => {
    expect(lampsFrom([])).toEqual([]);
  });
});

describe('buildVehicle and CarView with a model', () => {
  const put = (id: ModelId, scene: THREE.Group): ModelTemplate => {
    const t = prepareTemplate(scene, vehicleModel(id));
    storeModel(id, t);
    return t;
  };

  it('draws the procedural vehicle until the model is loaded, and a model only for its own class', () => {
    expect(readyModel('lct3000')).toBeNull();
    expect(buildVehicle('truck', '#ffffff', false, 'racer', 'lct3000').model ?? null).toBeNull();
    put('sport', fakeCar());
    expect(buildVehicle('car', '#ffffff', false, 'racer', 'sport').model).toBe('sport');
    const bike = buildVehicle('bike', '#ffffff', false, 'racer', 'sport');
    expect(bike.vehicle).toBe('bike');
    expect(bike.model ?? null).toBeNull();
  });

  it('stands each drawn wheel on its ray by its own radius', () => {
    const tpl = put('sport', fakeCar());
    const track = new Track(campaign()[0].data);
    const view = new CarView(new THREE.Scene(), { color: '#e8452c', model: 'sport' });
    expect(view.visual.model).toBe('sport');
    const c = createCar(track);
    view.apply({ pos: c.pos, rot: c.rot }, c, 1);
    const S = vehicleSpec('car');
    view.visual.pivots.forEach((p, i) => {
      expect(p.position.y).toBeCloseTo(S.wheels[i].y - (S.ray - c.comp[i]) + tpl.fit.wheels[i].r, 9);
    });
    view.dispose();
    expect(tpl.refs).toBe(0);
  });

  it('rides the body up rather than sink its tyres past its free travel (a squat at speed), in apply and applyPose', () => {
    const tpl = put('sport', fakeCar());
    const track = new Track(campaign()[0].data);
    const view = new CarView(new THREE.Scene(), { color: '#e8452c', model: 'sport' });
    const S = vehicleSpec('car');
    const c = createCar(track);
    const settled = S.ray - S.wheels[0].y - S.rideHeight;
    const maxComp = settled + tpl.maxRise;
    const deep = maxComp + 0.08;
    /** World height of drawn wheel i's centre, and where the ray at compression `comp` puts it. */
    const wheelY = (i: number) => view.visual.wheels[i].getWorldPosition(new THREE.Vector3()).y;
    const onRay = (i: number, comp: number) => c.pos.y + S.wheels[i].y - (S.ray - comp) + tpl.fit.wheels[i].r;
    // All four squatted 8 cm past the free travel: the body rides 8 cm up, every tyre on the road.
    view.apply({ pos: c.pos, rot: c.rot }, { ...c, comp: [deep, deep, deep, deep] }, 1);
    view.visual.root.updateMatrixWorld(true);
    expect(view.visual.root.position.y).toBeCloseTo(c.pos.y + 0.08, 9);
    for (let i = 0; i < 4; i++) {
      expect(wheelY(i)).toBeCloseTo(onRay(i, deep), 9);
      // Clear of the arch: never above the free travel in the body's frame.
      expect(view.visual.pivots[i].position.y).toBeLessThanOrEqual(S.wheels[i].y - (S.ray - maxComp) + tpl.fit.wheels[i].r + 1e-9);
    }
    // Only the fronts squatted: up by the mean (4 cm); the rears stay on the road, the fronts sink the rest.
    view.apply({ pos: c.pos, rot: c.rot }, { ...c, comp: [deep, deep, settled, settled] }, 1);
    view.visual.root.updateMatrixWorld(true);
    expect(view.visual.root.position.y).toBeCloseTo(c.pos.y + 0.04, 9);
    expect(wheelY(2)).toBeCloseTo(onRay(2, settled), 9);
    expect(wheelY(0)).toBeCloseTo(onRay(0, deep) - 0.04, 9);
    // Within the free travel nothing moves.
    view.apply({ pos: c.pos, rot: c.rot }, c, 1);
    expect(view.visual.root.position.y).toBe(c.pos.y);
    // A pose (ghost, replay) on a road 8 cm higher than the settled stance: the same ride up.
    CAR_FX.ground = () => ({ y: c.pos.y + S.wheels[0].y - S.ray + deep, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null });
    view.applyPose(c.pos, c.rot, 0, 0);
    view.visual.root.updateMatrixWorld(true);
    expect(view.visual.root.position.y).toBeCloseTo(c.pos.y + 0.08, 9);
    for (let i = 0; i < 4; i++) expect(wheelY(i)).toBeCloseTo(onRay(i, deep), 9);
    CAR_FX.ground = null;
    view.dispose();
  });

  it('frees its lamp glow on dispose (the model instance never sees it), and a second dispose is harmless', () => {
    put('sport', fakeCar());
    const view = new CarView(new THREE.Scene(), { color: '#e8452c', model: 'sport' });
    const halo = view.visual.lamps.getObjectByName('halos') as THREE.Mesh;
    expect(halo).toBeDefined();
    const geo = vi.spyOn(halo.geometry, 'dispose');
    const mat = vi.spyOn(halo.material as THREE.Material, 'dispose');
    view.dispose();
    expect(halo.parent).toBeNull();
    expect(geo).toHaveBeenCalled();
    expect(mat).toHaveBeenCalled();
    expect(() => view.dispose()).not.toThrow();
  });
});
