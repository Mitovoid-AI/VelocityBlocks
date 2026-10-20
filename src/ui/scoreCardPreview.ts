// Development builds only (main.ts imports it behind import.meta.env.DEV): window.vbScore(variant)
// shows the results card with sample runs, driven by its own frame loop, for visual checks at
// any window size without driving a race. Tree-shaken from release builds.

import { medalTimes } from '../game/medals';
import { prefersReducedMotion, showScreen, clearScreen } from './dom';
import { ScoreClock, scoreCardHtml, scoreModel, type ScoreInput } from './scoreCard';
import { ScoreCardView } from './scoreCardView';

const AUTHOR = 13900;
const VARIANTS: Record<string, Partial<ScoreInput>> = {
  author: { time: 13780, previous: 14450, improved: true },
  gold: { time: 14800, previous: 17200, improved: true, respawns: 1 },
  none: { time: 23400, previous: 22100, improved: false, respawns: 3 },
  first: { time: 16900, previous: null, improved: true },
  held: { time: 14700, previous: 13850, improved: false },
  editor: { time: 14200, previous: null, improved: true, medals: null, newAuthor: 14200, fromEditor: true, hasNext: false },
  walls: { time: 15100, previous: 15600, improved: true, tags: ['Bike', 'Walls on'] },
};

export function install(): void {
  (window as unknown as { vbScore: (v?: string) => void }).vbScore = (v = 'author') => {
    const input: ScoreInput = {
      label: 'A01 Warm-up straight',
      tags: [],
      time: 15000,
      previous: null,
      improved: true,
      medals: medalTimes(AUTHOR),
      newAuthor: null,
      note: '',
      respawns: 0,
      hasNext: true,
      fromEditor: false,
      ...(VARIANTS[v] ?? VARIANTS.author),
    };
    const model = scoreModel(input);
    const animate = !prefersReducedMotion();
    let clock: ScoreClock | null = null;
    const el = showScreen(scoreCardHtml(model, animate), 'dim score-screen', {
      skip: () => clock?.skip(),
      retry: () => (window as unknown as { vbScore: (v?: string) => void }).vbScore(v),
      replay: () => clearScreen(),
      next: () => clearScreen(),
      menu: () => clearScreen(),
    });
    clock = new ScoreClock(model, new ScoreCardView(el, model, { lowFx: false }));
    if (!animate) clock.skip();
    let last = performance.now();
    const tick = (t: number) => {
      clock!.update((t - last) / 1000);
      last = t;
      if (!clock!.done && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}
