// Author secrecy in the medal lines: the author medal and time are a "?" with ?:??.?? until the
// player's best on that track (that key: vehicle class and wall mode) has beaten the author time.

import { describe, expect, it } from 'vitest';
import { medalTimes } from '../src/game/medals';
import { formatTime } from '../src/game/race';
import { authorLabel, authorRevealed, editorAuthorText, medalTime, SECRET_TIME, setAuthorHow, targetsHtml } from '../src/ui/medalUi';

const m = medalTimes(13900);

describe('authorRevealed', () => {
  it('reveals only once the best is at or under the author time', () => {
    expect(authorRevealed(null, m)).toBe(false);
    expect(authorRevealed(undefined, m)).toBe(false);
    expect(authorRevealed(13910, m)).toBe(false);
    expect(authorRevealed(13900, m)).toBe(true);
    expect(authorRevealed(13000, m)).toBe(true);
    expect(authorRevealed(13000, null)).toBe(false);
  });
});

describe('medalTime', () => {
  it('maps 1..4 to bronze, silver, gold and author', () => {
    expect([1, 2, 3, 4].map((n) => medalTime(m, n))).toEqual([m.bronze, m.silver, m.gold, m.author]);
  });
});

describe('targetsHtml (HUD medal line)', () => {
  it('hides the author time behind a secret medal of the same width', () => {
    const html = targetsHtml(m, false);
    expect(html).toContain(SECRET_TIME);
    expect(html).toContain('medal-secret');
    expect(html).not.toContain(formatTime(m.author));
    for (const t of [m.gold, m.silver, m.bronze]) expect(html).toContain(formatTime(t));
    expect(SECRET_TIME).toHaveLength(formatTime(m.author).length);
  });

  it('shows it once revealed', () => {
    const html = targetsHtml(m, true);
    expect(html).toContain(formatTime(m.author));
    expect(html).not.toContain(SECRET_TIME);
  });

  it('says when there is no author time', () => {
    expect(targetsHtml(null, false)).toContain('No author time yet');
  });
});

describe('authorLabel (campaign cards, My tracks)', () => {
  it('has three states', () => {
    expect(authorLabel(null, true)).toBe('Author --');
    expect(authorLabel(13900, true)).toBe('Author 0:13.90');
    const secret = authorLabel(13900, false);
    expect(secret).toContain(SECRET_TIME);
    expect(secret).not.toContain('0:13.90');
  });
});

describe('editorAuthorText', () => {
  it('covers set and shown, set and secret, none yet, and a route not ready', () => {
    expect(editorAuthorText(13900, true, true)).toBe(' Author time 0:13.90.');
    expect(editorAuthorText(13900, false, true)).toBe(' Author time set (secret until you beat it).');
    expect(editorAuthorText(undefined, false, true)).toBe(' Finish a test drive to set the author time.');
    expect(editorAuthorText(undefined, false, false)).toBe('');
  });

  it('names a vehicle class other than the car', () => {
    expect(editorAuthorText(13900, true, true, 'Bike')).toBe(' Bike author time 0:13.90.');
    expect(editorAuthorText(null, false, true, 'Truck')).toBe(' Finish a test drive to set the Truck author time.');
  });

  it('with Walls on all roads, says to turn them off first (walls-on drives set no author time)', () => {
    expect(editorAuthorText(undefined, false, true, '', true)).toBe(
      ' Turn Walls on all roads off in Settings, then finish a test drive to set the author time.',
    );
    expect(editorAuthorText(13900, true, true, 'Bike', true)).toBe(' Bike author time 0:13.90.');
    expect(editorAuthorText(undefined, false, false, '', true)).toBe('');
    expect(setAuthorHow(false, 'beat it in')).toBe('Beat it in a test drive');
    expect(setAuthorHow(true, 'beat it in')).toBe('Turn Walls on all roads off in Settings, then beat it in a test drive');
  });
});
