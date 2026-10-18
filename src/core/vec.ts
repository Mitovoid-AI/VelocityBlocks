// Minimal allocation-light vector/quaternion maths for the simulation.
// The simulation does not depend on three.js so it can run headless in tests.

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const vcopy = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o: V3, x: number, y: number, z: number): V3 => {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};
export const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vaddScaled = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vnorm = (a: V3): V3 => {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
export const vlerp = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const qident = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const qcopy = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

export function qnormalize(q: Quat): Quat {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qfromAxisAngle(axis: V3, angle: number): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

/** Rotate vector v by unit quaternion q. */
export function qrotate(q: Quat, v: V3): V3 {
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Rotate by the inverse (conjugate) of unit quaternion q. */
export function qrotateInv(q: Quat, v: V3): V3 {
  return qrotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

/** Integrate angular velocity w (world space, rad/s) over dt. */
export function qintegrate(q: Quat, w: V3, dt: number): Quat {
  const dq = qmul({ x: w.x, y: w.y, z: w.z, w: 0 }, q);
  return qnormalize({
    x: q.x + 0.5 * dt * dq.x,
    y: q.y + 0.5 * dt * dq.y,
    z: q.z + 0.5 * dt * dq.z,
    w: q.w + 0.5 * dt * dq.w,
  });
}

/** Yaw-only rotation so that local +z faces the given horizontal direction. */
export function qfromYawDir(dx: number, dz: number): Quat {
  const yaw = Math.atan2(dx, dz);
  return qfromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    return qnormalize({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => t * t * (3 - 2 * t);
