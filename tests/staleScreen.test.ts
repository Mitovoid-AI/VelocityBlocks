// A replaced screen never acts: a tap that began on the old screen (the Stadium tab) can deliver its click
// to the detached old card after a re-render (the Desert tab), and used to start A01 instead of D01.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { showScreen } from '../src/ui/dom';

type Fn = (e: unknown) => void;

/** Just enough of an element for showScreen: listeners, dataset, closest and connection to the host. */
class FakeEl {
  dataset: Record<string, string> = {};
  className = '';
  isConnected = false;
  private kids: FakeEl[] = [];
  private readonly on = new Map<string, Fn[]>();
  set innerHTML(v: string) {
    if (v === '') for (const k of this.kids.splice(0)) k.isConnected = false;
  }
  get innerHTML(): string {
    return '';
  }
  appendChild(c: FakeEl): void {
    this.kids.push(c);
    c.isConnected = true;
  }
  addEventListener(type: string, fn: Fn): void {
    this.on.set(type, [...(this.on.get(type) ?? []), fn]);
  }
  closest(): FakeEl | null {
    return this.dataset.act ? this : null;
  }
  contains(): boolean {
    return true;
  }
  querySelector(): null {
    return null;
  }
  fire(type: string, e: object): void {
    for (const fn of this.on.get(type) ?? []) fn(e);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('showScreen', () => {
  it('drops the clicks of a screen that has been replaced', () => {
    const host = new FakeEl();
    host.isConnected = true;
    vi.stubGlobal('Element', FakeEl);
    vi.stubGlobal('document', { querySelector: () => host, createElement: () => new FakeEl() });
    const card = (id: string) => Object.assign(new FakeEl(), { dataset: { act: 'race', id } });
    const stadium = vi.fn();
    const desert = vi.fn();
    const s1 = showScreen('', 'campaign', { race: stadium }) as unknown as FakeEl;
    const a01 = card('A01');
    s1.fire('click', { target: a01, isTrusted: true });
    expect(stadium).toHaveBeenCalledTimes(1);
    // The Desert tab re-renders: the old screen and its A01 card are detached.
    const s2 = showScreen('', 'campaign', { race: desert }) as unknown as FakeEl;
    s1.fire('click', { target: a01, isTrusted: true });
    s1.fire('pointerdown', { target: a01, pointerType: 'touch', isPrimary: false, pointerId: 2 });
    s1.fire('pointerup', { pointerId: 2, clientX: 0, clientY: 0 });
    expect(stadium).toHaveBeenCalledTimes(1);
    s2.fire('click', { target: card('D01'), isTrusted: true });
    expect(desert).toHaveBeenCalledTimes(1);
  });
});
