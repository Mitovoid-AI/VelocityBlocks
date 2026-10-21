// Google Play billing for the Full Game, through cordova-plugin-purchase (CdvPurchase v13), which runs in
// the Capacitor app as a Cordova plugin (`npx cap sync` installs its native part and the BILLING
// permission). A thin wrapper: one non-consumable product, its price, the purchase flow, acknowledging
// purchases, Restore, and a re-check of ownership on every start.
//
// It never throws and never blocks the game: without the plugin (web builds), without Google Play
// (no Play Store, offline, a blocked store) it reports 'unavailable' and the local copy of the
// entitlement (app/fullGame.ts) stands. There is no receipt server: Google Play's own purchase list on the
// device is the record, which suits an offline single-player game.

/** The Google Play product id: a one-time "managed product" (non-consumable) in the Play Console. */
export const FULL_GAME_ID = 'full_game';
const FULL_GAME = FULL_GAME_ID;

/** The part of the CdvPurchase API used here (www/store.d.ts in the plugin), so tests can stand in for it. */
export interface CdvError {
  isError?: boolean;
  code: number;
  message: string;
}
export interface CdvOffer {
  order(): Promise<CdvError | undefined>;
}
export interface CdvProduct {
  id: string;
  owned: boolean;
  pricing?: { price: string };
  getOffer(id?: string): CdvOffer | undefined;
}
export interface CdvTransaction {
  state: string;
  products: { id: string }[];
  isPending?: boolean;
  finish(): Promise<unknown> | unknown;
}
export interface CdvWhen {
  productUpdated(cb: (p: CdvProduct) => void): CdvWhen;
  approved(cb: (t: CdvTransaction) => void): CdvWhen;
  pending(cb: (t: CdvTransaction) => void): CdvWhen;
  finished(cb: (t: CdvTransaction) => void): CdvWhen;
  receiptsReady(cb: () => void): CdvWhen;
}
export interface CdvStore {
  verbosity: number;
  register(p: { id: string; type: string; platform: string }): void;
  initialize(platforms: string[]): Promise<CdvError[]>;
  when(): CdvWhen;
  ready(cb: () => void): void;
  error(cb: (e: CdvError) => void): void;
  get(id: string, platform?: string): CdvProduct | undefined;
  owned(p: { id: string; platform?: string }): boolean;
  update(): Promise<unknown>;
  restorePurchases(): Promise<CdvError | undefined>;
}
export interface CdvNamespace {
  store: CdvStore;
  ProductType: { NON_CONSUMABLE: string };
  Platform: { GOOGLE_PLAY: string };
  ErrorCode: { PAYMENT_CANCELLED: number; STORE_BLOCKED?: number; PAYMENT_NOT_ALLOWED?: number };
  LogLevel?: { WARNING: number };
}

/** off: not started; connecting: waiting for the plugin or Google Play; ready: the product can be bought. */
export type BillingStatus = 'off' | 'connecting' | 'ready' | 'unavailable';

export type BuyOutcome =
  | { kind: 'owned' }
  | { kind: 'pending' } // Google Play is waiting for the payment (cash, bank transfer): unlocks when it clears
  | { kind: 'processing' } // the flow ended without a verdict yet: it unlocks when Google Play reports it
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string };

export type RestoreOutcome = { kind: 'owned' } | { kind: 'none' } | { kind: 'unavailable'; message: string } | { kind: 'error'; message: string };

export interface PurchaseEvents {
  /** Google Play reports the Full Game as owned (a purchase now, a Restore, or the check at start). */
  owned(): void;
  /** Google Play's purchase list loaded and does not have it (refunded or never bought). */
  notOwned(): void;
  /** The status, the price, a pending payment or the last error changed: redraw the store screen. */
  changed(): void;
}

/** How long init waits for the plugin's JavaScript (Cordova's deviceready) before giving up. */
export const PLUGIN_WAIT_MS = 10_000;
/** After the purchase sheet closes, how long buy() waits for Google Play's verdict before 'processing'. */
export const VERDICT_WAIT_MS = 8_000;

export const MSG_OFFLINE = "Google Play can't be reached right now. Check the connection and try again.";
export const MSG_NO_PLUGIN = 'Purchases are not available in this version of the app.';
export const MSG_NOT_LISTED = 'The Full Game is not available in the store yet. Try again later.';
export const MSG_BLOCKED = 'Purchases are blocked on this device (parental controls, a kids mode or a work profile).';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cordova's deviceready (Capacitor fires it once its Cordova layer is up). Cordova replays it to late
 * listeners; without Cordova (tests, a browser) or after `ms` it resolves anyway.
 */
