// Procedural low-poly race cars (original design). Local frame: +z forward, +y up, +x left.
// Body styles are visual only: every body shares the wheels, pivots and flame count, so
// physics, ghosts and the suspension animation in CarView never depend on the choice.

import * as THREE from 'three';
import { DEFAULT_CAR_BODY, type CarBody } from '../core/cars';
import { WHEEL_ANCHORS, WHEEL_RADIUS } from '../physics/vehicle';

export type { CarBody } from '../core/cars';

export interface CarVisual {
  readonly body: CarBody;
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /** Front wheel steering pivots. */
  pivots: THREE.Object3D[];
  flames: THREE.Mesh[];
  setColor(hex: string): void;
  dispose(): void;
}

interface CarMats {
  paint: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  /** Rims, air filters and bumpers. */
  chrome: THREE.MeshStandardMaterial;
  // Lights and flames are never shown on a ghost, so they are not created for one
  // (dispose only reaches materials that sit on a mesh).
  head: THREE.Material | null;
  tail: THREE.Material | null;
  flame: THREE.Material | null;
}

type Vec3 = readonly [number, number, number];

/** Adds the body meshes (and lights when not a ghost) and returns the exhaust positions, right (-x) first. */
type BodyBuilder = (body: THREE.Group, m: CarMats, ghost: boolean) => ReadonlyArray<Vec3>;

function makeMats(color: string, ghost: boolean): CarMats {
  return {
    paint: new THREE.MeshStandardMaterial({
      color,
      roughness: 0.35,
      metalness: 0.45,
      transparent: ghost,
      opacity: ghost ? 0.42 : 1,
      depthWrite: !ghost,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x1b1e24,
      roughness: 0.6,
      metalness: 0.3,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x0d1b2a,
      roughness: 0.08,
      metalness: 0.9,
      transparent: true,
      opacity: ghost ? 0.3 : 0.88,
      depthWrite: !ghost,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: 0xf5f5f5,
      roughness: 0.4,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    tyre: new THREE.MeshStandardMaterial({
      color: 0x15171b,
      roughness: 0.9,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    chrome: new THREE.MeshStandardMaterial({
      color: 0xc9ced6,
      roughness: 0.3,
      metalness: 0.8,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    head: ghost ? null : new THREE.MeshStandardMaterial({ color: 0xfff6d5, emissive: 0xfff2c0, emissiveIntensity: 1.2 }),
    tail: ghost ? null : new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1010, emissiveIntensity: 1.4 }),
    flame: ghost
      ? null
      : new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.85, depthWrite: false }),
  };
}

function box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Round tube from a to b (build time only: it allocates). */
function strut(mat: THREE.Material, a: Vec3, b: Vec3, r = 0.045): THREE.Mesh {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
  m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  m.quaternion.setFromUnitVectors(Y_AXIS, d.divideScalar(len));
  return m;
}

const buildRacerBody: BodyBuilder = (body, m, ghost) => {
  const { paint, dark, glass, accent } = m;

  // Side profile extruded across the width: a wedge nose rising to the cockpit and tail.
  const profile = new THREE.Shape();
  profile.moveTo(2.35, -0.32); // nose bottom (x of shape = car z)
  profile.lineTo(2.45, -0.12);
  profile.quadraticCurveTo(1.6, 0.02, 0.6, 0.18);
  profile.lineTo(-1.5, 0.3);
  profile.lineTo(-2.15, 0.36);
  profile.lineTo(-2.2, -0.05);
  profile.lineTo(-2.05, -0.32);
  profile.closePath();
  const sideGeo = new THREE.ExtrudeGeometry(profile, {
    depth: 1.86,
    bevelEnabled: true,
    bevelSize: 0.08,
    bevelThickness: 0.08,
    bevelSegments: 2,
    curveSegments: 8,
  });
  // Shape lies in XY (x = forward); rotate so shape-x -> +z and extrude depth -> x.
  sideGeo.translate(0, 0, -0.93);
  sideGeo.rotateY(-Math.PI / 2);
  const hull = new THREE.Mesh(sideGeo, paint);
  hull.castShadow = !ghost;
  body.add(hull);

  // Sidepods.
  for (const s of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 2.2), dark);
    pod.position.set(s * 1.02, -0.12, -0.25);
    pod.castShadow = !ghost;
    body.add(pod);
  }

  // Cockpit canopy.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.62, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(0.95, 0.75, 1.9);
  canopy.position.set(0, 0.22, -0.1);
  body.add(canopy);

  // Stripe along the top.
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 3.2), accent);
  stripe.position.set(0, 0.2, 0.55);
  stripe.rotation.x = 0.07;
  body.add(stripe);

  // Rear wing.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 0.55), dark);
  wing.position.set(0, 0.78, -1.95);
  wing.rotation.x = -0.12;
  wing.castShadow = !ghost;
  body.add(wing);
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.3), dark);
    strut.position.set(s * 0.55, 0.52, -1.9);
    body.add(strut);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.4, 0.7), paint);
    plate.position.set(s * 1.06, 0.72, -1.95);
    body.add(plate);
  }

  // Front splitter.
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.5), dark);
  splitter.position.set(0, -0.36, 2.15);
  body.add(splitter);

  // Lights.
  if (m.head && m.tail) {
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.05), m.head);
      h.position.set(s * 0.62, -0.08, 2.42);
      body.add(h);
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.05), m.tail);
      t.position.set(s * 0.6, 0.12, -2.24);
      body.add(t);
    }
  }

  return [
    [-0.32, -0.12, -2.65],
    [0.32, -0.12, -2.65],
  ];
};

