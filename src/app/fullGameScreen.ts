// The "Full Game" store screen: what the purchase includes, the price from Google Play, Buy, Restore,
// and a thank-you once it is owned. Opened from Home, Settings and every lock badge; `back` returns to
// where it was opened from (Android Back presses the Back button, as on every screen).

import { CAR_BODIES } from '../core/cars';
import { VEHICLE_MODELS } from '../core/vehicleModels';
import { PREMIUM_VEHICLES, VEHICLE_LABEL } from '../core/vehicles';
import type { BillingStatus, Purchases } from '../platform/purchases';
import { campaign } from '../track/campaign';
import { esc, showScreen, toast } from '../ui/dom';
import type { App } from './app';
import { campaignSets, fullGame, premiumTrackIds, type ThemedTrack } from './fullGame';

/** 'D02-D06' for a run of consecutive ids, else 'D02, D04'. */
export function idRange(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join('');
  const num = (id: string) => Number(id.replace(/^\D+/, ''));
  const prefix = (id: string) => id.replace(/\d+$/, '');
  const run = ids.every((id, i) => i === 0 || (prefix(id) === prefix(ids[0]) && num(id) === num(ids[i - 1]) + 1));
  return run ? `${ids[0]}&ndash;${ids[ids.length - 1]}` : ids.join(', ');
}

/** What the Full Game adds, one line each, from the data (track sets, vehicle classes, models). */
export function includedLines(list: readonly ThemedTrack[]): string[] {
  const premium = premiumTrackIds(list);
  const lines: string[] = [];
  for (const set of campaignSets(list)) {
    const ids = set.indices.map((i) => list[i].id).filter((id) => premium.has(id));
    if (ids.length) lines.push(`<b>${esc(set.label)}</b>: ${ids.length} more track${ids.length === 1 ? '' : 's'} (${idRange(ids)})`);
  }
  const classes = [...PREMIUM_VEHICLES].map((v) => VEHICLE_LABEL[v]);
  if (classes.length) lines.push(`<b>${classes.join(' and ')}</b>: their own handling, records and medals`);
  const models = VEHICLE_MODELS.filter((m) => m.premium).map((m) => esc(m.name));
  if (models.length) lines.push(`<b>Realistic models</b>: ${models.join(', ')}`);
  return lines;
}

