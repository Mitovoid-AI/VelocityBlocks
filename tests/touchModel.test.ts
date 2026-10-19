// The on-screen controls' finger rules (TouchModel) and the pedal curves.

import { describe, expect, it } from 'vitest';
import {
  BRAKE_MIN,
  GAS_MIN,
  nextSteerMode,
  pedalValue,
  TouchModel,
  WHEEL_LOCK_DEG,
  type CtlKey,
  type Rect,
} from '../src/input/touchModel';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

// The 640x360 layout: buttons bottom left, brake and gas bars bottom right (gas outermost).
const VW = 640;
const LAYOUT: Partial<Record<CtlKey, Rect>> = {
  left: rect(18, 241, 101, 324),
  right: rect(115, 241, 198, 324),
  brake: rect(487, 166, 544, 324),
  gas: rect(564, 166, 622, 324),
};
const BAR_H = 324 - 166;
/** y on a bar at fraction `t` of its height from the bottom. */
const at = (t: number) => 324 - t * BAR_H;

function model(boxes = LAYOUT): TouchModel {
  const m = new TouchModel();
  m.setTargets(boxes, VW);
  return m;
}

describe('pedalValue', () => {
  it('gas: a touch at the bottom gives the minimum, full from 30% of the bar up', () => {
    expect(pedalValue('gas', at(0), 166, 324)).toBeCloseTo(GAS_MIN, 6);
    expect(GAS_MIN).toBe(0.35);
    expect(pedalValue('gas', at(0.15), 166, 324)).toBeCloseTo(0.675, 6);
    expect(pedalValue('gas', at(0.3), 166, 324)).toBeCloseTo(1, 9);
    expect(pedalValue('gas', at(0.31), 166, 324)).toBe(1);
    expect(pedalValue('gas', at(0.8), 166, 324)).toBe(1);
    expect(pedalValue('gas', 100, 166, 324)).toBe(1); // above the top
  });

  it('brake: always above the drift threshold (0.5), full from half the bar up', () => {
    expect(pedalValue('brake', at(0), 166, 324)).toBeCloseTo(BRAKE_MIN, 6);
    expect(BRAKE_MIN).toBe(0.55);
    expect(pedalValue('brake', at(0.5), 166, 324)).toBeCloseTo(1, 9);
    expect(pedalValue('brake', at(0.51), 166, 324)).toBe(1);
    expect(pedalValue('brake', at(1), 166, 324)).toBe(1);
  });

  it('never gives a tiny non-zero value and never drops going up the bar', () => {
    for (const key of ['gas', 'brake'] as const) {
      let prev = 0;
      for (let y = 340; y >= 150; y -= 0.5) {
        const v = pedalValue(key, y, 166, 324);
        expect(v).toBeGreaterThanOrEqual(key === 'gas' ? GAS_MIN : BRAKE_MIN);
        expect(v).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('TouchModel buttons and pedals', () => {
  it('starts and ends released: no steer, and exactly 0 gas and brake', () => {
    const m = model();
    expect(m.read()).toMatchObject({ steer: null, wheel: null, gas: 0, brake: 0 });
    m.press(1, 'gas', 590, at(0.5));
    m.press(2, 'left', 60, 280);
    expect(m.lift(1)).toBe(true);
    expect(m.lift(1)).toBe(false);
    m.clear();
    expect(m.read()).toMatchObject({ steer: null, gas: 0, brake: 0 });
  });

  it('a gas thumb and a steering thumb work together', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0.1));
    m.press(2, 'left', 60, 280);
    const r = m.read();
    expect(r.steer).toBe(-1);
    expect(r.gas).toBeGreaterThan(GAS_MIN);
    expect(r.gas).toBeLessThan(1);
    expect(r.pads).toEqual({ left: true, right: false });
  });

  it('both steering buttons cancel to 0, not null (tilt stays out)', () => {
    const m = model();
    m.press(1, 'left', 60, 280);
    m.press(2, 'right', 150, 280);
    expect(m.read().steer).toBe(0);
  });

  it('gas follows the thumb up and down the bar', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0));
    expect(m.read().gas).toBeCloseTo(GAS_MIN, 6);
    expect(m.move(1, 590, at(0.4), true)).toBe(true);
    expect(m.read().gas).toBe(1);
    expect(m.move(1, 590, at(0.6), true)).toBe(false); // still full: nothing changed
    m.move(1, 590, at(0.1), true);
    expect(m.read().gas).toBeCloseTo(pedalValue('gas', at(0.1), 166, 324), 6);
  });

  it('gas keeps its last value when the thumb slides off the bar, below it or sideways', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0.2));
    const v = m.read().gas;
    expect(m.move(1, 590, 350, true)).toBe(false); // below the bar
    expect(m.move(1, 530, at(0.9), true)).toBe(false); // past the gap, but not far into the brake
    expect(m.read()).toMatchObject({ gas: v, brake: 0 });
  });

  it('a thumb drifting a little beside the bar still works it', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0.1));
    expect(m.move(1, 553, at(0.9), true)).toBe(true); // in the gap towards the brake
    expect(m.read().gas).toBe(1);
    m.move(1, 639, at(0), true); // out at the screen edge
    expect(m.read().gas).toBeCloseTo(GAS_MIN, 6);
  });

  it('slides from gas to brake only a third of the way into the brake bar', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0.2));
    m.move(1, 538, at(0.2), true); // 6 px into the brake bar
    expect(m.read()).toMatchObject({ gas: expect.any(Number), brake: 0 });
    expect(m.read().gas).toBeGreaterThan(0);
    expect(m.move(1, 520, at(0.2), true)).toBe(true); // 24 px in (a third is 19)
    const r = m.read();
    expect(r.gas).toBe(0);
    expect(r.brake).toBeGreaterThanOrEqual(BRAKE_MIN);
    // And back: a third of the way into the gas bar.
    m.move(1, 570, at(0.2), true);
    expect(m.read().brake).toBeGreaterThan(0);
    m.move(1, 590, at(0.2), true);
    expect(m.read()).toMatchObject({ gas: expect.any(Number), brake: 0 });
  });

  it('the brake lets go (exactly 0) when the thumb slides off towards the middle, and takes hold again', () => {
    const m = model();
    m.press(1, 'brake', 515, at(0.2));
    expect(m.read().brake).toBeGreaterThan(0.5);
    expect(m.move(1, 487 - 30, at(0.2), true)).toBe(true);
    expect(m.read().brake).toBe(0);
    // A finger that let go only takes a pedal again, never a steering button.
    expect(m.move(1, 150, 280, true)).toBe(false);
    expect(m.read().steer).toBeNull();
    expect(m.move(1, 515, at(0.6), true)).toBe(true);
    expect(m.read().brake).toBe(1);
  });

  it('with the brake on the left (tilt), the middle of the screen is to its right', () => {
    const m = model({ brake: rect(18, 166, 75, 324), gas: rect(564, 166, 622, 324) });
    m.press(1, 'brake', 45, at(0.2));
    expect(m.move(1, 5, at(0.2), true)).toBe(false); // towards the edge: kept
    expect(m.read().brake).toBeGreaterThan(0);
    m.move(1, 75 + 30, at(0.2), true);
    expect(m.read().brake).toBe(0);
  });

  it('round on/off pedals: any touch is full, and sliding off keeps it', () => {
    const m = model();
    m.digital = true;
    m.press(1, 'gas', 590, at(0));
    expect(m.read().gas).toBe(1);
    m.press(2, 'brake', 515, at(0));
    expect(m.read().brake).toBe(1);
    expect(m.move(2, 300, at(0.2), true)).toBe(false); // far towards the middle: still braking
    expect(m.read().brake).toBe(1);
  });

  it('a steering button finger slides to the other button but never takes a pedal', () => {
    const m = model();
    m.press(1, 'left', 60, 280);
    expect(m.move(1, 150, 280, true)).toBe(true);
    expect(m.read().steer).toBe(1);
    expect(m.move(1, 300, 200, true)).toBe(false); // empty space: keeps the button
    expect(m.read().steer).toBe(1);
    expect(m.move(1, 590, at(0.5), true)).toBe(false); // over the gas bar
    expect(m.read()).toMatchObject({ steer: 1, gas: 0 });
  });

  it('a thumb held through the pause takes the control it moves onto after Resume', () => {
    const m = model();
    expect(m.move(7, 300, 200, true)).toBe(false); // nothing there
    expect(m.move(7, 590, at(0.5), true)).toBe(true);
    expect(m.read().gas).toBe(1);
    expect(m.move(8, 60, 280, true)).toBe(true);
    expect(m.read().steer).toBe(-1);
  });

  it('a mouse only drives what it pressed', () => {
    const m = model();
    expect(m.move(1, 590, at(0.5), false)).toBe(false);
    expect(m.read().gas).toBe(0);
  });

  it('hidden controls (zero-size boxes) take no fingers', () => {
    const m = model({ ...LAYOUT, left: rect(0, 0, 0, 0), right: rect(0, 0, 0, 0) });
    expect(m.move(1, 60, 280, true)).toBe(false);
    expect(m.read().steer).toBeNull();
  });

  it('releaseSteering lets go of the steering but keeps the pedals', () => {
    const m = model();
    m.press(1, 'gas', 590, at(0.5));
    m.press(2, 'right', 150, 280);
    expect(m.releaseSteering()).toBe(true);
    expect(m.read()).toMatchObject({ steer: null, gas: 1 });
    expect(m.releaseSteering()).toBe(false);
  });
});