const buildBuggyBody: BodyBuilder = (body, m, ghost) => {
  const { paint, dark, glass, accent, chrome } = m;

  // Open tub with a sloped nose and an exposed engine at the back.
  const tub = box(paint, 1.66, 0.3, 3.4, 0, -0.22, 0.05);
  tub.castShadow = !ghost;
  body.add(tub);
  const nose = box(paint, 1.36, 0.18, 0.8, 0, -0.14, 2.05);
  nose.rotation.x = 0.18; // front edge down
  nose.castShadow = !ghost;
  body.add(nose);
  const engine = box(dark, 1.1, 0.46, 0.8, 0, 0.08, -1.72);
  engine.castShadow = !ghost;
  body.add(engine);
  for (const s of [-1, 1]) {
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.26, 10), chrome);
    filter.position.set(s * 0.3, 0.44, -1.72);
    body.add(filter);
  }

  // Driver: seat back, helmet and visor.
  const seat = box(dark, 0.8, 0.55, 0.14, 0, 0.17, -0.72);
  seat.rotation.x = -0.18;
  body.add(seat);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 10), accent);
  helmet.position.set(0, 0.46, -0.48);
  body.add(helmet);
  body.add(box(glass, 0.26, 0.08, 0.06, 0, 0.47, -0.29));

  // Roll cage. The top rail (0.86 + r) stays under the avatar badge's lowest point.
  for (const s of [-1, 1]) {
    body.add(strut(dark, [s * 0.62, -0.07, -0.95], [s * 0.56, 0.86, -0.95]));
  }
  body.add(strut(dark, [0.56, 0.86, -0.95], [-0.56, 0.86, -0.95]));
  for (const s of [-1, 1]) {
    body.add(strut(dark, [s * 0.66, -0.07, 0.85], [s * 0.56, 0.86, -0.1]));
    body.add(strut(dark, [s * 0.56, 0.86, -0.1], [s * 0.56, 0.86, -0.95]));
  }

  // Fenders over the exposed wheels.
  for (const s of [-1, 1]) {
    const front = box(paint, 0.48, 0.05, 0.86, s * 1.03, 0.04, 1.45);
    front.castShadow = !ghost;
    body.add(front);
    const rear = box(paint, 0.58, 0.05, 0.9, s * 1.03, 0.05, -1.35);
    rear.castShadow = !ghost;
    body.add(rear);
  }

  // Front bumper bar.
  body.add(strut(dark, [-0.78, -0.3, 2.45], [0.78, -0.3, 2.45], 0.06));

  if (m.head && m.tail) {
    for (const s of [-1, 1]) {
      body.add(box(m.head, 0.3, 0.1, 0.05, s * 0.45, -0.1, 2.43));
      body.add(box(m.tail, 0.24, 0.1, 0.05, s * 0.4, 0.12, -2.13));
    }
  }

  return [
    [-0.3, -0.02, -2.57],
    [0.3, -0.02, -2.57],
  ];
};

