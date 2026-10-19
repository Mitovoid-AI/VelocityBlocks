// Procedural race cars (original designs). Local frame: +z forward, +y up, +x left.
// Body styles are visual only: every body shares the wheels, pivots and flame count, so
// physics, ghosts and the suspension animation in CarView never depend on the choice.

import * as THREE from 'three';
import { DEFAULT_CAR_BODY, isCarBody, type CarBody } from '../core/cars';
import { WHEEL_ANCHORS, WHEEL_RADIUS } from '../physics/vehicle';
import {
  extrudeX,
  fenderGeometry,
  loftGeometry,
  mergeByMaterial,
  profileGeometry,
  rbox,
  rimGeometry,
  strut,
  tubeGeometry,
  tyreGeometry,
  wingGeometry,
  type LoftSection,
  type Vec3,
} from './carParts';

export type { CarBody } from '../core/cars';

/** A lamp, for the glow cards CarView puts in front of it. */
export interface CarLight {
  readonly pos: Vec3;
  readonly kind: 'head' | 'tail';
  /** Glow width in metres. */
  readonly size: number;
}

export interface CarVisual {
  readonly body: CarBody;
  root: THREE.Group;
  wheels: THREE.Object3D[];
  /** Front wheel steering pivots. */
  pivots: THREE.Object3D[];
  flames: THREE.Mesh[];
  /** Head and tail lamps (none on a ghost). */
  readonly lights: readonly CarLight[];
  setColor(hex: string): void;
  dispose(): void;
}