/** What stays free (the line under the list). */
export function freeLine(list: readonly ThemedTrack[]): string {
  const premium = premiumTrackIds(list);
  const sets = campaignSets(list);
  const whole = sets.filter((s) => s.indices.every((i) => !premium.has(list[i].id))).map((s) => s.label);
  const firsts = sets
    .filter((s) => s.indices.some((i) => premium.has(list[i].id)))
    .map((s) => list[s.indices.find((i) => !premium.has(list[i].id)) ?? s.indices[0]].id);
  const parts = [
    whole.length ? `the ${whole.join(' and ')} campaign` : '',
    `the Car with its ${CAR_BODIES.length} bodies`,
    'the track editor with My tracks',
    firsts.length ? `the first track of each set (${firsts.join(', ')})` : '',
  ].filter(Boolean);
  return `Always free: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

/** The state the screen shows. */
export interface StoreView {
  unlocked: boolean;
  /** The dev switch (debug builds) is what unlocks it, not a purchase. */
  simulated: boolean;
  status: BillingStatus;
  price: string | null;
  pending: boolean;
  buying: boolean;
  error: string | null;
  /** Just bought in this visit: the bigger thank-you. */
  thanks: boolean;
}

export function storeView(p: Purchases | null, thanks = false): StoreView {
  const fg = fullGame();
  return {
    unlocked: fg.unlocked,
    simulated: fg.devOverride !== null,
    status: p?.status ?? 'unavailable',
    price: p?.price ?? null,
    pending: p?.pending ?? false,
    buying: p?.buying ?? false,
    error: p?.lastError ?? null,
    thanks,
  };
}

export function fullGameHtml(v: StoreView, list: readonly ThemedTrack[]): string {
  const items = `<ul class="fg-list">${includedLines(list)
    .map((l) => `<li>${l}</li>`)
    .join('')}</ul>`;
  let body: string;
  if (v.unlocked) {
    body = `<div class="fg-thanks${v.thanks ? ' big' : ''}" role="status">${
      v.thanks ? 'Thank you! The Full Game is unlocked.' : 'The Full Game is unlocked. Thank you for your support!'
    }${v.simulated ? ' <span class="chip">Dev switch</span>' : ''}</div>
      ${items}
      <div class="row fg-actions"><button class="btn primary center" data-act="campaign">Play campaign</button>
        <button class="btn center" data-act="back">Back</button></div>`;
  } else {
    const ready = v.status === 'ready';
    const buyLabel = v.buying ? 'Opening Google Play&hellip;' : v.price ? `Buy for ${esc(v.price)}` : ready ? 'Buy' : 'Buy';
    let status = '';
    if (v.pending) status = 'Payment pending: the Full Game unlocks as soon as Google Play confirms it.';
    else if (v.error) status = v.error;
    else if (v.status === 'connecting' || v.status === 'off') status = 'Connecting to Google Play&hellip;';
    else if (v.status === 'unavailable') status = "Google Play can't be reached right now.";
    body = `${items}
      <p class="fg-free muted">${freeLine(list)}</p>
      <div class="row fg-actions">
        <button class="btn primary center" data-act="buy" ${ready && !v.buying && !v.pending ? '' : 'disabled'}>${buyLabel}</button>
        <button class="btn center" data-act="restore" ${v.buying ? 'disabled' : ''}>Restore purchases</button>
      </div>
      <p class="fg-status${v.error && !v.pending ? ' warn' : ''}" role="status">${status}</p>
      <p class="fg-note muted">One payment through Google Play, yours on every device with the same Google account. No ads, no subscription.</p>`;
  }
  return `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Full Game</h2></div>
    <div class="panel fg-panel">${body}</div>`;
}

/** The open store screen, so a store event or a purchase can redraw it in place. */
let open: { app: App; back: () => void; thanks: boolean; el: HTMLElement; wasUnlocked: boolean } | null = null;

export function showFullGameScreen(app: App, back: () => void, thanks = false): void {
  const list = campaign();
  const v = storeView(app.purchases, thanks);
  const el = showScreen(fullGameHtml(v, list), 'dim fullgame', {
    back: () => {
      open = null;
      back();
    },
    campaign: () => {
      open = null;
      app.campaignMenu();
    },
    buy: () => void buy(app),
    restore: () => void restore(app),
  });
  open = { app, back, thanks, el, wasUnlocked: v.unlocked };
}

/** Redraw the store screen if it is still the one on show (a price arrived, the purchase went through). */
export function refreshFullGameScreen(): boolean {
  if (!open || !open.el.isConnected) {
    open = null;
    return false;
  }
  const { app, back, thanks, wasUnlocked } = open;
  // Unlocked while on show (bought, restored): the big thank-you.
  showFullGameScreen(app, back, thanks || (fullGame().unlocked && !wasUnlocked));
  return true;
}

/** The store screen is the one on show. */
export const fullGameScreenOpen = (): boolean => !!open && open.el.isConnected;

async function buy(app: App): Promise<void> {
  const p = app.purchases;
  if (!p) return toast('Purchases are not available in this build.', 3000);
  if (p.buying) return;
  const r = await p.buy();
  switch (r.kind) {
    case 'owned':
      if (open) open.thanks = true;
      refreshFullGameScreen();
      break;
    case 'pending':
      toast('Payment pending: the Full Game unlocks when Google Play confirms it.', 4000);
      break;
    case 'processing':
      toast('Google Play is processing the purchase. It unlocks as soon as it is confirmed.', 4000);
      break;
    case 'cancelled':
      break;
    case 'error':
    case 'unavailable':
      toast(r.message, 4000);
      break;
  }
  refreshFullGameScreen();
}

async function restore(app: App): Promise<void> {
  const p = app.purchases;
  if (!p) return toast('Purchases are not available in this build.', 3000);
  toast('Checking Google Play for your purchases…', 2000);
  const r = await p.restore();
  if (r.kind === 'owned') {
    if (open) open.thanks = true;
    toast('Full Game restored. Thank you!', 3000);
  } else if (r.kind === 'none') toast('No Full Game purchase found for this Google account.', 3500);
  else toast(r.message, 4000);
  refreshFullGameScreen();
}
