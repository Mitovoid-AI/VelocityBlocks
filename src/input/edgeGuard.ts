// Keeping Android's system gestures off the touch controls. The contract every touch layout uses:
// - controls are placed with the --ctl-l / --ctl-r / --ctl-b / --ctl-t insets (styles.css :root).
//   They add the system gesture strips (--gest-*, reported by the Android app) to the safe area,
//   so a thumb resting on a control is never inside a back-swipe, home-bar or shade strip;
// - every cluster anchored to a side edge carries data-edge-guard (index.html #touch);
// - App.syncEdgeGuard() turns the guarded boxes into gesture-exclusion rects (Android 10+). It
//   runs whenever the controls are shown, hidden or moved; call it after changing the layout.

/** A control's box in CSS px (a DOMRect fits). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** An area where Android's back swipe is turned off, in CSS px. */
export interface ExclusionRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** System gesture strips along each screen edge, in dp (= CSS px in the WebView). */
export interface GestureInsets {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** Android excludes at most 200 dp per side edge (and some phones keep that limit in immersive mode). */
export const EXCLUSION_CAP = 200;
/** Slack around each control: a thumb lands a little off it. */
export const EXCLUSION_MARGIN = 24;
/** A reported strip is never taken as wider than this, so a bogus value can't push the controls mid-screen. */
export const MAX_GESTURE_INSET = 64;

/**
 * Exclusion rects for the guarded control boxes. Each box grows by `margin` and stretches out to
 * its nearer side edge, since a thumb can land between the control and the edge. The lowest boxes
 * are served first, so where the per-edge cap bites, the part trimmed is the top of the higher ones.
 * Hidden controls (zero-size boxes) give no rects.
 */
export function edgeExclusionRects(
  boxes: readonly Box[],
  vw: number,
  vh: number,
  margin = EXCLUSION_MARGIN,
  cap = EXCLUSION_CAP,
): ExclusionRect[] {
  const out: ExclusionRect[] = [];
  const used = { left: 0, right: 0 };
  const shown = boxes.filter((b) => b.width > 0 && b.height > 0).sort((a, c) => c.bottom - a.bottom);
  for (const b of shown) {
    const side = b.left + b.width / 2 < vw / 2 ? 'left' : 'right';
    const bottom = Math.min(vh, b.bottom + margin);
    const top = Math.max(0, b.top - margin, bottom - (cap - used[side]));
    if (bottom <= top) continue;
    used[side] += bottom - top;
    out.push(
      side === 'left'
        ? { l: 0, t: top, r: Math.min(vw, b.right + margin), b: bottom }
        : { l: Math.max(0, b.left - margin), t: top, r: vw, b: bottom },
    );
  }
  return out;
}

/** The --gest-* CSS variables for reported gesture strips, rounded and clamped to 0..MAX_GESTURE_INSET. */
export function gestureInsetVars(g: GestureInsets): Record<string, string> {
  const px = (v: number) => `${Math.round(Math.min(MAX_GESTURE_INSET, Math.max(0, v || 0)))}px`;
  return { '--gest-l': px(g.l), '--gest-r': px(g.r), '--gest-t': px(g.t), '--gest-b': px(g.b) };
}