interface CarMats {
  paint: THREE.MeshStandardMaterial;
  /** Carbon and trim: wings, floors, cages. */
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

interface BodySpec {
  /** Exhaust flame centres, right (-x) first. */
  exhausts: readonly Vec3[];
  lights: readonly CarLight[];
  /** Rim finish (chrome by default). */
  rims?: 'chrome' | 'dark';
  /** Coloured band on the tyre sidewalls (slicks). */
  tyreBand?: number;
}

/** Adds the body meshes (lights only when the lamp materials exist) and describes the rest. */
type BodyBuilder = (body: THREE.Group, m: CarMats) => BodySpec;

function makeMats(color: string, ghost: boolean): CarMats {
  return {
    paint: new THREE.MeshStandardMaterial({
      color,
      roughness: 0.32,
      metalness: 0.5,
      transparent: ghost,
      opacity: ghost ? 0.42 : 1,
      depthWrite: !ghost,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x1b1e24,
      roughness: 0.5,
      metalness: 0.3,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    // Tinted and mirror-like (it reflects the baked environment), but a driver still shows through.
    glass: new THREE.MeshStandardMaterial({
      color: 0x101820,
      roughness: 0.05,
      metalness: 0.6,
      transparent: true,
      opacity: ghost ? 0.3 : 0.82,
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
      color: 0x1a1c20,
      roughness: 0.85,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    // Some diffuse left, so rims don't go black before the environment is baked (or without one).
    chrome: new THREE.MeshStandardMaterial({
      color: 0xc9ced6,
      roughness: 0.2,
      metalness: 0.85,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    }),
    head: ghost ? null : new THREE.MeshStandardMaterial({ color: 0xfff6d5, emissive: 0xfff2c0, emissiveIntensity: 1.6 }),
    tail: ghost ? null : new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1010, emissiveIntensity: 1.6 }),
    flame: ghost
      ? null
      : new THREE.MeshBasicMaterial({
          color: 0x66ccff,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
  };
}

const FZ = WHEEL_ANCHORS[0].z;
const RZ = WHEEL_ANCHORS[2].z;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/** A left-side part (+x) and its mirror image on the right (the merge restores the mirror's winding). */
function pair(body: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material): void {
  const right = mesh(geo.clone(), mat);
  right.scale.x = -1;
  body.add(mesh(geo, mat), right);
}

/** Same stations as `secs`, raised a little and narrowed: a stripe that follows the surface. */
function stripe(secs: readonly LoftSection[], hw: number, x = 0): THREE.BufferGeometry {
  return loftGeometry(
    secs.map((s) => ({ z: s.z, hw, x, top: s.top + 0.01, bottom: s.top - 0.03, n: 6 })),
    12,
  );
}

/** Round lamp facing forward: lens in the lamp material with a bezel behind it. */
function roundLamp(body: THREE.Group, lens: THREE.Material, bezel: THREE.Material, x: number, y: number, z: number, r: number): void {
  const b = mesh(new THREE.CylinderGeometry(r * 1.2, r * 1.2, 0.06, 16), bezel, x, y, z - 0.02);
  b.rotation.x = Math.PI / 2;
  const l = mesh(new THREE.CylinderGeometry(r, r, 0.03, 16), lens, x, y, z + 0.005);
  l.rotation.x = Math.PI / 2;
  body.add(b, l);
}

/** Exhaust tip pointing back (-z): a pipe with a dark bore, ending at z - 0.07. */
function exhaustTip(body: THREE.Group, pipe: THREE.Material, bore: THREE.Material, x: number, y: number, z: number, r: number): void {
  const p = mesh(new THREE.CylinderGeometry(r, r, 0.14, 14), pipe, x, y, z);
  p.rotation.x = Math.PI / 2;
  const b = mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.7, 0.02, 12), bore, x, y, z - 0.062);
  b.rotation.x = Math.PI / 2;
  body.add(p, b);
}

/** Helmet with a tinted visor band facing +z. */
function driver(body: THREE.Group, m: CarMats, x: number, y: number, z: number, r: number): void {
  body.add(mesh(new THREE.SphereGeometry(r, 16, 12), m.accent, x, y, z));
  body.add(mesh(new THREE.SphereGeometry(r * 1.04, 14, 4, Math.PI / 2 - 0.85, 1.7, 1.2, 0.42), m.glass, x, y, z));
}

const buildRacerBody: BodyBuilder = (body, m) => {
  const { paint, dark, glass, accent, chrome } = m;

  // Central tub, narrow between the wheels: the fenders and sidepods give the width.
  const hull: LoftSection[] = [
    { z: 2.5, hw: 0.36, top: -0.17, bottom: -0.36, nb: 6 },
    { z: 2.25, hw: 0.56, top: -0.07, bottom: -0.38, nb: 6 },
    { z: 1.8, hw: 0.64, top: 0.02, bottom: -0.4, nb: 6 },
    { z: 1.1, hw: 0.66, top: 0.1, bottom: -0.4, nb: 6 },
    { z: 0.4, hw: 0.7, top: 0.2, bottom: -0.4, nb: 6 },
    { z: -0.6, hw: 0.72, top: 0.28, bottom: -0.4, nb: 6 },
    { z: -1.5, hw: 0.7, top: 0.32, bottom: -0.4, nb: 6 },
    { z: -2.05, hw: 0.7, top: 0.3, bottom: -0.34, nb: 6 },
    { z: -2.24, hw: 0.62, top: 0.24, bottom: -0.24, nb: 6 },
  ];
  body.add(mesh(loftGeometry(hull, 20), paint));
  body.add(mesh(stripe(hull.filter((s) => s.z >= 1.1), 0.16), accent));

  // Fenders over the wheels, with the arches cut out of them.
  const front = profileGeometry(
    {
      front: 2.47,
      rear: 0.8,
      foot: -0.4,
      arches: [FZ],
      archR: 0.44,
      top: (s) => {
        s.lineTo(2.47, -0.26);
        s.quadraticCurveTo(1.9, 0.1, FZ, 0.1);
        s.quadraticCurveTo(1.0, 0.1, 0.8, -0.04);
      },
    },
    0.62,
    1.3,
  );
  const rear = profileGeometry(
    {
      front: -0.62,
      rear: -2.22,
      foot: -0.4,
      arches: [RZ],
      archR: 0.44,
      top: (s) => {
        s.lineTo(-0.62, -0.02);
        s.quadraticCurveTo(-0.9, 0.16, RZ, 0.16);
        s.lineTo(-1.95, 0.19);
        s.quadraticCurveTo(-2.22, 0.2, -2.22, 0.08);
      },
    },
    0.62,
    1.32,
  );
  for (const g of [front, rear]) pair(body, g, paint);

  // Sidepods between the fenders, with a dark intake slot.
  for (const s of [-1, 1]) {
    body.add(rbox(paint, 0.62, 0.36, 1.7, s * 0.92, -0.22, 0.05, 0.12));
    body.add(rbox(dark, 0.03, 0.14, 0.6, s * 1.232, -0.2, 0.4, 0.012));
  }

  // Bubble canopy over a helmet, and a fin down the engine cover to the wing.
  body.add(
    mesh(
      loftGeometry(
        [
          { z: 1.15, hw: 0.3, top: 0.12, bottom: 0, n: 2.4 },
          { z: 0.75, hw: 0.5, top: 0.44, bottom: 0, n: 2.4 },
          { z: 0.2, hw: 0.56, top: 0.64, bottom: 0, n: 2.4 },
          { z: -0.45, hw: 0.54, top: 0.66, bottom: 0, n: 2.4 },
          { z: -1.0, hw: 0.42, top: 0.54, bottom: 0.08, n: 2.4 },
          { z: -1.4, hw: 0.2, top: 0.4, bottom: 0.25, n: 2.4 },
        ],
        20,
      ),
      glass,
    ),
  );
  driver(body, m, 0, 0.4, -0.15, 0.16);
  const fin = new THREE.Shape();
  fin.moveTo(-1.05, 0.3);
  fin.lineTo(-1.2, 0.5);
  fin.lineTo(-1.92, 0.68);
  fin.lineTo(-2.04, 0.64);
  fin.lineTo(-2.0, 0.3);
  body.add(mesh(extrudeX(fin, -0.02, 0.02, 0.01), paint));

  // Rear wing: main plane and flap between painted endplates, hung on two pylons.
  const wing = mesh(wingGeometry(2.12, 0.46, 0.06), dark, 0, 0.74, -2.02);
  wing.rotation.x = 0.15;
  const flap = mesh(wingGeometry(2.1, 0.17, 0.035), dark, 0, 0.83, -2.25);
  flap.rotation.x = 0.55;
  body.add(wing, flap);
  for (const s of [-1, 1]) {
    body.add(rbox(paint, 0.035, 0.36, 0.6, s * 1.08, 0.68, -2.04, 0.015));
    body.add(rbox(dark, 0.035, 0.42, 0.18, s * 0.32, 0.52, -1.98, 0.012));
  }

  // Splitter, diffuser and exhaust pipes.
  body.add(rbox(dark, 2.16, 0.035, 0.4, 0, -0.415, 2.3, 0.012));
  body.add(rbox(dark, 1.5, 0.14, 0.32, 0, -0.33, -2.12, 0.03));
  for (const x of [-0.45, -0.15, 0.15, 0.45]) body.add(rbox(dark, 0.02, 0.15, 0.34, x, -0.34, -2.14, 0.008));
  for (const s of [-1, 1]) exhaustTip(body, chrome, dark, s * 0.32, -0.15, -2.24, 0.06);

  // Slim lamps in the fender noses; a light bar across the tail.
  if (m.head && m.tail) {
    for (const s of [-1, 1]) body.add(rbox(m.head, 0.32, 0.06, 0.03, s * 0.96, -0.32, 2.505, 0.012));
    body.add(rbox(m.tail, 2.3, 0.045, 0.03, 0, 0.04, -2.265, 0.012));
  }

  return {
    exhausts: [
      [-0.32, -0.15, -2.72],
      [0.32, -0.15, -2.72],
    ],
    lights: [
      { pos: [-0.96, -0.32, 2.52], kind: 'head', size: 0.5 },
      { pos: [0.96, -0.32, 2.52], kind: 'head', size: 0.5 },
      { pos: [-0.9, 0.04, -2.28], kind: 'tail', size: 0.55 },
      { pos: [0.9, 0.04, -2.28], kind: 'tail', size: 0.55 },
    ],
  };
};

/** Long-travel look: the buggy's fenders ride well above the wheels. */
const BUGGY_ARCH_Y = -0.4;

const buildBuggyBody: BodyBuilder = (body, m) => {
  const { paint, dark, chrome } = m;

  // Open tub with a sloped nose, narrow enough to clear the wheels; a dark floor reads as the cockpit.
  body.add(
    mesh(
      loftGeometry(
        [
          { z: 2.45, hw: 0.42, top: -0.22, bottom: -0.34, nb: 5 },
          { z: 2.15, hw: 0.58, top: -0.08, bottom: -0.38, nb: 5 },
          { z: 1.6, hw: 0.66, top: 0, bottom: -0.4, nb: 5 },
          { z: 0.4, hw: 0.72, top: 0.04, bottom: -0.4, nb: 5 },
          { z: -1.2, hw: 0.72, top: 0.04, bottom: -0.4, nb: 5 },
          { z: -1.85, hw: 0.64, top: 0, bottom: -0.38, nb: 5 },
          { z: -2.08, hw: 0.52, top: -0.06, bottom: -0.3, nb: 5 },
        ],
        20,
      ),
      paint,
    ),
  );
  body.add(rbox(dark, 1.2, 0.03, 1.7, 0, 0.05, -0.25, 0.012));

  // Exposed engine: block, rocker covers, air filters and pipes curling down to the exhausts.
  body.add(rbox(dark, 1.1, 0.46, 0.8, 0, 0.08, -1.72, 0.07));
  for (const s of [-1, 1]) {
    body.add(rbox(chrome, 0.18, 0.07, 0.6, s * 0.3, 0.33, -1.72, 0.03));
    body.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.24, 16), chrome, s * 0.3, 0.46, -1.72));
    body.add(
      mesh(
        tubeGeometry(
          [
            [s * 0.5, 0.12, -1.4],
            [s * 0.52, 0.06, -1.85],
            [s * 0.3, -0.02, -2.14],
          ],
          0.045,
          16,
        ),
        chrome,
      ),
    );
  }

