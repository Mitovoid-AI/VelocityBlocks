// Handling bench: prints the feel numbers (launch, top speed, brakes, cornering limit, power oversteer,
// brake-tap drift, grass) and the autopilot campaign laps. Run it from the project root:
//   npx esbuild scripts/handling-bench.ts --bundle --platform=node --format=esm --outfile=<tmp>/bench.mjs && node <tmp>/bench.mjs [section]
// Sections: all (default), accel, brake, skid, corner, power, drift, grass, bot, touch.
// It reads the v6 car fields and assists loosely, so a copy also runs in an older checkout for comparison.
import { createCar, forwardOf, speedOf, stepCar, type CarState, type Controls } from '../src/physics/vehicle';
import { Autopilot } from '../src/game/bot';
import { RaceSession } from '../src/game/race';
import { campaign } from '../src/track/campaign';
import { nearestPoint } from '../src/track/route';
import { Track } from '../src/track/track';

type TcLevel = 'normal' | 'low';
/** Assists as stepCar takes them; older physics ignores the extra argument. */
type Assists = { tc: TcLevel };
const NORMAL: Assists = { tc: 'normal' };
const LOW: Assists = { tc: 'low' };
const NONE: Controls = { steer: 0, gas: 0, brake: 0 };
// Older physics has no tc/spin/abs/aero fields: read them loosely.
const num = (c: CarState, k: string) => ((c as unknown as Record<string, number>)[k] ?? 0);

/** An endless flat asphalt plane (no walls, no columns): a skidpad and drag strip. */
const flat = {
  surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 1, road: true, block: null }),
  wallAt: () => null,
  sideAt: () => null,
  columnsNear: () => null,
  spawn: () => ({ x: 0, y: 0, z: 0, hx: 0, hz: 1 }),
} as unknown as Track;
/** The same plane as grass. */
const grass = { ...flat, surfaceAt: () => ({ y: 0, nx: 0, ny: 1, nz: 0, grip: 0.55, road: false, block: null }) } as unknown as Track;

const step = (c: CarState, ctl: Controls, t: Track = flat, a: Assists = NORMAL) =>
  (stepCar as (c: CarState, ctl: Controls, t: Track, a: Assists) => unknown)(c, ctl, t, a);
const kmh = (c: CarState) => speedOf(c) * 3.6;

/** Car rolling straight along +z at v m/s, settled on its springs (downforce squats it at speed). */
function rolling(v: number, t: Track = flat, a: Assists = NORMAL): CarState {
  const c = createCar(t);
  for (let n = 0; n < 200; n++) {
    step(c, NONE, t, a);
    c.vel = { x: 0, y: 0, z: v };
  }
  return c;
}

/** Body slip angle in degrees (heading vs direction of travel). */
function beta(c: CarState): number {
  const f = forwardOf(c);
  return Math.abs((Math.atan2(f.x * c.vel.z - f.z * c.vel.x, f.x * c.vel.x + f.z * c.vel.z) * 180) / Math.PI);
}
const heading = (c: CarState) => (Math.atan2(c.vel.x, c.vel.z) * 180) / Math.PI;

/** Steady state with speed held at v ("treadmill"), averaged over the last second. */
function skidpad(v: number, steer: number, gas = 0, a: Assists = NORMAL) {
  const c = rolling(v, flat, a);
  let prev = Math.atan2(c.vel.x, c.vel.z);
  let lat = 0, slip = 0, b = 0, tc = 0, spin = 0;
  for (let n = 0; n < 400; n++) {
    step(c, { steer, gas, brake: 0 }, flat, a);
    const s = Math.hypot(c.vel.x, c.vel.z);
    c.vel.x *= v / s;
    c.vel.z *= v / s;
    const h = Math.atan2(c.vel.x, c.vel.z);
    let dh = h - prev;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    prev = h;
    if (n >= 300) {
      lat += (Math.abs(dh) / 0.01) * v;
      slip += c.slip;
      b += beta(c);
      tc += num(c, 'tc');
      spin += num(c, 'spin');
    }
  }
  return { a: lat / 100, slip: slip / 100, beta: b / 100, tc: tc / 100, spin: spin / 100 };
}

