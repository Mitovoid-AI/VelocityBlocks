// Built-in campaign. Tracks are authored in the text format from builder.ts.
// Ground-level roads have no barriers, so hairpin and zigzag tracks carry extra checkpoints
// (plain straights swapped for checkpoint blocks) to stop gate-to-gate cuts across the grass.
//
// Three sets: Stadium (A01-A12, the original campaign, unchanged), Desert (D01-D06: sand off the road,
// dunes and mesas, two at sunset) and Water (W01-W06: bridges and jumps over lakes and rivers, splash
// zones; a fall into the water respawns). Each set runs easy to hard, and `difficulty` places every track on
// one scale: the Desert and Water tracks sit between the Stadium steps (D01 between A01 and A02, W01
// between A02 and A03, and so on; W06 comes after A12).

import { buildTrack } from './builder';
import type { Theme, TrackData } from './track';

/** Difficulty tier, shown as the coloured series tag (White easiest, Black hardest). */
export type CampaignSeries = 'White' | 'Green' | 'Blue' | 'Red' | 'Black';
/** The campaign's sets, as the menu groups them. */
export type CampaignSet = 'Stadium' | 'Desert' | 'Water';

export interface CampaignTrack {
  id: string;
  /** Difficulty tier (the colour tag). */
  series: CampaignSeries;
  /** Which set the track belongs to. */
  set: CampaignSet;
  /** Its look and off-road ground (data.theme, 'stadium' when absent). */
  theme: Theme;
  /** Track name without the id (data.name is "<id> <name>"). */
  name: string;
  /** 1-based position in its set, easiest first. */
  setIndex: number;
  /**
   * Place on the campaign's one difficulty scale: the Stadium tracks are 1..12 (A01..A12), the Desert ones
   * sit half a step after an odd Stadium track (D01 1.5 .. D06 11.5), the Water ones half a step after an
   * even one (W01 2.5 .. W06 12.5). Sort by it for one easy-to-hard list.
   */
  difficulty: number;
  data: TrackData;
}

/**
 * [id, series, name, code, difficulty]. The theme comes from the code (builder.ts: "!desert", "!water",
 * "!sunset"), so buildTrack(code) alone gives the track the game races.
 */
export type CampaignDef = [string, CampaignSeries, string, string, number];