  // Driver: seat, helmet and visor.
  const seat = rbox(dark, 0.8, 0.55, 0.14, 0, 0.17, -0.72, 0.05);
  seat.rotation.x = -0.18;
  body.add(seat);
  driver(body, m, 0, 0.46, -0.48, 0.21);

  // Roll cage with round joints. The top rail (0.86 + joint) stays under the avatar badge's lowest point.
  const cage: [Vec3, Vec3][] = [
    [[0.56, 0.86, -0.95], [-0.56, 0.86, -0.95]],
    [[0.56, 0.86, -0.1], [-0.56, 0.86, -0.1]],
    // Diagonal brace across the main hoop.
    [[0.56, 0.86, -0.95], [-0.6, 0.02, -0.95]],
  ];
  for (const s of [-1, 1]) {
    cage.push(
      [[s * 0.62, -0.07, -0.95], [s * 0.56, 0.86, -0.95]],
      [[s * 0.66, -0.07, 0.85], [s * 0.56, 0.86, -0.1]],
      [[s * 0.56, 0.86, -0.1], [s * 0.56, 0.86, -0.95]],
      [[s * 0.56, 0.86, -0.95], [s * 0.5, 0.3, -2.0]],
    );
    for (const z of [-0.1, -0.95]) body.add(mesh(new THREE.SphereGeometry(0.055, 10, 8), dark, s * 0.56, 0.86, z));
  }
  for (const [a, b] of cage) body.add(strut(dark, a, b, 0.04));