function deviceReady(ms: number): Promise<void> {
  const g = globalThis as { cordova?: unknown; document?: Document };
  if (!g.cordova || !g.document) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    g.document!.addEventListener(
      'deviceready',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** The plugin's global, once Cordova has loaded it (it clobbers window.CdvPurchase). */
export function findCdvPurchase(): CdvNamespace | undefined {
  const ns = (globalThis as { CdvPurchase?: CdvNamespace }).CdvPurchase;
  return ns && typeof ns.store?.register === 'function' ? ns : undefined;
}

export class Purchases {
  status: BillingStatus = 'off';
  /** The localized price from Google Play ('€2.99'), once the product has loaded. */
  price: string | null = null;
  /** A purchase is waiting for its payment to clear. */
  pending = false;
  /** A purchase sheet is open (buy() is running). */
  buying = false;
  /** What went wrong last, for the store screen (cleared when things recover). */
  lastError: string | null = null;

  private ns: CdvNamespace | null = null;
  private started: Promise<void> | null = null;
  private receiptsLoaded = false;
  private ownedSeen = false;
  /** "Not owned" was reported for this check (reported once; Restore asks again). */
  private notOwnedSent = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly events: Partial<PurchaseEvents> = {},
    private readonly find: () => CdvNamespace | undefined = findCdvPurchase,
    private readonly pluginWaitMs = PLUGIN_WAIT_MS,
    private readonly verdictWaitMs = VERDICT_WAIT_MS,
  ) {}

  /** Start billing (once; later calls return the same promise). Never rejects. */
  init(): Promise<void> {
    return (this.started ??= this.start().catch((e) => {
      console.warn('[iap] init failed', e);
      this.fail(MSG_OFFLINE);
    }));
  }

  private async start(): Promise<void> {
    this.status = 'connecting';
    this.changed();
    const ns = await this.waitForPlugin();
    if (!ns) return this.fail(MSG_NO_PLUGIN);
    // Native calls go through Cordova's bridge, which is up at deviceready.
    await deviceReady(this.pluginWaitMs);
    this.ns = ns;
    const { store, ProductType, Platform } = ns;
    try {
      store.verbosity = ns.LogLevel?.WARNING ?? 2;
    } catch {
      /* read-only in some versions */
    }
    store.register({ id: FULL_GAME, type: ProductType.NON_CONSUMABLE, platform: Platform.GOOGLE_PLAY });
    store
      .when()
      .productUpdated((p) => {
        if (p.id !== FULL_GAME) return;
        this.price = p.pricing?.price ?? this.price;
        this.reconcile();
        this.changed();
      })
      .approved((t) => {
        if (!this.ours(t)) return;
        // Paid. Acknowledge it (finish), or Google Play refunds it after 3 days; it counts as owned now.
        this.pending = false;
        this.grant();
        Promise.resolve()
          .then(() => t.finish())
          .catch((e) => console.warn('[iap] acknowledge failed; retried on the next start', e));
      })
      .pending((t) => {
        if (!this.ours(t)) return;
        this.pending = true;
        this.wake();
        this.changed();
      })
      .finished((t) => {
        if (!this.ours(t)) return;
        this.pending = false;
        this.grant();
      })
      .receiptsReady(() => {
        this.receiptsLoaded = true;
        this.reconcile();
      });
    store.error((e) => {
      // Cancelling the purchase sheet comes back from order() too; it is not an error to show.
      if (e.code === ns.ErrorCode.PAYMENT_CANCELLED) return;
      console.warn('[iap]', e.code, e.message);
      this.lastError = this.describe(e);
      if (ns.ErrorCode.STORE_BLOCKED !== undefined && e.code === ns.ErrorCode.STORE_BLOCKED) this.status = 'unavailable';
      this.changed();
    });
    store.ready(() => {
      this.status = 'ready';
      this.lastError = null;
      this.reconcile();
      this.changed();
    });
    let errors: CdvError[] = [];
    try {
      errors = (await store.initialize([Platform.GOOGLE_PLAY])) ?? [];
    } catch (e) {
      errors = [{ code: 0, message: String(e) }];
    }
    // The plugin retries a failed setup by itself (offline at start): ready() flips the status later.
    // (A cast: TS narrowed status to 'connecting' above, but ready() may have run during the await.)
    if (errors.length && (this.status as BillingStatus) !== 'ready') {
      const blocked = errors.find((e) => ns.ErrorCode.STORE_BLOCKED !== undefined && e.code === ns.ErrorCode.STORE_BLOCKED);
      this.fail(blocked ? MSG_BLOCKED : this.describe(errors[0]));
    }
  }

  /** Cordova loads plugin scripts after the page: wait for window.CdvPurchase (or give up). */
  private async waitForPlugin(): Promise<CdvNamespace | undefined> {
    const t0 = Date.now();
    for (;;) {
      const ns = this.find();
      if (ns) return ns;
      if (Date.now() - t0 >= this.pluginWaitMs) return undefined;
      await sleep(100);
    }
  }

  private ours(t: CdvTransaction): boolean {
    return Array.isArray(t?.products) && t.products.some((p) => p.id === FULL_GAME);
  }

  private product(): CdvProduct | undefined {
    try {
      return this.ns?.store.get(FULL_GAME, this.ns.Platform.GOOGLE_PLAY);
    } catch {
      return undefined;
    }
  }

  private isOwned(): boolean {
    try {
      const ns = this.ns;
      return !!ns && ns.store.owned({ id: FULL_GAME, platform: ns.Platform.GOOGLE_PLAY });
    } catch {
      return false;
    }
  }

  /**
   * After Google Play's purchase list has loaded and the product is known: owned, or not (a refund takes it
   * away). Nothing is decided while either is missing (offline, product not set up): the local copy stands.
   */
  private reconcile(): void {
    if (this.isOwned()) return this.grant();
    if (!this.receiptsLoaded || !this.product() || this.pending || this.ownedSeen || this.notOwnedSent) return;
    this.notOwnedSent = true;
    this.events.notOwned?.();
  }

  private grant(): void {
    this.ownedSeen = true;
    this.pending = false;
    this.lastError = null;
    this.events.owned?.();
    this.wake();
    this.changed();
  }

  private fail(message: string): void {
    this.status = 'unavailable';
    this.lastError = message;
    this.changed();
  }

  private changed(): void {
    try {
      this.events.changed?.();
    } catch (e) {
      console.error('[iap] changed listener failed', e);
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private describe(e: CdvError): string {
    const codes = this.ns?.ErrorCode;
    if (codes?.STORE_BLOCKED !== undefined && e.code === codes.STORE_BLOCKED) return MSG_BLOCKED;
    if (codes?.PAYMENT_NOT_ALLOWED !== undefined && e.code === codes.PAYMENT_NOT_ALLOWED)
      return 'Google Play is not ready for purchases yet. Try again in a moment.';
    const m = (e.message || '').toLowerCase();
    if (/network|offline|unavailable|service|disconnect|timeout|setup/.test(m)) return MSG_OFFLINE;
    if (/not found|invalid product/.test(m)) return MSG_NOT_LISTED;
    return `The purchase did not go through (${e.message || 'unknown error'}).`;
  }

  /** Open Google Play's purchase sheet for the Full Game. Never rejects. */
  async buy(): Promise<BuyOutcome> {
    if (this.buying) return { kind: 'processing' };
    await this.init();
    if (this.isOwned()) {
      this.grant();
      return { kind: 'owned' };
    }
    if (this.pending) return { kind: 'pending' };
    const product = this.product();
    if (this.status !== 'ready' || !product) {
      this.retry();
      return { kind: 'unavailable', message: this.status === 'ready' ? MSG_NOT_LISTED : (this.lastError ?? MSG_OFFLINE) };
    }
    const offer = product.getOffer();
    if (!offer) return { kind: 'unavailable', message: MSG_NOT_LISTED };
    this.buying = true;
    this.changed();
    try {
      let err: CdvError | undefined;
      try {
        err = await offer.order();
      } catch (e) {
        err = { code: 0, message: String(e) };
      }
      if (err) {
        if (err.code === this.ns!.ErrorCode.PAYMENT_CANCELLED) return { kind: 'cancelled' };
        if (this.isOwned()) {
          // "Item already owned": Play knows better than the local list.
          this.grant();
          return { kind: 'owned' };
        }
        const message = this.describe(err);
        this.lastError = message;
        return { kind: 'error', message };
      }
      // The sheet closed with a purchase: approved or pending follows from the plugin's listeners.
      await this.waitFor(() => this.ownedSeen || this.pending, this.verdictWaitMs);
      if (this.ownedSeen || this.isOwned()) return { kind: 'owned' };
      if (this.pending) return { kind: 'pending' };
      return { kind: 'processing' };
    } finally {
      this.buying = false;
      this.changed();
    }
  }

  /** Ask Google Play for this account's purchases again. Never rejects. */
  async restore(): Promise<RestoreOutcome> {
    await this.init();
    const ns = this.ns;
    if (!ns || this.status === 'unavailable') {
      this.retry();
      return { kind: 'unavailable', message: this.lastError ?? MSG_OFFLINE };
    }
    let err: CdvError | undefined;
    try {
      err = await ns.store.restorePurchases();
    } catch (e) {
      err = { code: 0, message: String(e) };
    }
    if (this.isOwned()) {
      this.grant();
      return { kind: 'owned' };
    }
    if (err) {
      const message = this.describe(err);
      this.lastError = message;
      this.changed();
      return { kind: 'error', message };
    }
    // Restore found nothing: the same as a check at start (it may take a refund away).
    this.receiptsLoaded = true;
    this.notOwnedSent = false;
    this.reconcile();
    return { kind: 'none' };
  }

  /** Offline at start, back online now: let the plugin try again (it also retries by itself). */
  retry(): void {
    try {
      void this.ns?.store.update().catch(() => {});
    } catch {
      /* not started */
    }
  }

  private waitFor(done: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (done()) return resolve();
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(check);
    });
  }
}
