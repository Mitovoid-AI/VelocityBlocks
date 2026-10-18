// Test helper: length of the shortest path between two poses for a car that can turn no tighter
// than radius rho (Dubins path: the best of LSL, RSR, LSR, RSL, RLR and LRL).
// Headings are angles with direction (cos th, sin th) in the same plane as (x, z).

const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;

export function dubinsLength(x0: number, z0: number, th0: number, x1: number, z1: number, th1: number, rho: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const d = Math.hypot(dx, dz) / rho;
  const theta = mod2pi(Math.atan2(dz, dx));
  const a = mod2pi(th0 - theta), b = mod2pi(th1 - theta);
  const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b), cab = Math.cos(a - b);
  const words: number[] = [];

  // LSL
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, d + sa - sb);
      words.push(mod2pi(tmp - a) + Math.sqrt(p2) + mod2pi(b - tmp));
    }
  }
  // RSR
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, d - sa + sb);
      words.push(mod2pi(a - tmp) + Math.sqrt(p2) + mod2pi(tmp - b));
    }
  }
  // LSR
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      words.push(mod2pi(tmp - a) + p + mod2pi(tmp - b));
    }
  }
  // RSL
  {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      words.push(mod2pi(a - tmp) + p + mod2pi(b - tmp));
    }
  }
  // RLR
  {
    const c = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(c) <= 1) {
      const p = mod2pi(TAU - Math.acos(c));
      const t = mod2pi(a - Math.atan2(ca - cb, d - sa + sb) + p / 2);
      words.push(t + p + mod2pi(a - b - t + p));
    }
  }
  // LRL
  {
    const c = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
    if (Math.abs(c) <= 1) {
      const p = mod2pi(TAU - Math.acos(c));
      const t = mod2pi(-a - Math.atan2(ca - cb, d + sa - sb) + p / 2);
      words.push(t + p + mod2pi(b - a - t + p));
    }
  }
  return Math.min(...words) * rho;
}