  // Arched fenders over the wheels, each on a bracket.
  pair(body, fenderGeometry(FZ, 0.46, 0.52, -0.28, 0.76, 1.3, BUGGY_ARCH_Y), paint);
  pair(body, fenderGeometry(RZ, 0.46, 0.53, -0.28, 0.72, 1.33, BUGGY_ARCH_Y), paint);
  for (const s of [-1, 1]) for (const z of [FZ, RZ]) body.add(rbox(dark, 0.16, 0.04, 0.1, s * 0.74, 0.04, z, 0.015));

  // Nudge bar with a pair of spotlights.
  body.add(strut(dark, [-0.78, -0.3, 2.45], [0.78, -0.3, 2.45], 0.06));
  body.add(strut(dark, [-0.52, -0.06, 2.4], [0.52, -0.06, 2.4], 0.035));
  for (const s of [-1, 1]) body.add(strut(dark, [s * 0.52, -0.3, 2.45], [s * 0.52, -0.06, 2.4], 0.035));

  if (m.head && m.tail) {
    for (const s of [-1, 1]) {
      roundLamp(body, m.head, dark, s * 0.3, 0.02, 2.44, 0.07);
      body.add(rbox(m.tail, 0.16, 0.07, 0.025, s * 0.36, -0.18, -2.09, 0.01));
    }
  }

  return {
    exhausts: [
      [-0.3, -0.02, -2.59],
      [0.3, -0.02, -2.59],
    ],
    lights: [
      { pos: [-0.3, 0.02, 2.47], kind: 'head', size: 0.42 },
      { pos: [0.3, 0.02, 2.47], kind: 'head', size: 0.42 },
      { pos: [-0.36, -0.18, -2.11], kind: 'tail', size: 0.35 },
      { pos: [0.36, -0.18, -2.11], kind: 'tail', size: 0.35 },
    ],
  };
};

