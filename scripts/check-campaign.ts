// Builds every campaign definition and reports layout errors: node <tmp>/check-campaign.mjs
// (<tmp>/check-campaign.mjs is this file bundled with the local esbuild; see Helper scripts in README.md)
import { buildTrack } from '../src/track/builder';
import { CAMPAIGN_DEFS } from '../src/track/campaign';
for (const [id, , name, code] of CAMPAIGN_DEFS) {
  try {
    const t = buildTrack(`${id} ${name}`, code);
    console.log(`OK   ${id} ${name} (${t.blocks.length} blocks)`);
  } catch (e) {
    console.log(`FAIL ${String(e)}`);
  }
}
