// Medal targets as the HUD, campaign cards, My tracks and the editor show them. The author medal
// and its time stay secret on a track (a "?" medal with ?:??.??) until the player's best there has
// beaten the author time. Pure: strings only, so node tests cover them.

import { formatTime } from '../game/race';
import { medalFor, MEDAL_COLORS, MEDAL_NAMES, type MedalTimes } from '../game/medals';

/** Same character count as m:ss.cc, so the HUD target line keeps its width. */
export const SECRET_TIME = '?:??.??';
export const SECRET_TITLE = 'Secret author medal: beat the author time to reveal it';

/** Target time for medal n (1 bronze .. 4 author). */
export const medalTime = (m: MedalTimes, n: number): number => (n >= 4 ? m.author : n === 3 ? m.gold : n === 2 ? m.silver : m.bronze);

/**
 * The author medal and time are shown on a track once the player's best there (this physics
 * version's record for that key: vehicle class and wall mode) has beaten the author time. Derived,
 * so a record reset or a physics bump hides them again.
 */
export const authorRevealed = (best: number | null | undefined, m: MedalTimes | null): boolean => medalFor(best, m) === 4;

export const medalDot = (n: number): string => `<span class="medal" style="background:${MEDAL_COLORS[n]}" title="${MEDAL_NAMES[n]}"></span>`;

export const secretDot = (): string => `<span class="medal medal-secret" title="${SECRET_TITLE}"></span>`;

/** The HUD's medal line: author (or the secret), gold, silver, bronze. */
export function targetsHtml(m: MedalTimes | null, authorShown: boolean): string {
  if (!m) return '<span class="muted">No author time yet</span>';
  return [4, 3, 2, 1]
    .map((n) => (n === 4 && !authorShown ? `${secretDot()}${SECRET_TIME}` : `${medalDot(n)}${formatTime(medalTime(m, n))}`))
    .join('&nbsp;&nbsp;');
}

/** "Author 0:13.90", the secret, or "Author --" when the track has none. */
export function authorLabel(at: number | null | undefined, shown: boolean): string {
  if (!at) return 'Author --';
  return shown ? `Author ${formatTime(at)}` : `Author <span class="secret" title="${SECRET_TITLE}">${SECRET_TIME}</span>`;
}

/** How to set a custom track's author time: only walls-off test drives set it (authorTimeAfter). */
export const setAuthorHow = (walls: boolean, finish = 'finish'): string =>
  walls ? `Turn Walls on all roads off in Settings, then ${finish} a test drive` : `${finish[0].toUpperCase()}${finish.slice(1)} a test drive`;

/**
 * The editor status line's author part (plain text); `vehicle` names a class other than the car
 * ('Bike'), and `walls` is Settings > Walls on all roads (a walls-on test drive sets no author time).
 */
export function editorAuthorText(at: number | null | undefined, shown: boolean, routeOk: boolean, vehicle = '', walls = false): string {
  const who = vehicle ? `${vehicle} author time` : 'Author time';
  if (at) return shown ? ` ${who} ${formatTime(at)}.` : ` ${who} set (secret until you beat it).`;
  return routeOk ? ` ${setAuthorHow(walls)} to set the ${vehicle ? `${vehicle} ` : ''}author time.` : '';
}

/** A read-only tag ("Walls on", "Bike") for headers and the results card; `text` is trusted. */
export const chipHtml = (text: string, title = ''): string => `<span class="chip"${title ? ` title="${title}"` : ''}>${text}</span>`;