const buildMuscleBody: BodyBuilder = (body, m, ghost) => {
  const { paint, dark, glass, accent, chrome } = m;

  // Long slab body with a raised bonnet and a scoop.
  const lower = box(paint, 1.98, 0.4, 4.5, 0, -0.15, 0.08);
  lower.castShadow = !ghost;
  body.add(lower);
  const bonnet = box(paint, 1.84, 0.1, 1.7, 0, 0.09, 1.38);
  bonnet.rotation.x = 0.04;
  bonnet.castShadow = !ghost;
  body.add(bonnet);
  body.add(box(dark, 0.52, 0.12, 0.66, 0, 0.19, 1.15));

  // Fastback glass cabin, extruded across the width like the racer hull.
  const cab = new THREE.Shape();
  cab.moveTo(0.62, 0.05); // windscreen base (x of shape = car z)
  cab.lineTo(0.12, 0.6);
  cab.lineTo(-0.7, 0.6);
  cab.lineTo(-1.85, 0.1);
  cab.lineTo(-1.85, 0.05);
  cab.closePath();
  const cabGeo = new THREE.ExtrudeGeometry(cab, {
    depth: 1.54,
    bevelEnabled: true,
    bevelSize: 0.04,
    bevelThickness: 0.04,
    bevelSegments: 1,
  });
  cabGeo.translate(0, 0, -0.77);
  cabGeo.rotateY(-Math.PI / 2);
  const cabin = new THREE.Mesh(cabGeo, glass);
  cabin.castShadow = !ghost;
  body.add(cabin);
  const roof = box(paint, 1.46, 0.06, 0.86, 0, 0.64, -0.29);
  roof.castShadow = !ghost;
  body.add(roof);

  const duck = box(dark, 1.7, 0.07, 0.26, 0, 0.15, -2.04);
  duck.rotation.x = 0.25;
  body.add(duck);

  // Twin stripes over the bonnet and roof.
  for (const s of [-1, 1]) {
    const a = box(accent, 0.18, 0.012, 1.68, s * 0.15, 0.15, 1.38);
    a.rotation.x = 0.04;
    body.add(a);
    body.add(box(accent, 0.18, 0.012, 0.84, s * 0.15, 0.676, -0.29));
  }

  body.add(box(dark, 1.5, 0.18, 0.04, 0, -0.06, 2.345));
  body.add(box(chrome, 2.0, 0.1, 0.12, 0, -0.27, 2.36));
  body.add(box(chrome, 2.0, 0.1, 0.12, 0, -0.25, -2.2));

  // Wheel arch flares.
  for (const s of [-1, 1]) {
    body.add(box(paint, 0.2, 0.12, 0.96, s * 1.04, 0, 1.45));
    body.add(box(paint, 0.24, 0.13, 0.98, s * 1.06, 0.01, -1.35));
  }

  if (m.head && m.tail) {
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12), m.head);
      h.rotation.x = Math.PI / 2;
      h.position.set(s * 0.66, -0.05, 2.35);
      body.add(h);
      body.add(box(m.tail, 0.46, 0.1, 0.05, s * 0.58, -0.02, -2.19));
    }
  }

  return [
    [-0.55, -0.3, -2.62],
    [0.55, -0.3, -2.62],
  ];
};

const BODY_BUILDERS: Record<CarBody, BodyBuilder> = {
  racer: buildRacerBody,
  buggy: buildBuggyBody,
  muscle: buildMuscleBody,
};

export function buildCar(color = '#e8452c', ghost = false, body: CarBody = DEFAULT_CAR_BODY): CarVisual {
  const root = new THREE.Group();
  const shell = new THREE.Group();
  root.add(shell);
  const m = makeMats(color, ghost);

  // A stale or tampered body id falls back to the racer.
  const kind: CarBody = BODY_BUILDERS[body] ? body : DEFAULT_CAR_BODY;
  const exhausts = BODY_BUILDERS[kind](shell, m, ghost);

  // Exhaust flames (scaled by boost).
  const flames: THREE.Mesh[] = [];
  if (m.flame) {
    for (const e of exhausts) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.9, 10), m.flame);
      f.rotation.x = -Math.PI / 2;
      f.position.set(e[0], e[1], e[2]);
      f.visible = false;
      shell.add(f);
      flames.push(f);
    }
  }

  // Wheels.
  const wheels: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  WHEEL_ANCHORS.forEach((a, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(a.x * 1.08, 0, a.z);
    root.add(pivot);
    const wheel = new THREE.Group();
    const front = i < 2;
    const width = front ? 0.42 : 0.52;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, width, 20), m.tyre);
    t.rotation.z = Math.PI / 2;
    t.castShadow = !ghost;
    wheel.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS * 0.62, WHEEL_RADIUS * 0.62, width + 0.02, 6), m.chrome);
    r.rotation.z = Math.PI / 2;
    wheel.add(r);
    pivot.add(wheel);
    wheels.push(wheel);
    pivots.push(pivot);
  });

  return {
    body: kind,
    root,
    wheels,
    pivots,
    flames,
    setColor(hex: string) {
      m.paint.color.set(hex);
    },
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat: THREE.Material) => mat.dispose());
        }
      });
    },
  };
}
