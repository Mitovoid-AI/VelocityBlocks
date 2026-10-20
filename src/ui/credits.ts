// The Settings > Credits text for the realistic vehicle models: who made each, where it came from, its
// license and what was changed (CC BY 4.0 asks for all four). Plain text, no links. No DOM, so tests read it.

import { creditGroups } from '../core/vehicleModels';

export const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One block per source model: title, the vehicles made from it, author, source, license and changes. */
export function creditsHtml(): string {
  return creditGroups()
    .map(
      ({ credit: c, models }) => `<div class="credit">
        <h3>${escape(c.title)}</h3>
        <p>In the game as: ${escape(models.map((m) => m.name).join(', '))}</p>
        <p>By ${escape(c.author)} (${escape(c.authorUrl)})</p>
        <p>Source: ${escape(c.sourceUrl)}</p>
        <p>License: ${escape(c.license)} (${escape(c.licenseUrl)})</p>
        <p class="muted">${escape(c.line)}</p>
        <p class="muted">Changes: ${escape(c.changes)}</p>
      </div>`,
    )
    .join('');
}
