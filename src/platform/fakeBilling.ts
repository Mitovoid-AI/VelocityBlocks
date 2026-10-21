// A stand-in for cordova-plugin-purchase in `npm run dev` with ?iap=free or ?iap=owned (app/fullGame.ts
// devSimulation), so the Full Game screen, the locks and the purchase flow can be tried in a browser.
// Never part of a production bundle: it is only imported behind import.meta.env.DEV.

import { FULL_GAME_ID, type CdvError, type CdvNamespace, type CdvProduct, type CdvTransaction } from './purchases';

const CANCELLED = 6777006;

export function fakeCdvPurchase(startOwned: boolean, price = '$2.99'): CdvNamespace {
  let own = startOwned;
  const cbs = {
    productUpdated: [] as ((p: CdvProduct) => void)[],
    approved: [] as ((t: CdvTransaction) => void)[],
    pending: [] as ((t: CdvTransaction) => void)[],
    finished: [] as ((t: CdvTransaction) => void)[],
    receiptsReady: [] as (() => void)[],
    ready: [] as (() => void)[],
  };
  const tx = (): CdvTransaction => ({
    state: 'approved',
    products: [{ id: FULL_GAME_ID }],
    finish: () => {
      cbs.finished.forEach((f) => f({ state: 'finished', products: [{ id: FULL_GAME_ID }], finish() {} }));
    },
  });
  const product: CdvProduct = {
    id: FULL_GAME_ID,
    get owned() {
      return own;
    },
    pricing: { price },
    getOffer: () => ({
      order: async (): Promise<CdvError | undefined> => {
        await new Promise((r) => setTimeout(r, 300));
        if (!confirm(`[Fake Google Play] Buy the Full Game for ${price}?\nOK: pay   Cancel: cancel`)) {
          return { code: CANCELLED, message: 'Cancelled by the user' };
        }
        own = true;
        cbs.approved.forEach((f) => f(tx()));
        return undefined;
      },
    }),
  };
  const when = {
    productUpdated: (cb: (p: CdvProduct) => void) => (cbs.productUpdated.push(cb), when),
    approved: (cb: (t: CdvTransaction) => void) => (cbs.approved.push(cb), when),
    pending: (cb: (t: CdvTransaction) => void) => (cbs.pending.push(cb), when),
    finished: (cb: (t: CdvTransaction) => void) => (cbs.finished.push(cb), when),
    receiptsReady: (cb: () => void) => (cbs.receiptsReady.push(cb), when),
  };
  return {
    ProductType: { NON_CONSUMABLE: 'non consumable' },
    Platform: { GOOGLE_PLAY: 'android-playstore' },
    ErrorCode: { PAYMENT_CANCELLED: CANCELLED },
    store: {
      verbosity: 0,
      register() {},
      initialize: async () => {
        await new Promise((r) => setTimeout(r, 600));
        cbs.productUpdated.forEach((f) => f(product));
        cbs.receiptsReady.forEach((f) => f());
        cbs.ready.forEach((f) => f());
        return [];
      },
      when: () => when,
      ready: (cb) => void cbs.ready.push(cb),
      error() {},
      get: () => product,
      owned: () => own,
      update: async () => {},
      restorePurchases: async () => undefined,
    },
  };
}
