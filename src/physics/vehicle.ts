// Fixed-step vehicle simulation: a rigid body on four ray-cast suspension points,
// grip-limited tyre forces, drift state, boost pads and impulse-based contacts.
// Pure TypeScript with no rendering dependencies so it runs identically in tests.

import { DT, GRAVITY, MAX_SPEED } from '../core/constants';
import {
  clamp,
  lerp,
  qcopy,
  qfromYawDir,
  qintegrate,
  qrotate,
  qrotateInv,
  v3,
  vcopy,
  vcross,
  vdot,
  vlen,
  type Quat,
  type V3,
} from '../core/vec';
import type { Track } from '../track/track';

export interface Controls {
  /** -1 (left) .. 1 (right) */
  steer: number;
  /** 0..1 */
  gas: number;
  /** 0..1 */
  brake: number;
}

export const NO_CONTROLS: Controls = { steer: 0, gas: 0, brake: 0 };

export interface CarState {
  pos: V3;
  vel: V3;
  rot: Quat;
  angVel: V3;
  steer: number;
  boostTime: number;
  boostPower: number;
  drift: number;
  comp: number[];
  contact: boolean[];
  wheelSpin: number;
  grounded: number;
  slip: number;
  onGrass: boolean;
  /** Cumulative distance the wheels rolled (for skid/smoke emitters). */
  odometer: number;
  /** Seconds since any wheel last touched a surface. */
  airTime: number;
}

// ---- Tuning -----------------------------------------------------------------

const WHEELS: V3[] = [
  { x: 0.95, y: -0.15, z: 1.45 }, // front left (local +x is the driver's left)
  { x: -0.95, y: -0.15, z: 1.45 }, // front right
  { x: 0.95, y: -0.15, z: -1.35 }, // rear left
  { x: -0.95, y: -0.15, z: -1.35 }, // rear right
];
export const WHEEL_ANCHORS = WHEELS;
export const WHEEL_RADIUS = 0.36;
const REST = 0.45;
const RAY = REST + WHEEL_RADIUS;
const K_SPRING = 32;
const C_DAMP = 3.4;
const K_BUMP = 260;
const K_ANTIROLL = 26;
/** Fraction of the real (vertical) lever arm used for tyre forces. */
const TYRE_LEVER = 0.18;
/** Offset of the chassis hard stop below each wheel anchor. */
const HARD = RAY - REST - 0.08;

/** Body corner points used for hull contacts. */
const HULL: V3[] = [];
for (const x of [1.0, -1.0]) for (const y of [-0.3, 0.55]) for (const z of [2.25, -2.15]) HULL.push({ x, y, z });

/** Inverse inertia around local x (pitch), y (yaw), z (roll) for unit mass. */
const INV_I = { x: 1 / 2.4, y: 1 / 2.6, z: 1 / 1.6 };

const MU_ROAD = 2.1;
const ADHESION = 34;
const DOWNFORCE = 0.0016;
const DRAG = 0.00021;
const BRAKE = 24;
const REVERSE_MAX = 16;
/**
 * Grass drag as a body force: rolling (m/s^2) plus quadratic (1/m) deceleration with a cap, scaled by
 * the wheels on grass. Tops out near 99 km/h, about the bot's tight-curve speed, so cutting does not pay.
 * The cap only binds above about 166 km/h: a car that runs onto the grass at road speed loses it within
 * a second or so (250 -> 164 km/h with gas held), so short corner cuts cost time too.
 */
const GRASS_ROLL = 3;
const GRASS_DRAG = 0.0127;
const GRASS_MAX_DECEL = 30;
/** Car footprint (half-width, front and rear reach) for gate-post and pillar contacts; matches HULL. */
const FOOT_W = 1.0;
const FOOT_F = 2.25;
const FOOT_R = 2.15;

/** Engine acceleration (m/s^2) by forward speed (m/s). */
const ENGINE: [number, number][] = [
  [0, 16],
  [20, 14.5],
  [40, 10.5],
  [60, 6.4],
  [75, 3.4],
  [90, 1.7],
  [110, 0.6],
  [150, 0],
];

export const BOOST = { boost: { time: 1.0, power: 16 }, turbo: { time: 1.6, power: 26 } } as const;