const buildMuscleBody: BodyBuilder = (body, m) => {
  const { paint, dark, glass, accent, chrome } = m;

  // Lower body: the side profile with both wheel arches cut out, rounded by its bevel. A dark core
  // closes the arch tunnels between the wheel wells.
  body.add(
    mesh(
      profileGeometry(
        {
          front: 2.3,
          rear: -2.12,
          foot: -0.38,
          arches: [FZ, RZ],
          archR: 0.48,
          top: (s) => {
            s.lineTo(2.34, -0.12);
            s.quadraticCurveTo(2.36, 0.06, 2.18, 0.08);
            s.lineTo(-1.98, 0.09);
            s.quadraticCurveTo(-2.16, 0.09, -2.16, -0.08);
          },
        },
        -0.99,
        0.99,
        0.06,
      ),
      paint,
    ),
  );
  body.add(rbox(dark, 1.42, 0.36, 4.2, 0, -0.22, 0.1, 0.05));

  // Long bonnet, fastback glasshouse and a roof panel just proud of the glass, which curves up to it.
  const bonnet: LoftSection[] = [
    { z: 2.24, hw: 0.88, top: 0.17, bottom: 0.05, n: 5, nb: 8 },
    { z: 1.6, hw: 0.9, top: 0.21, bottom: 0.05, n: 5, nb: 8 },
    { z: 0.64, hw: 0.9, top: 0.23, bottom: 0.05, n: 5, nb: 8 },
  ];
  body.add(mesh(loftGeometry(bonnet, 20), paint));
  body.add(
    mesh(
      loftGeometry(
        [
          { z: 0.66, hw: 0.82, top: 0.2, bottom: 0.1, n: 3.2 },
          { z: 0.18, hw: 0.74, top: 0.62, bottom: 0.1, n: 3.2 },
          { z: -0.62, hw: 0.72, top: 0.64, bottom: 0.1, n: 3.2 },
          { z: -1.2, hw: 0.75, top: 0.42, bottom: 0.1, n: 3.2 },
          { z: -1.86, hw: 0.8, top: 0.17, bottom: 0.1, n: 3.2 },
        ],
        20,
      ),
      glass,
    ),
  );
  const roof: LoftSection[] = [
    { z: 0.16, hw: 0.53, top: 0.635, bottom: 0.54, n: 3.2 },
    { z: -0.62, hw: 0.54, top: 0.656, bottom: 0.55, n: 3.2 },
    { z: -1.0, hw: 0.6, top: 0.512, bottom: 0.4, n: 3.2 },
  ];
  body.add(mesh(loftGeometry(roof, 16), paint));
  for (const s of [-1, 1]) body.add(strut(paint, [s * 0.79, 0.16, 0.62], [s * 0.56, 0.6, 0.17], 0.035));

  // Twin stripes over the bonnet and roof.
  for (const s of [-1, 1]) {
    body.add(mesh(stripe(bonnet, 0.09, s * 0.15), accent));
    body.add(mesh(stripe(roof, 0.09, s * 0.15), accent));
  }

  // Duck tail, mirrors, grille, bumpers and exhaust tips.
  const duck = rbox(paint, 1.76, 0.06, 0.3, 0, 0.18, -2.0, 0.03);
  duck.rotation.x = 0.3;
  body.add(duck);
  for (const s of [-1, 1]) {
    body.add(rbox(paint, 0.14, 0.08, 0.16, s * 0.9, 0.25, 0.5, 0.03));
    body.add(rbox(dark, 0.1, 0.07, 0.05, s * 0.82, 0.19, 0.52, 0.015));
    exhaustTip(body, chrome, dark, s * 0.55, -0.35, -2.2, 0.05);
  }
  body.add(rbox(dark, 0.84, 0.16, 0.06, 0, -0.1, 2.39, 0.02));
  body.add(rbox(chrome, 2.02, 0.09, 0.12, 0, -0.3, 2.42, 0.04));
  body.add(rbox(chrome, 2.02, 0.09, 0.12, 0, -0.27, -2.2, 0.04));

  // Quad round headlamps and wide tail lamps.
  if (m.head && m.tail) {
    for (const s of [-1, 1]) {
      for (const x of [0.56, 0.78]) roundLamp(body, m.head, chrome, s * x, -0.1, 2.42, 0.07);
      body.add(rbox(m.tail, 0.5, 0.09, 0.03, s * 0.58, -0.05, -2.225, 0.02));
    }
  }

  return {
    exhausts: [
      [-0.55, -0.35, -2.73],
      [0.55, -0.35, -2.73],
    ],
    lights: [
      { pos: [-0.67, -0.1, 2.45], kind: 'head', size: 0.55 },
      { pos: [0.67, -0.1, 2.45], kind: 'head', size: 0.55 },
      { pos: [-0.58, -0.05, -2.25], kind: 'tail', size: 0.55 },
      { pos: [0.58, -0.05, -2.25], kind: 'tail', size: 0.55 },
    ],
  };
};