/** Best steady lateral acceleration at v over a sweep of steering inputs. */
function latLimit(v: number) {
  let best = { a: 0, steer: 0, slip: 0, beta: 0 };
  for (let s = 0.1; s <= 1.001; s += 0.05) {
    const r = skidpad(v, s);
    if (r.a > best.a) best = { a: r.a, steer: s, slip: r.slip, beta: r.beta };
  }
  return best;
}

const mode = process.argv[2] ?? 'all';
const on = (s: string) => mode === 'all' || mode === s;

if (on('accel')) {
  for (const a of [NORMAL, LOW]) {
    const c = rolling(0, flat, a);
    const at: Record<number, number> = {};
    let v10 = 0, v20 = 0, tcSum = 0, tcN = 0;
    for (let n = 1; n <= 6000; n++) {
      step(c, { steer: 0, gas: 1, brake: 0 }, flat, a);
      for (const m of [100, 200, 300]) if (!at[m] && kmh(c) >= m) at[m] = n / 100;
      if (n <= 300) {
        tcSum += num(c, 'tc');
        tcN++;
      }
      if (n === 1000) v10 = kmh(c);
      if (n === 2000) v20 = kmh(c);
    }
    console.log(
      `ACCEL tc=${a.tc}: 0-100 ${at[100]}s 0-200 ${at[200]}s 0-300 ${at[300] ?? '-'}s | v@10s ${v10.toFixed(0)} v@20s ${v20.toFixed(0)} v@60s ${kmh(c).toFixed(1)} km/h | tc lamp in first 3 s ${(tcSum / tcN).toFixed(3)}`,
    );
  }
  for (const v of [100, 200, 300]) {
    const c = rolling(v / 3.6);
    const v0 = speedOf(c);
    for (let n = 0; n < 50; n++) step(c, NONE);
    console.log(`LIFT-OFF at ${v} km/h: ${((v0 - speedOf(c)) / 0.5).toFixed(2)} m/s^2`);
  }
  for (const g of [0.25, 0.5, 1]) {
    const c = rolling(40);
    const v0 = speedOf(c);
    for (let n = 0; n < 50; n++) step(c, { steer: 0, gas: g, brake: 0 });
    console.log(`THROTTLE ${g} at 144 km/h: ${((speedOf(c) - v0) / 0.5).toFixed(2)} m/s^2`);
  }
}

if (on('brake')) {
  const out: string[] = [];
  for (const v0 of [100, 200, 300]) {
    const c = rolling(v0 / 3.6);
    const z0 = c.pos.z;
    let n = 0, abs = 0, slip = 0;
    while (speedOf(c) > 0.3 && n < 3000) {
      step(c, { steer: 0, gas: 0, brake: 1 });
      abs += num(c, 'abs');
      slip += c.slip;
      n++;
    }
    out.push(`${v0}->0 ${(c.pos.z - z0).toFixed(1)} m ${(n / 100).toFixed(2)} s (abs ${(abs / n).toFixed(2)} slip ${(slip / n).toFixed(3)})`);
  }
  console.log('BRAKE ' + out.join(' | '));
  const dec: string[] = [];
  for (const v of [5, 15, 25, 40, 55, 70, 83, 90]) {
    for (const b of [1, 0.55]) {
      const c = rolling(v);
      const v0 = speedOf(c);
      for (let n = 0; n < 5; n++) step(c, { steer: 0, gas: 0, brake: b });
      dec.push(`${v}${b < 1 ? '@.55' : ''}:${((v0 - speedOf(c)) / 0.05).toFixed(1)}`);
    }
  }
  console.log('BRAKE DECEL m/s by m/s^2 ' + dec.join(' '));
}

if (on('skid')) {
  for (const v of [10, 15, 20, 25, 35, 50, 60, 70, 80, 90]) {
    const row: string[] = [];
    for (const s of [0.25, 0.5, 1]) {
      const r = skidpad(v, s);
      row.push(`s${s}: a=${r.a.toFixed(1)} b=${r.beta.toFixed(1)} sl=${r.slip.toFixed(2)}`);
    }
    const best = latLimit(v);
    console.log(
      `SKID ${String(Math.round(v * 3.6)).padStart(3)} km/h best a=${best.a.toFixed(1)} (steer ${best.steer.toFixed(2)}) | ` + row.join(' | '),
    );
  }
}