export const CAMPAIGN_DEFS: CampaignDef[] = [
  ['A01', 'White', 'Warm-Up', 'St Sx2 C Sx2 R2 Sx2 C S L2 Sx2 F', 1],
  ['A02', 'White', 'Twin Bends', 'St S B Sx2 R C L Sx2 C S L C R S B Sx2 C S R2 Sx2 F', 2],
  ['A03', 'White', 'Climber', 'St S B U Sx2 C S D S R S U S C S R S D Sx2 B S F', 3],
  ['A04', 'Green', 'First Flight', 'St S T Sx2 U S C S J G G Sx3 C S R2 S D Sx2 F', 4],
  ['A05', 'Green', 'Zigzag', 'St B S R L C R L Sx2 C S R2 C L R C L S C Sx2 L2 S B Sx2 F', 5],
  ['A06', 'Green', 'Overpass', 'St S T U U Sx2 C S R2 S R2 S D S C S L S L Sx2 D Sx2 B S F', 6],
  ['A07', 'Blue', 'Turbo Valley', '@1 St B S D S T S U Sx2 C S L2 S B S D S U S C Sx2 R2 S T J G G Sx3 F', 7],
  ['A08', 'Blue', 'Hairpins', 'St B C R R Sx3 C L L Sx2 B C R R Sx3 C S L2 C L2 Sx2 F', 8],
  ['A09', 'Blue', 'Sky Bridge', 'St T U U U Sx2 C S J G G Sx4 R2 S C S J G G Sx4 R2 S D D Sx2 C S T S D Sx2 F', 9],
  ['A10', 'Red', 'Long Haul', 'St B Sx3 R2 S C S T U S L S R S C S D S L S B S C S R S J G G Sx3 C S L C L2 Sx2 F', 10],
  ['A11', 'Red', 'Drop Zone', '@3 St T Sx2 D S C S J G G S D S C S R2 S J G G Sx2 D S C S L2 S T S F', 11],
  ['A12', 'Black', 'Grand Tour', 'St T Sx2 U U S C S R2 S J G G Sx4 R S C S D S L S L S T Sx2 C S U S R2 S C S J G G Sx4 L2 S D S D Sx2 C S R C R S B Sx3 F', 12],

  ['D01', 'White', 'Dune Road', '!desert St Sx2 B S C Sx2 L2 Sx2 C S R2 Sx3 F', 1.5],
  ['D02', 'White', 'Sandbanks', '!desert St B S U D S C S R2 S U S D S C Sx2 L2 S B Sx2 F', 3.5],
  ['D03', 'Green', 'Mesa Loop', '!desert St B Sx2 U U S C S R2 S R2 S D S C S L Sx2 C S L2 D Sx2 F', 5.5],
  ['D04', 'Blue', 'Canyon Leap', '!desert !sunset St T U U Sx2 C S J G G Sx4 R2 S C S D D Sx2 C S L2 S B Sx2 F', 7.5],
  ['D05', 'Red', 'Sidewinder', '!desert !sunset St B C R R Sx3 C L L Sx2 C R2 Sx2 T Sx2 U S C S J G G Sx3 C S L2 S D Sx2 F', 9.5],
  ['D06', 'Black', 'Sunset Rally', '!desert !sunset St T Sx2 U U S C S R2 S J G G Sx4 R S C S D S L S L S T Sx2 C S U D S C S R2 S D Sx2 C L L Sx2 C S R2 Sx2 B S F', 11.5],

  ['W01', 'White', 'Harbour Bridge', '!water St S B Sx2 U ~Sx2 D S C S R2 S C Sx2 L2 Sx2 F', 2.5],
  ['W02', 'Green', 'Splash Lane', '!water St S B Sx2 W S C S R2 S W Sx2 C S U S J ~ ~ Sx2 D S C S L2 Sx2 F', 4.5],
  ['W03', 'Blue', 'River Run', '!water St S T Sx2 U S C S J ~ ~ Sx3 C S R2 S D S W S C S L2 S U ~Sx2 D S F', 6.5],
  ['W04', 'Blue', 'Lagoon', '!water !lake St T U U Sx2 C S R2 S C S R2 S D D S C S W S L2 S C Sx2 F', 8.5],
  ['W05', 'Red', 'Island Hop', '!water !lake St T U U Sx2 C S J G G Sx4 R2 S C S J G G Sx4 R2 S D D Sx2 C S W S F', 10.5],
  ['W06', 'Black', 'Tidal Tour', '!water St T Sx2 U U S C S J ~ ~ Sx3 R2 S C S D S W Sx2 C S R2 S U S J ~ ~ Sx3 R2 S T S C S D Sx2 L2 S D S W S ~S ~C ~S S L2 Sx2 C R R Sx3 C S B Sx2 F', 12.5],
];

/** The sets in menu order, each with its theme. */
export const CAMPAIGN_SETS: readonly { set: CampaignSet; theme: Theme; prefix: string }[] = [
  { set: 'Stadium', theme: 'stadium', prefix: 'A' },
  { set: 'Desert', theme: 'desert', prefix: 'D' },
  { set: 'Water', theme: 'water', prefix: 'W' },
];

function setOf(id: string): CampaignSet {
  return CAMPAIGN_SETS.find((s) => id.startsWith(s.prefix))?.set ?? 'Stadium';
}

let cache: CampaignTrack[] | null = null;

/**
 * The campaign, built on first use: the Stadium set first (A01..A12, in the order the game always had, so
 * its unlock chain is unchanged), then the Desert set and the Water set, each easiest first.
 */
export function campaign(): CampaignTrack[] {
  if (!cache) {
    const pos: Record<string, number> = {};
    cache = CAMPAIGN_DEFS.map(([id, series, name, code, difficulty]) => {
      const set = setOf(id);
      const data = buildTrack(`${id} ${name}`, code);
      return {
        id,
        series,
        set,
        theme: data.theme ?? 'stadium',
        name,
        setIndex: (pos[set] = (pos[set] ?? 0) + 1),
        difficulty,
        data,
      };
    });
  }
  return cache;
}

/** One set's tracks, easiest first. */
export function campaignSet(set: CampaignSet): CampaignTrack[] {
  return campaign().filter((c) => c.set === set);
}

/** Every track on the one difficulty scale, easiest first (Stadium, Desert and Water interleaved). */
export function campaignByDifficulty(): CampaignTrack[] {
  return [...campaign()].sort((a, b) => a.difficulty - b.difficulty);
}

/** A campaign track by id, or undefined. */
export function campaignTrack(id: string): CampaignTrack | undefined {
  return campaign().find((c) => c.id === id);
}