const buildFormulaBody: BodyBuilder = (body, m) => {
  const { paint, dark, accent, chrome } = m;

  // Monocoque from the nose tip back through the cockpit to the gearbox, with a stripe on the nose.
  const tub: LoftSection[] = [
    { z: 2.42, hw: 0.08, top: -0.17, bottom: -0.27, n: 2.5 },
    { z: 2.0, hw: 0.14, top: -0.07, bottom: -0.3, n: 2.5 },
    { z: 1.4, hw: 0.22, top: 0.06, bottom: -0.33, n: 2.6 },
    { z: 0.9, hw: 0.32, top: 0.16, bottom: -0.38, n: 3 },
    { z: 0.4, hw: 0.4, top: 0.22, bottom: -0.4, n: 3 },
    { z: -0.25, hw: 0.42, top: 0.24, bottom: -0.4, n: 3 },
    { z: -0.9, hw: 0.36, top: 0.2, bottom: -0.4, n: 3 },
    { z: -1.6, hw: 0.2, top: 0.04, bottom: -0.36, n: 3 },
    { z: -2.0, hw: 0.12, top: -0.06, bottom: -0.3, n: 3 },
  ];
  body.add(mesh(loftGeometry(tub, 20), paint));
  body.add(mesh(stripe(tub.filter((s) => s.z >= 0.9), 0.05), accent));

  // Sidepods with intakes, tapering to the gearbox between the rear wheels.
  body.add(
    mesh(
      loftGeometry(
        [
          { z: 0.62, hw: 0.62, top: 0.02, bottom: -0.38, n: 3.5, nb: 8 },
          { z: 0.35, hw: 0.68, top: 0.08, bottom: -0.4, n: 3.5, nb: 8 },
          { z: -0.4, hw: 0.64, top: 0.06, bottom: -0.4, n: 3.5, nb: 8 },
          { z: -1.0, hw: 0.48, top: -0.04, bottom: -0.4, n: 3.5, nb: 8 },
          { z: -1.5, hw: 0.3, top: -0.12, bottom: -0.38, n: 3.5, nb: 8 },
        ],
        20,
      ),
      paint,
    ),
  );
  for (const s of [-1, 1]) body.add(rbox(dark, 0.22, 0.2, 0.02, s * 0.47, -0.12, 0.628, 0.04));

  // Engine cover, airbox over the driver's head and a shark fin.
  body.add(
    mesh(
      loftGeometry(
        [
          { z: -0.05, hw: 0.24, top: 0.4, bottom: 0, n: 2.6 },
          { z: -0.5, hw: 0.24, top: 0.52, bottom: 0, n: 2.6 },
          { z: -1.1, hw: 0.2, top: 0.42, bottom: -0.05, n: 2.6 },
          { z: -1.7, hw: 0.12, top: 0.22, bottom: -0.1, n: 2.6 },
          { z: -2.05, hw: 0.07, top: 0.06, bottom: -0.1, n: 2.6 },
        ],
        16,
      ),
      paint,
    ),
  );
  body.add(
    mesh(
      loftGeometry(
        [
          { z: -0.18, hw: 0.13, top: 0.74, bottom: 0.36, n: 2.4 },
          { z: -0.32, hw: 0.15, top: 0.76, bottom: 0.38, n: 2.4 },
          { z: -0.7, hw: 0.12, top: 0.6, bottom: 0.3, n: 2.4 },
        ],
        16,
      ),
      paint,
    ),
  );
  body.add(rbox(dark, 0.17, 0.25, 0.02, 0, 0.56, -0.172, 0.06));
  const fin = new THREE.Shape();
  fin.moveTo(-0.6, 0.5);
  fin.lineTo(-0.72, 0.68);
  fin.lineTo(-1.9, 0.6);
  fin.lineTo(-2.02, 0.32);
  fin.lineTo(-1.4, 0.3);
  body.add(mesh(extrudeX(fin, -0.012, 0.012, 0.006), paint));

  // Driver under the halo; mirrors on stalks.
  driver(body, m, 0, 0.33, 0.05, 0.15);
  body.add(
    mesh(
      tubeGeometry(
        [
          [0.27, 0.2, -0.3],
          [0.29, 0.42, -0.15],
          [0.27, 0.49, 0.1],
          [0.16, 0.515, 0.36],
          [0, 0.52, 0.47],
          [-0.16, 0.515, 0.36],
          [-0.27, 0.49, 0.1],
          [-0.29, 0.42, -0.15],
          [-0.27, 0.2, -0.3],
        ],
        0.028,
        48,
      ),
      dark,
    ),
  );
  body.add(
    mesh(
      tubeGeometry(
        [
          [0, 0.52, 0.45],
          [0, 0.42, 0.58],
          [0, 0.17, 0.68],
        ],
        0.03,
        12,
      ),
      dark,
    ),
  );
  for (const s of [-1, 1]) {
    body.add(rbox(paint, 0.14, 0.06, 0.04, s * 0.5, 0.3, 0.45, 0.02));
    body.add(strut(dark, [s * 0.36, 0.18, 0.42], [s * 0.46, 0.3, 0.45], 0.012));
  }

  // Front wing under the nose: main plane, a flap each side, endplates and two pylons.
  const fw = mesh(wingGeometry(2.36, 0.4, 0.04), dark, 0, -0.4, 2.26);
  fw.rotation.x = 0.06;
  body.add(fw);
  for (const s of [-1, 1]) {
    const flap = mesh(wingGeometry(0.8, 0.2, 0.03), dark, s * 0.68, -0.33, 2.12);
    flap.rotation.x = 0.35;
    body.add(flap);
    body.add(rbox(paint, 0.025, 0.16, 0.46, s * 1.19, -0.36, 2.25, 0.01));
    body.add(rbox(dark, 0.02, 0.14, 0.2, s * 0.06, -0.33, 2.25, 0.008));
  }

  // Rear wing: main plane and DRS flap between endplates, on a central pylon.
  const rw = mesh(wingGeometry(1.3, 0.36, 0.05), dark, 0, 0.66, -2.08);
  rw.rotation.x = 0.12;
  const drs = mesh(wingGeometry(1.3, 0.16, 0.03), dark, 0, 0.79, -2.24);
  drs.rotation.x = 0.45;
  body.add(rw, drs);
  for (const s of [-1, 1]) body.add(rbox(paint, 0.03, 0.5, 0.56, s * 0.665, 0.58, -2.1, 0.012));
  body.add(rbox(dark, 0.04, 0.6, 0.2, 0, 0.36, -2.08, 0.015));

  // Floor, diffuser, gearbox and the exhaust between them.
  body.add(rbox(dark, 1.4, 0.03, 2.5, 0, -0.425, -0.35, 0.01));
  body.add(rbox(dark, 1.0, 0.2, 0.4, 0, -0.3, -2.0, 0.03));
  body.add(rbox(dark, 0.2, 0.18, 0.4, 0, -0.08, -2.1, 0.04));
  exhaustTip(body, chrome, dark, 0, 0.08, -2.1, 0.06);

  // Wishbones out to the wheels (static: they meet the wheels at rest).
  const arms: [Vec3, Vec3][] = [];
  for (const s of [-1, 1]) {
    for (const [z, x, inZ] of [
      [FZ, 0.8, [1.7, 1.2]],
      [RZ, 0.75, [-1.15, -1.62]],
    ] as const) {
      for (const zi of inZ) {
        arms.push([[s * 0.22, -0.04, zi], [s * x, -0.28, z]]);
        arms.push([[s * 0.24, -0.32, zi], [s * x, -0.42, z]]);
      }
    }
  }
  for (const [a, b] of arms) body.add(strut(dark, a, b, 0.015, 6));

  // No headlamps on a formula car: a rain light and LED strips on the wing endplates.
  if (m.tail) {
    body.add(rbox(m.tail, 0.12, 0.08, 0.02, 0, -0.08, -2.305, 0.015));
    for (const s of [-1, 1]) body.add(rbox(m.tail, 0.03, 0.14, 0.012, s * 0.665, 0.6, -2.386, 0.005));
  }

  return {
    exhausts: [
      [-0.05, 0.08, -2.62],
      [0.05, 0.08, -2.62],
    ],
    lights: [
      { pos: [0, -0.08, -2.32], kind: 'tail', size: 0.4 },
      { pos: [-0.665, 0.6, -2.4], kind: 'tail', size: 0.3 },
      { pos: [0.665, 0.6, -2.4], kind: 'tail', size: 0.3 },
    ],
    rims: 'dark',
    tyreBand: 0xffd21f,
  };
};