if (on('corner')) {
  // Steady corner speed on a circle of radius R: the fastest v whose lateral limit holds it.
  const out: string[] = [];
  for (const R of [16, 25, 48, 68, 100]) {
    let lo = 5, hi = 95;
    for (let k = 0; k < 14; k++) {
      const v = (lo + hi) / 2;
      if (latLimit(v).a >= (v * v) / R) lo = v;
      else hi = v;
    }
    out.push(`R${R} ${(lo * 3.6).toFixed(0)}`);
  }
  console.log('CORNER km/h ' + out.join(' | '));
}

if (on('power')) {
  for (const a of [NORMAL, LOW]) {
    for (const gas of [1, 0.5]) {
      const c = rolling(15, flat, a);
      for (let n = 0; n < 60; n++) {
        step(c, { steer: 1, gas: 0.15, brake: 0 }, flat, a);
        const s = Math.hypot(c.vel.x, c.vel.z);
        c.vel.x *= 15 / s;
        c.vel.z *= 15 / s;
      }
      let b = 0, tc = 0, spin = 0;
      for (let n = 0; n < 120; n++) {
        step(c, { steer: 1, gas, brake: 0 }, flat, a);
        b = Math.max(b, beta(c));
        tc += num(c, 'tc');
        spin += num(c, 'spin');
      }
      console.log(
        `POWER tc=${a.tc} gas=${gas} out of a 54 km/h full-lock corner: max body slip ${b.toFixed(1)} deg, tc ${(tc / 120).toFixed(2)}, spin ${(spin / 120).toFixed(2)}, v ${kmh(c).toFixed(0)} km/h`,
      );
    }
  }
}

if (on('drift')) {
  // Brake-tap drift: steer in at speed, tap the brake for 200 ms, slide on the gas with the steering
  // held for half a second, then straighten up for 0.7 s.
  for (const a of [NORMAL, LOW]) {
    for (const v0 of [80, 110, 150, 200, 250]) {
      for (const steer of [0.6, 1]) {
        const c = rolling(v0 / 3.6, flat, a);
        for (let n = 0; n < 20; n++) step(c, { steer, gas: 1, brake: 0 }, flat, a);
        const vIn = kmh(c);
        let turned = 0, h = heading(c);
        const track = () => {
          let d = heading(c) - h;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          turned += d;
          h = heading(c);
        };
        for (let n = 0; n < 20; n++) {
          step(c, { steer, gas: 0, brake: 1 }, flat, a);
          track();
        }
        const vTap = kmh(c);
        let mb = 0, tc = 0, dr = 0;
        for (let n = 0; n < 50; n++) {
          step(c, { steer, gas: 1, brake: 0 }, flat, a);
          track();
          mb = Math.max(mb, beta(c));
          tc += num(c, 'tc');
          dr = Math.max(dr, c.drift);
        }
        const vSlide = kmh(c);
        for (let n = 0; n < 70; n++) step(c, { steer: 0, gas: 1, brake: 0 }, flat, a);
        console.log(
          `DRIFT tc=${a.tc} ${v0} km/h steer ${steer}: tap -${(vIn - vTap).toFixed(1)} km/h, after slide ${vSlide.toFixed(0)} km/h, turned ${Math.abs(turned).toFixed(1)} deg, max beta ${mb.toFixed(1)}, max drift ${dr.toFixed(2)}, tc lamp ${(tc / 50).toFixed(2)} | recovered: beta ${beta(c).toFixed(1)} v ${kmh(c).toFixed(0)}`,
        );
      }
    }
  }
}

if (on('grass')) {
  const c = rolling(0, grass);
  let t60 = 0;
  for (let n = 1; n <= 3000; n++) {
    step(c, { steer: 0, gas: 1, brake: 0 }, grass);
    if (!t60 && kmh(c) >= 60) t60 = n / 100;
  }
  console.log(`GRASS 0-60 ${t60}s top ${kmh(c).toFixed(0)} km/h`);
}

