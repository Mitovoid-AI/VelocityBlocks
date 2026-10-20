// Medal thresholds derived from the author time (our design: +6% / +20% / +50%, rounded up to whole seconds).

import { PHYSICS_VERSION, VEHICLE_REV } from '../core/constants';
import type { VehicleClass } from '../core/vehicles';
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

/** One class's author times, tagged with the VEHICLE_REV they were driven with. */
export interface ClassAuthorTimes {
  rev: number;
  times: Record<string, number>;
}

/**
 * authorTimes.json (scripts/author-times.ts): the car's times at the top level (their pre-class shape,
 * which older builds read), the other classes in sections.
 */
export interface AuthorTable {
  physics: number;
  times: Record<string, number>;
  bike?: ClassAuthorTimes;
  truck?: ClassAuthorTimes;
}

/** A class's author times in a table, or null when the table is for other physics or another revision. */
export function classAuthorTimes(t: AuthorTable, vehicle: VehicleClass): Record<string, number> | null {
  if (t.physics !== PHYSICS_VERSION) return null;
  if (vehicle === 'car') return t.times;
  const sec = t[vehicle];
  return sec && sec.rev === VEHICLE_REV[vehicle] ? sec.times : null;
}

const computed = new Map<string, number>();

/**
 * Author time for a campaign track and vehicle class: the precomputed table, or the autopilot when that
 * class's physics changed (a multi-second freeze on phones, so the table is regenerated with every change).
 * Author times are open-road times and shared by both wall modes.
 */
export function campaignAuthorTime(id: string, vehicle: VehicleClass = 'car'): number | null {
  const t = classAuthorTimes(authorTimes as AuthorTable, vehicle)?.[id];
  if (t) return t;
  const memo = `${id}@${vehicle}`;
  if (computed.has(memo)) return computed.get(memo)!;
  const ct = campaign().find((c) => c.id === id);
  if (!ct) return null;
  const r = runBot(new Track(ct.data), 300, { vehicle });
  const time = r.finished ? r.time! : null;
  if (time) computed.set(memo, time);
  return time;
}