function engineAccel(v: number): number {
  if (v <= 0) return ENGINE[0][1];
  for (let n = 1; n < ENGINE.length; n++) {
    const [v1, a1] = ENGINE[n];
    if (v < v1) {
      const [v0, a0] = ENGINE[n - 1];
      return lerp(a0, a1, (v - v0) / (v1 - v0));
    }
  }
  return 0;
}

function maxSteerAngle(speed: number): number {
  return 0.52 / (1 + Math.abs(speed) / 22);
}

// ---- State helpers ------------------------------------------------------------

export function createCar(track: Track): CarState {
  const sp = track.spawn();
  // Settled ride height: CoM sits so each spring carries a quarter of the weight.
  const settle = (GRAVITY / 4) / K_SPRING;
  const y = sp.y + RAY - settle + 0.15;
  return {
    pos: v3(sp.x, y, sp.z),
    vel: v3(),
    rot: qfromYawDir(sp.hx, sp.hz),
    angVel: v3(),
    steer: 0,
    boostTime: 0,
    boostPower: 0,
    drift: 0,
    comp: [settle, settle, settle, settle],
    contact: [true, true, true, true],
    wheelSpin: 0,
    grounded: 4,
    slip: 0,
    onGrass: false,
    odometer: 0,
    airTime: 0,
  };
}

export function cloneCar(c: CarState): CarState {
  return {
    ...c,
    pos: vcopy(c.pos),
    vel: vcopy(c.vel),
    rot: qcopy(c.rot),
    angVel: vcopy(c.angVel),
    comp: c.comp.slice(),
    contact: c.contact.slice(),
  };
}

export function speedOf(c: CarState): number {
  return vlen(c.vel);
}

export function forwardOf(c: CarState): V3 {
  return qrotate(c.rot, { x: 0, y: 0, z: 1 });
}

export function upOf(c: CarState): V3 {
  return qrotate(c.rot, { x: 0, y: 1, z: 0 });
}

export function triggerBoost(c: CarState, kind: keyof typeof BOOST): void {
  const b = BOOST[kind];
  c.boostTime = b.time;
  c.boostPower = b.power;
}

// ---- Simulation step ------------------------------------------------------------

/** Apply world-space inverse inertia to a world-space torque/impulse. */
function invInertia(rot: Quat, t: V3): V3 {
  const l = qrotateInv(rot, t);
  return qrotate(rot, { x: l.x * INV_I.x, y: l.y * INV_I.y, z: l.z * INV_I.z });
}

function applyImpulse(c: CarState, r: V3, j: V3): void {
  c.vel.x += j.x;
  c.vel.y += j.y;
  c.vel.z += j.z;
  const dw = invInertia(c.rot, vcross(r, j));
  c.angVel.x += dw.x;
  c.angVel.y += dw.y;
  c.angVel.z += dw.z;
}

function pointVel(c: CarState, r: V3): V3 {
  const w = vcross(c.angVel, r);
  return { x: c.vel.x + w.x, y: c.vel.y + w.y, z: c.vel.z + w.z };
}

/** Resolve a contact at offset r (from CoM) with normal n; returns the applied normal impulse. */
function resolveContact(c: CarState, r: V3, n: V3, restitution: number, friction: number): number {
  const vp = pointVel(c, r);
  const vn = vdot(vp, n);
  if (vn >= 0) return 0;
  const rn = vcross(r, n);
  const k = 1 + vdot(n, vcross(invInertia(c.rot, rn), r));
  const jn = (-(1 + restitution) * vn) / k;
  applyImpulse(c, r, { x: n.x * jn, y: n.y * jn, z: n.z * jn });
  // Coulomb friction on the tangential part.
  const vp2 = pointVel(c, r);
  const vn2 = vdot(vp2, n);
  const vt = { x: vp2.x - n.x * vn2, y: vp2.y - n.y * vn2, z: vp2.z - n.z * vn2 };
  const vtl = vlen(vt);
  if (vtl > 1e-6 && friction > 0) {
    const t = { x: vt.x / vtl, y: vt.y / vtl, z: vt.z / vtl };
    const rt = vcross(r, t);
    const kt = 1 + vdot(t, vcross(invInertia(c.rot, rt), r));
    const jt = Math.min(vtl / kt, friction * jn);
    applyImpulse(c, r, { x: -t.x * jt, y: -t.y * jt, z: -t.z * jt });
  }
  return jn;
}