describe('TouchModel wheel', () => {
  // A 154 px wheel bottom left: centre (95, 247), radius 77.
  const WHEEL = rect(18, 170, 172, 324);
  const CX = 95;
  const CY = 247;
  /** A point at `deg` clockwise from 12 o'clock, `d` px from the centre. */
  const pt = (deg: number, d = 70): [number, number] => [CX + d * Math.sin((deg * Math.PI) / 180), CY - d * Math.cos((deg * Math.PI) / 180)];
  const wheel = () => model({ wheel: WHEEL, gas: LAYOUT.gas });

  it('grabbing gives 0 wherever the finger lands (no jump), then follows the turn', () => {
    const m = wheel();
    expect(m.press(1, 'wheel', ...pt(0))).toBe(true);
    expect(m.read()).toMatchObject({ steer: 0, wheel: 0 });
    m.move(1, ...pt(90), true);
    expect(m.read().steer).toBeCloseTo(90 / WHEEL_LOCK_DEG, 6);
    m.move(1, ...pt(180), true);
    expect(m.read().steer).toBe(1); // hard stop at full lock
    m.move(1, ...pt(170), true);
    expect(m.read().steer).toBeCloseTo(0.9, 6); // no wind-up past the stop
  });

  it('grabbing low on the wheel does not jump either', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(150));
    expect(m.read().steer).toBe(0);
    m.move(1, ...pt(-150), true); // across 6 o'clock, where atan2 wraps
    expect(m.read().steer).toBeCloseTo(0.6, 6);
  });

  it('turns left with a negative steer', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(0));
    m.move(1, ...pt(-45), true);
    expect(m.read().steer).toBeCloseTo(-0.45, 6);
  });

  it('a finger over the hub turns nothing and grabs again on the way out', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(0));
    m.move(1, ...pt(30), true);
    const before = m.read().steer!;
    expect(m.move(1, CX + 5, CY + 3, true)).toBe(false);
    m.move(1, ...pt(200), true); // out the far side
    expect(m.read().steer).toBeCloseTo(before, 6);
  });

  it('turns less near the hub, where a small move is a big angle', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(0, 35)); // 35 px of 77: under 0.6 r, so damped
    m.move(1, ...pt(40, 35), true);
    expect(m.read().steer).toBeCloseTo((40 * (35 / (0.6 * 77))) / WHEEL_LOCK_DEG, 6);
  });

  it('ignores a second finger, and centres (null) when let go', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(0));
    m.move(1, ...pt(50), true);
    expect(m.press(2, 'wheel', ...pt(180))).toBe(false);
    expect(m.move(2, ...pt(90), true)).toBe(false);
    expect(m.read().steer).toBeCloseTo(0.5, 6);
    m.lift(2);
    expect(m.read().steer).toBeCloseTo(0.5, 6);
    m.lift(1);
    expect(m.read()).toMatchObject({ steer: null, wheel: null });
    // A new grab starts from the centre.
    m.press(3, 'wheel', ...pt(90));
    expect(m.read().steer).toBe(0);
  });

  it('keeps its finger: turning over the gas bar does not press gas', () => {
    const m = wheel();
    m.press(1, 'wheel', ...pt(90));
    expect(m.move(1, 590, at(0.5), true)).toBe(true);
    expect(m.read().gas).toBe(0);
  });
});

describe('nextSteerMode', () => {
  it('cycles Buttons, Wheel, Tilt', () => {
    expect(nextSteerMode('buttons')).toBe('wheel');
    expect(nextSteerMode('wheel')).toBe('tilt');
    expect(nextSteerMode('tilt')).toBe('buttons');
  });
});
