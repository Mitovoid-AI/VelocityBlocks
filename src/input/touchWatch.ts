// Which touches Android took away during a race. Everything a racing touch can land on (the
// controls, the HUD, the canvas) has touch-action:none, so the browser never cancels it to scroll:
// a pointercancel there means the system took the finger, for a back or home swipe, the shade or
// an assistant swipe. A back swipe is cancelled as soon as it crosses the touch slop, but Back
// only arrives when the finger lifts, which can be seconds later. Listens on the window in the
// capture phase, so it works with any touch-control markup.

/** One touch the system took: when it went down and when it was cancelled. */
export interface SysCancel {
  downAt: number;
  at: number;
}

/** Cancels closer together than this are one gesture (up to Android 12 a back swipe cancels every finger). */
export const CANCEL_BURST_MS = 50;
/** How long a cancel is kept: longer than any Back rule looks back. */
const KEEP_MS = 15_000;
/** Touches whose up or cancel never arrived are dropped, oldest first, beyond this many. */
const MAX_DOWN = 16;

export class TouchWatch {
  /** Touches that went down during a race: pointerId to pointerdown time. */
  private down = new Map<number, number>();
  private cancels: SysCancel[] = [];
  private lastCancelAt = -Infinity;
  /** System-cancel bursts so far (one per gesture), for the pause screen's diagnostics line. */
  bursts = 0;

  /** `armed` says whether a race is running: only touches that go down then are watched. */
  constructor(
    private readonly armed: () => boolean,
    target: Pick<Window, 'addEventListener'> = window,
    private readonly now: () => number = () => performance.now(),
  ) {
    target.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch' || !this.armed()) return;
        if (this.down.size >= MAX_DOWN) this.down.delete(this.down.keys().next().value!);
        this.down.set(e.pointerId, this.now());
      },
      true,
    );
    target.addEventListener('pointerup', (e) => this.down.delete(e.pointerId), true);
    target.addEventListener(
      'pointercancel',
      (e) => {
        const downAt = this.down.get(e.pointerId);
        if (downAt === undefined) return;
        this.down.delete(e.pointerId);
        const at = this.now();
        if (at - this.lastCancelAt > CANCEL_BURST_MS) this.bursts++;
        this.lastCancelAt = at;
        this.cancels.push({ downAt, at });
        this.prune(at);
      },
      true,
    );
  }

  /** System cancels of the last 15 s, oldest first. */
  recent(): readonly SysCancel[] {
    this.prune(this.now());
    return this.cancels;
  }

  private prune(now: number): void {
    if (this.cancels.length && now - this.cancels[0].at > KEEP_MS) this.cancels = this.cancels.filter((c) => now - c.at <= KEEP_MS);
  }
}
