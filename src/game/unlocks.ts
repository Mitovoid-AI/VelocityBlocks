// Which campaign tracks are open. A track opens when the one before it has been finished (under
// any physics version, with any vehicle class, in either wall mode), or when it was unlocked with a
// rewarded ad in a browser build. Store.hasFinished is the predicate: it matches a track by its base key
// (core/vehicles entryBase), so a finish under any class revision counts too.

export interface CampaignLock {
  locked: boolean;
  /** The first locked track: a rewarded ad may open it. */
  unlockable: boolean;
}

export function campaignLocks(
  keys: readonly string[],
  finished: (key: string) => boolean,
  adUnlocked: (key: string) => boolean,
): CampaignLock[] {
  let prevFinished = true;
  let offered = false;
  return keys.map((key) => {
    const locked = !prevFinished && !adUnlocked(key);
    const unlockable = locked && !offered;
    if (unlockable) offered = true;
    prevFinished = finished(key);
    return { locked, unlockable };
  });
}

