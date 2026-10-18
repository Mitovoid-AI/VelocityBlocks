// Built-in campaign. Tracks are authored in the text format from builder.ts.
// Ground-level roads have no barriers, so hairpin and zigzag tracks carry extra checkpoints
// (plain straights swapped for checkpoint blocks) to stop gate-to-gate cuts across the grass.

import { buildTrack } from './builder';
import type { TrackData } from './track';

export interface CampaignTrack {
  id: string;
  series: 'White' | 'Green' | 'Blue' | 'Red' | 'Black';
  data: TrackData;
}

export const CAMPAIGN_DEFS: [string, CampaignTrack['series'], string, string][] = [
  ['A01', 'White', 'Warm-Up', 'St Sx2 C Sx2 R2 Sx2 C S L2 Sx2 F'],
  ['A02', 'White', 'Twin Bends', 'St S B Sx2 R C L Sx2 C S L C R S B Sx2 C S R2 Sx2 F'],
  ['A03', 'White', 'Climber', 'St S B U Sx2 C S D S R S U S C S R S D Sx2 B S F'],
  ['A04', 'Green', 'First Flight', 'St S T Sx2 U S C S J G G Sx3 C S R2 S D Sx2 F'],
  ['A05', 'Green', 'Zigzag', 'St B S R L C R L Sx2 C S R2 C L R C L S C Sx2 L2 S B Sx2 F'],
  ['A06', 'Green', 'Overpass', 'St S T U U Sx2 C S R2 S R2 S D S C S L S L Sx2 D Sx2 B S F'],
  ['A07', 'Blue', 'Turbo Valley', '@1 St B S D S T S U Sx2 C S L2 S B S D S U S C Sx2 R2 S T J G G Sx3 F'],
  ['A08', 'Blue', 'Hairpins', 'St B C R R Sx3 C L L Sx2 B C R R Sx3 C S L2 C L2 Sx2 F'],
  ['A09', 'Blue', 'Sky Bridge', 'St T U U U Sx2 C S J G G Sx4 R2 S C S J G G Sx4 R2 S D D Sx2 C S T S D Sx2 F'],
  ['A10', 'Red', 'Long Haul', 'St B Sx3 R2 S C S T U S L S R S C S D S L S B S C S R S J G G Sx3 C S L C L2 Sx2 F'],
  ['A11', 'Red', 'Drop Zone', '@3 St T Sx2 D S C S J G G S D S C S R2 S J G G Sx2 D S C S L2 S T S F'],
  ['A12', 'Black', 'Grand Tour', 'St T Sx2 U U S C S R2 S J G G Sx4 R S C S D S L S L S T Sx2 C S U S R2 S C S J G G Sx4 L2 S D S D Sx2 C S R C R S B Sx3 F'],
];

let cache: CampaignTrack[] | null = null;

/** The campaign, built on first use. */
export function campaign(): CampaignTrack[] {
  if (!cache) {
    cache = CAMPAIGN_DEFS.map(([id, series, name, code]) => ({
      id,
      series,
      data: buildTrack(`${id} ${name}`, code),
    }));
  }
  return cache;
}