const BODY_BUILDERS: Record<CarBody, BodyBuilder> = {
  racer: buildRacerBody,
  buggy: buildBuggyBody,
  muscle: buildMuscleBody,
  formula: buildFormulaBody,
};

/** Front and rear tyre widths. */
const TYRE_W = [0.42, 0.52];

type Slot = Exclude<keyof CarMats, 'flame'>;

/** A body built and merged once: one geometry per material slot, cloned for every car. */
interface ShellTemplate {
  parts: { slot: Slot; geo: THREE.BufferGeometry }[];
  spec: BodySpec;
}

const shells = new Map<string, ShellTemplate>();
const wheelGeos = new Map<string, THREE.BufferGeometry>();

/** The merged shell of a body (ghosts have no lamps, so they get their own), built on first use. */
function shellTemplate(kind: CarBody, ghost: boolean): ShellTemplate {
  const key = `${kind}:${ghost}`;
  let t = shells.get(key);
  if (t) return t;
  const m = makeMats('#ffffff', ghost);
  const g = new THREE.Group();
  const spec = BODY_BUILDERS[kind](g, m);
  mergeByMaterial(g);
  const slots = Object.entries(m) as [keyof CarMats, THREE.Material | null][];
  const parts = g.children.map((o) => {
    const part = o as THREE.Mesh;
    return { slot: slots.find(([, mat]) => mat === part.material)![0] as Slot, geo: part.geometry };
  });
  for (const mat of Object.values(m)) mat?.dispose();
  shells.set(key, (t = { parts, spec }));
  return t;
}