type Driver = (race: RaceSession, bot: Autopilot) => Controls;
const botDriver: Driver = (race, bot) => bot.controls(race);
/** A phone player on buttons: on/off steering with a small dead zone, on/off throttle and brake. */
const touchDriver: Driver = (race, bot) => {
  const c = bot.controls(race);
  return { steer: Math.abs(c.steer) > 0.3 ? Math.sign(c.steer) : 0, gas: c.gas > 0.5 ? 1 : 0, brake: c.brake > 0 ? 1 : 0 };
};

/** runBot with a driver, assists and lap statistics. */
function lap(track: Track, drive: Driver, a: Assists) {
  const race = new (RaceSession as unknown as new (t: Track, a: Assists) => RaceSession)(track, a);
  const bot = new Autopilot(track);
  let stuck = 0, autos = 0, impacts = 0, ticks = 0, smoke = 0, lamp = 0, abs = 0, aero = 0, braking = 0;
  let last = { x: race.car.pos.x, z: race.car.pos.z };
  for (let n = 0; n < 30000 && race.phase !== 'finished'; n++) {
    const ctl = race.phase === 'racing' ? drive(race, bot) : NONE;
    for (const e of race.step(ctl)) {
      if (e.type === 'respawn' && e.auto) autos++;
      if (e.type === 'impact' && e.speed > 6) impacts++;
    }
    if (race.phase !== 'racing') continue;
    const c = race.car;
    ticks++;
    if (!c.onGrass && c.grounded >= 2 && (c.slip > 0.25 || c.drift > 0.3) && speedOf(c) > 8) smoke++;
    if (num(c, 'tc') > 0.05) lamp++;
    if (ctl.brake > 0) {
      braking++;
      abs += num(c, 'abs');
    }
    aero = Math.max(aero, num(c, 'aero'));
    if (n % 100 === 0) {
      const moved = Math.hypot(c.pos.x - last.x, c.pos.z - last.z);
      last = { x: c.pos.x, z: c.pos.z };
      stuck = moved < 2 ? stuck + 1 : 0;
      const near = bot.route.points[nearestPoint(bot.route, c.pos.x, c.pos.y, c.pos.z)];
      if (stuck >= 2 || c.pos.y < -10 || (c.onGrass && near && near.y - c.pos.y > 3)) {
        race.respawn();
        stuck = 0;
      }
    }
  }
  return {
    time: race.phase === 'finished' ? race.finishTime! : null,
    respawns: race.respawns,
    autos,
    impacts,
    smoke: smoke / Math.max(1, ticks),
    lamp: lamp / Math.max(1, ticks),
    abs: abs / Math.max(1, braking),
    aero,
  };
}

function campaignRun(label: string, drive: Driver, a: Assists) {
  let total = 0, dnf = 0, resp = 0, imp = 0, smoke = 0, lamp = 0, aero = 0;
  for (const ct of campaign()) {
    const r = lap(new Track(ct.data), drive, a);
    if (r.time === null) dnf++;
    total += r.time ?? 0;
    resp += r.respawns + r.autos;
    imp += r.impacts;
    smoke += r.smoke / 12;
    lamp += r.lamp / 12;
    aero = Math.max(aero, r.aero);
    console.log(
      `${label} tc=${a.tc} ${ct.id} ${ct.data.name.padEnd(14)} ${r.time !== null ? (r.time / 1000).toFixed(2) : 'DNF'} resp=${r.respawns} auto=${r.autos} impacts=${r.impacts} smoke=${(r.smoke * 100).toFixed(1)}% lamp=${(r.lamp * 100).toFixed(1)}% abs=${r.abs.toFixed(2)} aero=${r.aero.toFixed(2)}`,
    );
  }
  console.log(
    `${label} tc=${a.tc} total ${(total / 1000).toFixed(2)} s, DNF ${dnf}, respawns ${resp}, impacts ${imp}, smoke ${(smoke * 100).toFixed(1)}%, lamp ${(lamp * 100).toFixed(1)}%, max aero ${aero.toFixed(2)}`,
  );
}

if (on('bot')) campaignRun('BOT', botDriver, NORMAL);
if (on('touch')) {
  campaignRun('TOUCH', touchDriver, NORMAL);
  campaignRun('TOUCH', touchDriver, LOW);
}