export interface StepEvents {
  /** Strongest hull/wall impact speed this step (for sound/camera shake). */
  impact: number;
}

export function stepCar(c: CarState, ctl: Controls, track: Track): StepEvents {
  const dt = DT;
  const events: StepEvents = { impact: 0 };

  // Steering input smoothing (keyboard friendly, also smooths touch).
  const target = clamp(ctl.steer, -1, 1);
  const rate = Math.abs(target) < Math.abs(c.steer) || Math.sign(target) !== Math.sign(c.steer) ? 9 : 5;
  c.steer += clamp(target - c.steer, -rate * dt, rate * dt);

  const fwd = qrotate(c.rot, { x: 0, y: 0, z: 1 });
  const up = qrotate(c.rot, { x: 0, y: 1, z: 0 });
  const right = vcross(fwd, up);
  const speedF = vdot(c.vel, fwd);
  const speed = vlen(c.vel);

  const force: V3 = { x: 0, y: -GRAVITY, z: 0 };
  const torque: V3 = { x: 0, y: 0, z: 0 };

  // Drift: brake while steering hard at speed breaks rear traction.
  const wantsDrift = ctl.brake > 0.5 && Math.abs(c.steer) > 0.35 && speedF > 18 && c.grounded >= 2;
  if (wantsDrift) c.drift = Math.min(1, c.drift + dt * 6);
  else if (Math.abs(c.steer) < 0.2 || speedF < 12) c.drift = Math.max(0, c.drift - dt * 2.5);
  else c.drift = Math.max(0, c.drift - dt * 0.35);

  const delta = c.steer * maxSteerAngle(speedF);
  const cosD = Math.cos(delta);
  const sinD = Math.sin(delta);

  let grounded = 0;
  let grassWheels = 0;
  let slipSum = 0;
  const downforce = DOWNFORCE * speed * speed;
  const engine = engineAccel(speedF);

  for (let w = 0; w < 4; w++) {
    const r0 = qrotate(c.rot, WHEELS[w]);
    const ax = c.pos.x + r0.x, ay = c.pos.y + r0.y, az = c.pos.z + r0.z;
    let comp = 0;
    let hit = null;
    if (up.y > 0.15) {
      hit = track.surfaceAt(ax, ay, az, 1.0);
      const n = { x: hit.nx, y: hit.ny, z: hit.nz };
      const den = vdot(up, n);
      if (den > 0.2) {
        // Distance along -up from the anchor to the surface plane.
        // The surface plane passes through (ax, hit.y, az).
        const dist = ((ay - hit.y) * n.y) / den;
        comp = RAY - dist;
      }
    }
    if (!hit || comp <= 0) {
      c.comp[w] = Math.max(0, c.comp[w] - dt * 3);
      c.contact[w] = false;
      continue;
    }
    comp = Math.min(comp, RAY);
    const compVel = (comp - c.comp[w]) / dt;
    c.comp[w] = comp;
    c.contact[w] = true;
    grounded++;
    if (!hit.road) grassWheels++;

    let fs = K_SPRING * comp + C_DAMP * compVel;
    if (comp > REST) fs += K_BUMP * (comp - REST);
    // Anti-roll bar: resist compression differences across the axle.
    const other = w ^ 1;
    fs += K_ANTIROLL * (comp - c.comp[other]);
    fs = Math.max(0, fs);
    const n = { x: hit.nx, y: hit.ny, z: hit.nz };
    const dist = RAY - comp;
    const r = { x: r0.x - up.x * dist, y: r0.y - up.y * dist, z: r0.z - up.z * dist };

    // Suspension force along the car's up axis.
    let fx = up.x * fs, fy = up.y * fs, fz = up.z * fs;

    // Tyre frame on the contact plane.
    const front = w < 2;
    let wf = front
      ? { x: fwd.x * cosD + right.x * sinD, y: fwd.y * cosD + right.y * sinD, z: fwd.z * cosD + right.z * sinD }
      : fwd;
    const wfn = vdot(wf, n);
    wf = { x: wf.x - n.x * wfn, y: wf.y - n.y * wfn, z: wf.z - n.z * wfn };
    const wfl = vlen(wf) || 1;
    wf = { x: wf.x / wfl, y: wf.y / wfl, z: wf.z / wfl };
    const ws = vcross(wf, n);

    const vp = pointVel(c, r);
    const vLong = vdot(vp, wf);
    const vLat = vdot(vp, ws);

    const load = fs + downforce * 0.25;
    const gripMul = hit.grip * (front ? 1 : 1 - 0.62 * c.drift);
    const maxF = MU_ROAD * gripMul * load;

    // Lateral: remove a fraction of the sideways velocity each step, limited by grip.
    let fLat = -vLat * (0.25 / dt) * 0.55;

    // Longitudinal.
    let fLong = 0;
    if (ctl.brake > 0 && speedF > 0.8) {
      fLong -= BRAKE * 0.25 * ctl.brake * Math.sign(vLong || 1);
    } else if (ctl.brake > 0 && speedF > -REVERSE_MAX) {
      fLong -= 9 * 0.25 * ctl.brake;
    }
    if (ctl.gas > 0 && !(ctl.brake > 0 && speedF <= 0.8)) {
      fLong += engine * 0.25 * ctl.gas;
    }
    if (ctl.gas === 0 && ctl.brake === 0) {
      // Rolling resistance; holds the car still at very low speed.
      fLong += Math.abs(vLong) < 0.6 ? -vLong * (0.25 / dt) * 0.3 : -Math.sign(vLong) * 0.25 * 0.5;
    }

    const tot = Math.sqrt(fLat * fLat + fLong * fLong);
    if (tot > maxF) {
      const s = maxF / tot;
      slipSum += Math.min(1, (tot - maxF) / (maxF + 1));
      fLat *= s;
      fLong *= s;
    }
    if (c.drift > 0.2 && !front) slipSum += c.drift * 0.5;

    const tx = wf.x * fLong + ws.x * fLat;
    const ty = wf.y * fLong + ws.y * fLat;
    const tz = wf.z * fLong + ws.z * fLat;
    force.x += fx + tx;
    force.y += fy + ty;
    force.z += fz + tz;
    // Suspension acts at the contact point; tyre forces act close to CoM height,
    // which keeps load transfer (and roll-overs) arcade-friendly.
    const ts = vcross(r, { x: fx, y: fy, z: fz });
    const ru = vdot(r, up) * TYRE_LEVER;
    const rt = { x: r.x - up.x * vdot(r, up) + up.x * ru, y: r.y - up.y * vdot(r, up) + up.y * ru, z: r.z - up.z * vdot(r, up) + up.z * ru };
    const tt = vcross(rt, { x: tx, y: ty, z: tz });
    torque.x += ts.x + tt.x;
    torque.y += ts.y + tt.y;
    torque.z += ts.z + tt.z;
  }

  c.grounded = grounded;
  c.onGrass = grassWheels >= 2;
  c.slip = grounded ? clamp(slipSum / 2, 0, 1) : 0;

  c.airTime = grounded > 0 ? 0 : c.airTime + dt;

  // Road adhesion: over crests the car hugs the deck as long as road continues below it.
  // Jump lips end the road, so ramps still launch the car.
  if (grounded < 4 && c.airTime < 0.25 && up.y > 0.5) {
    const under = track.surfaceAt(c.pos.x, c.pos.y, c.pos.z, 0.5);
    const gap = c.pos.y - under.y;
    if (under.road && gap < 2.2) {
      const a = ADHESION * (1 - c.airTime / 0.25);
      force.x -= under.nx * a;
      force.y -= under.ny * a;
      force.z -= under.nz * a;
    }
  }

  if (grounded > 0) {
    // Downforce pushes the car into the track.
    const df = downforce * (grounded / 4);
    force.x -= up.x * df;
    force.y -= up.y * df;
    force.z -= up.z * df;
    // Drift yaw assist: keeps a committed slide rotating with the steering.
    if (c.drift > 0) {
      const yaw = c.steer * c.drift * 3.2;
      torque.x -= up.x * yaw;
      torque.y -= up.y * yaw;
      torque.z -= up.z * yaw;
    }
  } else {
    // Airborne: gentle roll levelling and nose alignment with the flight path.
    const worldUp = { x: 0, y: 1, z: 0 };
    const rollErr = vdot(vcross(up, worldUp), fwd);
    const rollT = rollErr * 3.0;
    torque.x += fwd.x * rollT;
    torque.y += fwd.y * rollT;
    torque.z += fwd.z * rollT;
    if (speed > 5) {
      const vd = { x: c.vel.x / speed, y: c.vel.y / speed, z: c.vel.z / speed };
      const pitchErr = vdot(vcross(fwd, vd), right);
      const pT = pitchErr * 1.2;
      torque.x += right.x * pT;
      torque.y += right.y * pT;
      torque.z += right.z * pT;
    }
  }

  // Grass drag: a body force, so it slows the car without using up steering grip.
  if (grassWheels > 0) {
    const vh = Math.hypot(c.vel.x, c.vel.z);
    if (vh > 0.05) {
      const decel = Math.min(GRASS_MAX_DECEL, GRASS_ROLL + GRASS_DRAG * vh * vh) * (grassWheels / 4);
      // Never more than stops the car this tick, so it cannot push it backwards.
      const k = Math.min(decel, vh / dt) / vh;
      force.x -= c.vel.x * k;
      force.z -= c.vel.z * k;
    }
  }

  // Boost pads.
  if (c.boostTime > 0) {
    const frac = c.boostTime / (c.boostPower > 20 ? BOOST.turbo.time : BOOST.boost.time);
    const a = c.boostPower * (0.35 + 0.65 * frac);
    force.x += fwd.x * a;
    force.y += fwd.y * a;
    force.z += fwd.z * a;
    c.boostTime = Math.max(0, c.boostTime - dt);
  }

  // Aerodynamic drag.
  force.x -= c.vel.x * speed * DRAG;
  force.y -= c.vel.y * speed * DRAG;
  force.z -= c.vel.z * speed * DRAG;

  // Integrate velocities.
  c.vel.x += force.x * dt;
  c.vel.y += force.y * dt;
  c.vel.z += force.z * dt;
  const dw = invInertia(c.rot, torque);
  c.angVel.x += dw.x * dt;
  c.angVel.y += dw.y * dt;
  c.angVel.z += dw.z * dt;
  const angDamp = grounded > 0 ? 1 - 2.2 * dt : 1 - 0.6 * dt;
  c.angVel.x *= angDamp;
  c.angVel.y *= angDamp;
  c.angVel.z *= angDamp;

  // Hull contacts with the ground/road surface.
  let maxPen = 0;
  for (const h of HULL) {
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const s = track.surfaceAt(px, py, pz, 1.6);
    const pen = s.y - py;
    if (pen > 0) {
      const n = { x: s.nx, y: s.ny, z: s.nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.05, 0.45);
      events.impact = Math.max(events.impact, -before);
      maxPen = Math.max(maxPen, pen);
    }
  }
  // Wheel hard points stop the chassis sinking through the deck on big landings.
  for (let w = 0; w < 4; w++) {
    const r0 = qrotate(c.rot, WHEELS[w]);
    const r = { x: r0.x - up.x * HARD, y: r0.y - up.y * HARD, z: r0.z - up.z * HARD };
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const s = track.surfaceAt(px, py, pz, 1.6);
    const pen = s.y - py;
    if (pen > 0) {
      const n = { x: s.nx, y: s.ny, z: s.nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.0, 0.0);
      events.impact = Math.max(events.impact, -before);
      maxPen = Math.max(maxPen, pen);
    }
  }

  // Barrier contacts.
  let pushX = 0, pushZ = 0;
  for (const h of HULL) {
    if (h.y > 0) continue;
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y + 0.3, pz = c.pos.z + r.z;
    const wh = track.wallAt(px, py, pz);
    if (!wh) continue;
    const n = { x: wh.nx, y: 0, z: wh.nz };
    const before = vdot(pointVel(c, r), n);
    resolveContact(c, r, n, 0.12, 0.12);
    events.impact = Math.max(events.impact, -before);
    if (Math.abs(pushX) < Math.abs(wh.nx * wh.depth)) pushX = wh.nx * wh.depth;
    if (Math.abs(pushZ) < Math.abs(wh.nz * wh.depth)) pushZ = wh.nz * wh.depth;
  }

  // Embankment faces: slopes and ramps rising from the floor are solid from the side and the high end.
  for (const h of HULL) {
    if (h.y > 0) continue;
    const r = qrotate(c.rot, h);
    const px = c.pos.x + r.x, py = c.pos.y + r.y, pz = c.pos.z + r.z;
    const wh = track.sideAt(px, py, pz);
    if (!wh) continue;
    const n = { x: wh.nx, y: 0, z: wh.nz };
    const before = vdot(pointVel(c, r), n);
    resolveContact(c, r, n, 0.1, 0.2);
    events.impact = Math.max(events.impact, -before);
    if (Math.abs(pushX) < Math.abs(wh.nx * wh.depth)) pushX = wh.nx * wh.depth;
    if (Math.abs(pushZ) < Math.abs(wh.nz * wh.depth)) pushZ = wh.nz * wh.depth;
  }

  // Gate posts and pillars: vertical cylinders against the car's footprint rectangle.
  const cols = track.columnsNear(c.pos.x, c.pos.z);
  const fh = Math.hypot(fwd.x, fwd.z);
  if (cols && fh > 0.3) {
    const fx = fwd.x / fh, fz = fwd.z / fh;
    const rx = -fz, rz = fx;
    for (const col of cols) {
      if (c.pos.y + 0.8 < col.y0 || c.pos.y - 0.6 > col.y1) continue;
      const dx = col.x - c.pos.x, dz = col.z - c.pos.z;
      const lf = dx * fx + dz * fz, lr = dx * rx + dz * rz;
      // Closest point of the footprint to the column centre.
      const cf = clamp(lf, -FOOT_R, FOOT_F), cr = clamp(lr, -FOOT_W, FOOT_W);
      const ef = lf - cf, er = lr - cr;
      const d = Math.hypot(ef, er);
      let nx: number, nz: number, depth: number;
      if (d > 1e-6) {
        if (d >= col.r) continue;
        nx = -(ef * fx + er * rx) / d;
        nz = -(ef * fz + er * rz) / d;
        depth = col.r - d;
      } else {
        // Centre inside the footprint: push out along the shallower axis.
        const pf = lf >= 0 ? FOOT_F - lf : lf + FOOT_R;
        const pr = FOOT_W - Math.abs(lr);
        if (pr < pf) {
          const sg = lr >= 0 ? -1 : 1;
          nx = rx * sg;
          nz = rz * sg;
          depth = pr + col.r;
        } else {
          const sg = lf >= 0 ? -1 : 1;
          nx = fx * sg;
          nz = fz * sg;
          depth = pf + col.r;
        }
      }
      const r = { x: cf * fx + cr * rx, y: 0, z: cf * fz + cr * rz };
      const n = { x: nx, y: 0, z: nz };
      const before = vdot(pointVel(c, r), n);
      resolveContact(c, r, n, 0.15, 0.2);
      events.impact = Math.max(events.impact, -before);
      if (Math.abs(pushX) < Math.abs(nx * depth)) pushX = nx * depth;
      if (Math.abs(pushZ) < Math.abs(nz * depth)) pushZ = nz * depth;
    }
  }

  // Speed cap.
  const sp = vlen(c.vel);
  if (sp > MAX_SPEED) {
    const k = MAX_SPEED / sp;
    c.vel.x *= k;
    c.vel.y *= k;
    c.vel.z *= k;
  }

  // Integrate positions.
  c.pos.x += c.vel.x * dt + pushX;
  c.pos.y += c.vel.y * dt + maxPen * 0.8;
  c.pos.z += c.vel.z * dt + pushZ;
  c.rot = qintegrate(c.rot, c.angVel, dt);

  const fwdSpeed = vdot(c.vel, fwd);
  c.wheelSpin += (fwdSpeed * dt) / WHEEL_RADIUS;
  c.odometer += Math.abs(fwdSpeed) * dt;
  return events;
}
