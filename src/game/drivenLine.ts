// The line a recorded run actually drove, in the racing line's form (racingLine.ts RacingLineData), so the
// replay draws it with the same ribbon (render/racingLine.ts): where the car went, coloured by what the
// driver did there (green full throttle, yellow lift, orange to red braking, violet nitro). Built from the
// ghost's poses and its input log; a ghost without one (recorded before input logs) shows green all along.

import { GRAVITY } from '../core/constants';
import { vehicleSpec } from '../physics/vehicle';
import type { Ghost } from './ghost';
import { INPUT_STRIDE } from './inputLog';
import { Phase, type RacingLineData } from './racingLine';

const STRIDE = 8;
/** Samples closer than this (m) to the last kept one are skipped (a stop, a slow hairpin). */
const MIN_STEP = 0.8;
/** A sample further than this (m) from the last one is a respawn: the ribbon is not drawn across it. */
const JUMP = 30;

export function drivenLineData(g: Ghost): RacingLineData | null {
  const n = Math.floor(g.samples.length / STRIDE);
  if (n < 2) return null;
  const S = vehicleSpec(g.vehicle);
  // The car's centre over the road surface when settled (physics createCar).
  const lift = S.ray - GRAVITY / 4 / S.kSpring - S.wheels[0].y;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ss: number[] = [], ph: number[] = [], br: number[] = [], vis: number[] = [];
  let s = 0;
  let lx = 0, ly = 0, lz = 0;
  const inputs = g.inputs;
  for (let i = 0; i < n; i++) {
    const x = g.samples[i * STRIDE], y = g.samples[i * STRIDE + 1], z = g.samples[i * STRIDE + 2];
    const d = i ? Math.hypot(x - lx, y - ly, z - lz) : 0;
    if (i && d < MIN_STEP && i < n - 1) continue;
    s += d > JUMP ? 0 : d;
    // The inputs of the racing tick this sample was taken on.
    const k = Math.round(i * g.interval) * INPUT_STRIDE;
    let phase: number = Phase.Throttle;
    let brake = 0;
    if (inputs && k + 3 < inputs.length) {
      if (inputs[k + 3] === 1 || g.nitro?.some((t, j) => j % 2 === 0 && i * g.interval >= t && i * g.interval < (g.nitro![j + 1] ?? Infinity))) phase = Phase.Nitro;
      else if (inputs[k + 2] > 12) {
        phase = Phase.Brake;
        brake = Math.round((inputs[k + 2] / 255) * 15) / 15;
      } else if (inputs[k + 1] < 242) phase = Phase.Lift;
    }
    xs.push(x);
    ys.push(y - lift);
    zs.push(z);
    ss.push(s);
    ph.push(phase);
    br.push(brake);
    // A respawn: the sample before the jump hides the stretch across it.
    if (d > JUMP && vis.length) vis[vis.length - 1] = 0;
    vis.push(1);
    lx = x;
    ly = y;
    lz = z;
  }
  return {
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    s: Float32Array.from(ss),
    e: new Float32Array(xs.length),
    phase: Uint8Array.from(ph),
    brake: Float32Array.from(br),
    visible: Uint8Array.from(vis),
    time: g.time,
  };
}
