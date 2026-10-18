// Medal thresholds derived from the author time (our design: +6% / +20% / +50%, rounded up to whole seconds).

import { PHYSICS_VERSION } from '../core/constants';
import { campaign } from '../track/campaign';
import { Track } from '../track/track';
import authorTimes from '../track/authorTimes.json';
import { runBot } from './bot';

export interface MedalTimes {
  author: number;
  gold: number;
  silver: number;
  bronze: number;
}

export const MEDAL_NAMES = ['None', 'Bronze', 'Silver', 'Gold', 'Author'] as const;
export const MEDAL_COLORS = ['#666', '#cd7f32', '#c0c7d0', '#ffcf3f', '#3fe0ff'] as const;

const roundUpSecond = (ms: number) => Math.ceil(ms / 1000) * 1000;

export function medalTimes(author: number): MedalTimes {
  return {
    author,
    gold: roundUpSecond(author * 1.06),
    silver: roundUpSecond(author * 1.2),
    bronze: roundUpSecond(author * 1.5),
  };
}

/** 0 none, 1 bronze, 2 silver, 3 gold, 4 author. */
export function medalFor(time: number | null | undefined, m: MedalTimes | null): number {
  if (time === null || time === undefined || !m) return 0;
  if (time <= m.author) return 4;
  if (time <= m.gold) return 3;
  if (time <= m.silver) return 2;
  if (time <= m.bronze) return 1;
  return 0;
}

const computed = new Map<string, number>();

/** Author time for a campaign track: precomputed table, or the autopilot when physics changed. */
export function campaignAuthorTime(id: string): number | null {
  const table = authorTimes as { physics: number; times: Record<string, number> };
  if (table.physics === PHYSICS_VERSION && table.times[id]) return table.times[id];
  if (computed.has(id)) return computed.get(id)!;
  const ct = campaign().find((c) => c.id === id);
  if (!ct) return null;
  const r = runBot(new Track(ct.data), 300);
  const t = r.finished ? r.time! : null;
  if (t) computed.set(id, t);
  return t;
}