function wheelGeometry(kind: 'tyre' | 'rim', w: number, band?: number): THREE.BufferGeometry {
  const key = `${kind}:${w}:${band ?? ''}`;
  let g = wheelGeos.get(key);
  if (!g) wheelGeos.set(key, (g = kind === 'tyre' ? tyreGeometry(w, WHEEL_RADIUS, band) : rimGeometry(w)));
  return g;
}

export function buildCar(color = '#e8452c', ghost = false, body: CarBody = DEFAULT_CAR_BODY): CarVisual {
  const root = new THREE.Group();
  const shell = new THREE.Group();
  root.add(shell);
  const m = makeMats(color, ghost);

  // A stale or tampered body id falls back to the racer.
  const kind: CarBody = isCarBody(body) ? body : DEFAULT_CAR_BODY;
  // One draw call per material; everything but the lamps casts a shadow. Each car owns copies of
  // the template geometry, so disposing one car never touches another.
  const { parts, spec } = shellTemplate(kind, ghost);
  for (const { slot, geo } of parts) {
    const part = new THREE.Mesh(geo.clone(), m[slot]!);
    part.castShadow = !ghost && slot !== 'head' && slot !== 'tail';
    shell.add(part);
  }

  // Exhaust flames (scaled by boost).
  const flames: THREE.Mesh[] = [];
  if (m.flame) {
    for (const e of spec.exhausts) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.9, 10), m.flame);
      f.rotation.x = -Math.PI / 2;
      f.position.set(e[0], e[1], e[2]);
      f.visible = false;
      shell.add(f);
      flames.push(f);
    }
  }

  // Wheels: built with the outboard face at +x and mirrored on the right. A banded tyre carries its
  // colours in the geometry, so its material is white.
  if (spec.tyreBand !== undefined) {
    m.tyre.vertexColors = true;
    m.tyre.color.set(0xffffff);
  }
  const rimMat = spec.rims === 'dark' ? m.dark : m.chrome;
  const wheels: THREE.Object3D[] = [];
  const pivots: THREE.Object3D[] = [];
  WHEEL_ANCHORS.forEach((a, i) => {
    const pivot = new THREE.Group();
    pivot.position.set(a.x * 1.08, 0, a.z);
    root.add(pivot);
    const wheel = new THREE.Group();
    const w = TYRE_W[i < 2 ? 0 : 1];
    const t = new THREE.Mesh(wheelGeometry('tyre', w, spec.tyreBand).clone(), m.tyre);
    t.castShadow = !ghost;
    wheel.add(t, new THREE.Mesh(wheelGeometry('rim', w).clone(), rimMat));
    if (a.x < 0) wheel.scale.x = -1;
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
    lights: ghost ? [] : spec.lights,
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
