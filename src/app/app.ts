// Application shell: render loop, mode switching and the menu screens.

import { Ads } from '../ads/ads';
import { BannerSlot, blockForAd } from '../ads/adsUi';
import { GameAudio } from '../audio/audio';
import { DT } from '../core/constants';
import { entryKey, VEHICLE_CLASSES, VEHICLE_LABEL, type VehicleClass } from '../core/vehicles';
import { Autopilot } from '../game/bot';
import { campaignAuthorTime, medalFor, medalTimes } from '../game/medals';
import { formatTime, RaceSession } from '../game/race';
import { layoutHash, Store, STEER_MODES, type SavedTrack, type Settings, type SteerMode } from '../game/storage';
import { campaignLocks } from '../game/unlocks';
import { edgeExclusionRects, gestureInsetVars, type GestureInsets } from '../input/edgeGuard';
import { Input, isTouchDevice, type Action, type ActionSource } from '../input/input';
import { TouchControls } from '../input/touchControls';
import { STEER_LABEL } from '../input/touchModel';
import { TouchWatch } from '../input/touchWatch';
import { deviceInfo, installSource, keepAwake, setGestureExclusion, watchGestureInsets, watchRunLinks, type DeviceInfo } from '../platform/native';
import { driveRun, parseRun, runTrackData } from '../game/runShare';
import { findCdvPurchase, Purchases, type CdvNamespace } from '../platform/purchases';
import { runtimeChannel, UpdateChecker, type UpdateInfo } from '../platform/updates';
import { CameraRig } from '../render/cameraRig';
import { CarView, type CarViewOptions, type PoseSnapshot } from '../render/carView';
import { ensureModel, loadModel, readyModel, setModelRenderer } from '../render/modelCache';
import { autoStartTier, FrameGovernor, isQuality, tierCmp } from '../render/autoQuality';
import type { Quality } from '../render/quality';
import { World } from '../render/world';
import { campaign } from '../track/campaign';
import { exportTrack, importTrack } from '../track/format';
import { Track, type TrackData } from '../track/track';
import { traceRoute } from '../track/route';
import { $, downloadText, esc, pickTextFile, popupOpen, showScreen, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { authorLabel, authorRevealed, chipHtml, medalDot } from '../ui/medalUi';
import { CC_BY_URL, creditsHtml } from '../ui/credits';
import { bindSlider, sliderHtml } from '../ui/slider';
import { customAuthorTime } from './authorTime';
import {
  APP_VERSION,
  campaignSets,
  devSimulation,
  effectiveModel,
  effectiveVehicle,
  entryLock,
  fullGame,
  isSideloadInstall,
  premiumTrackIds,
  trackTheme,
  vehicleLocked,
} from './fullGame';
import { fullGameScreenOpen, refreshFullGameScreen, showFullGameScreen } from './fullGameScreen';
import { EditorMode } from './editorMode';
import { isLongFrame, liftInside, type FocusDetail } from './pauseGuard';
import { homeCardHtml, showProfileScreen, type ProfileMode } from './profileScreen';
import { RaceMode, type RaceEntry } from './raceMode';
import { ReplayMode } from './replayMode';
import { showTiltScreen } from './tiltScreen';
import { bindTiltControls, recentreSaved, tiltGaugeHtml, tiltSliderHtml, tiltValHtml } from './tiltUi';
import { showUpdatePopup } from './updateUi';

/**
 * Built only inside the factory passed to App.setMode, after the previous mode has exited.
 * Constructors may set up the scene, HUD and touch controls. App.mode is null while the
 * previous mode exits and while the factory runs, so never read it there. A factory must not
 * call setMode or startRace.
 */
export interface Mode {
  update(dt: number): void;
  /** Right after a frame is drawn, while the canvas still holds it (a replay copies it into its video). */
  afterRender?(): void;
  exit(): void;
  onAction?(a: Action, src?: ActionSource): void;
}

/** What profileScreen (and the Campaign's vehicle switch) report through App.profileChanged. */
export type ProfileChange = 'color' | 'body' | 'model' | 'photo' | 'name' | 'badge' | 'vehicle';

/** The "Walls on" chip on Campaign, My tracks and the results: the setting lives in Settings. */
const WALLS_CHIP = (): string => chipHtml('Walls on', 'Settings: Walls on all roads. Times with walls are kept separately.');
/** My tracks, with walls on: a track whose road is not joined from Start to a Finish. */
export const WALLS_ROUTE_NOTE = 'Road not joined end to end: it may not be finishable with walls on';

/** traceRoute(...).complete per block layout (layoutHash): My tracks redraws often, and a Track build is not cheap. */
const routeOk = new Map<string, boolean>();

/** True when a track's road is joined from Start to a Finish (memoised per layout). */
export function routeComplete(data: TrackData): boolean {
  const k = layoutHash(data);
  let ok = routeOk.get(k);
  if (ok === undefined) {
    ok = traceRoute(new Track(data)).complete;
    routeOk.set(k, ok);
  }
  return ok;
}

/**
 * Buttons, not a drop-down, so a second-finger tap (pointerup routing in showScreen) works. A class that
 * needs the Full Game carries a lock and opens the Full Game screen.
 */
export function vehicleSegHtml(cur: VehicleClass, unlocked = fullGame().unlocked): string {
  return `<div class="seg veh-seg" role="group" aria-label="Vehicle">${VEHICLE_CLASSES.map((v) => {
    const lock = vehicleLocked(v, unlocked);
    return `<button class="btn small ${v === cur ? 'sel' : ''}${lock ? ' locked' : ''}" data-act="veh" data-v="${v}" aria-pressed="${v === cur}"${
      lock ? ' title="Full Game"' : ''
    }>${lock ? '<span class="lock" aria-label="Locked: Full Game">&#128274;</span>' : ''}${VEHICLE_LABEL[v]}</button>`;
  }).join('')}</div>`;
}

/** Campaign > the Stadium / Desert / Water switch (shown once there is more than one set). */
function setSegHtml(sets: readonly { theme: string; label: string }[], cur: string): string {
  return `<div class="seg set-seg" role="group" aria-label="Track set">${sets
    .map((s) => `<button class="btn small ${s.theme === cur ? 'sel' : ''}" data-act="set" data-v="${esc(s.theme)}" aria-pressed="${s.theme === cur}">${esc(s.label)}</button>`)
    .join('')}</div>`;
}

/** Settings > tap the version this many times (debug Android builds) for the Full Game dev switch. */
export const DEV_TAPS = 7;

/** The one-time toast on the first race on a touchscreen after the controls update. */
export const CONTROLS_TIP = 'New: steering wheel, tilt and pedal bars - change them in the pause menu';

/** How long a race start waits for a realistic model to load before the classic vehicle stands in (ms). */
export const MODEL_WAIT_MS = 6000;

/** The screen on show (#screens holds one): a race start checks it did not change while it waited. */
const currentScreen = (): Element | null => document.querySelector('#screens > .screen');

/** ?fps in the URL: World's overlay also shows the governor's state. */
const FPS_OVERLAY = typeof location !== 'undefined' && location.search.includes('fps');

const QUALITY_LABEL: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * Settings > Graphics quality picked (`value`: 'auto' or a tier). Auto starts over: from the platform's
 * default tier with what it learnt forgotten (a battery saver or a hot phone may have marked tiers failed
 * that this device runs fine now). A tier is the player's choice; what Auto learnt is kept for later.
 */
export function chooseQuality(s: Pick<Settings, 'quality' | 'qualityAuto' | 'qualityFailed'>, value: string, touch: boolean): void {
  if (value === 'auto') {
    s.qualityAuto = true;
    s.qualityFailed = null;
    s.quality = autoStartTier(touch, null);
  } else if (isQuality(value)) {
    s.qualityAuto = false;
    s.quality = value;
  }
}

/** Settings > Graphics quality's options: Auto names the tier it is on now. */
export function qualityOptionsHtml(choice: Quality | 'auto', current: Quality): string {
  const opt = (v: string, label: string) => `<option value="${v}" ${v === choice ? 'selected' : ''}>${label}</option>`;
  return [
    opt('auto', `Auto (currently: ${QUALITY_LABEL[current]})`),
    opt('low', 'Low (fastest)'),
    opt('medium', 'Medium'),
    opt('high', 'High'),
  ].join('');
}

/**
 * Which frames are drawn while a mode thins them out (RaceMode.renderEvery: paused, results): every
 * `every`-th, and always the first one after a canvas resize (World.dirty), which cleared the canvas. A
 * resize (a rotation, the governor's pixel ratio, an Auto tier change) on a skipped frame would otherwise
 * leave the screen black until the next drawn one.
 */
export class FrameSkip {
  /** Frames not drawn since the last one. */
  private skipped = 0;

  due(every: number, dirty: boolean): boolean {
    if (every <= 1 || dirty || ++this.skipped >= every) {
      this.skipped = 0;
      return true;
    }
    return false;
  }
}

/** The Settings volume slider. */
const VOLUME = { min: 0, max: 1, step: 0.05 } as const;
const volumeText = (v: number): string => `${Math.round(v * 100)}%`;

export class App {
  readonly world: World;
  readonly rig: CameraRig;
  readonly input = new Input();
  readonly audio = new GameAudio();
  readonly store = new Store();
  readonly hud = new Hud();
  /** Touches Android takes away mid-race (back swipes): RaceMode.back reads them. */
  readonly touches = new TouchWatch(() => this.mode instanceof RaceMode && this.mode.isRacing);
  /** The phone and its nav mode (Android app only), for the pause screen's diagnostics line. */
  device: DeviceInfo | null = null;
  /** System gesture strips the Android app reported; the touch controls keep out of them. */
  gestureInsets: GestureInsets | null = null;
  /** Frames over budget while racing, counted for the pause screen's diagnostics line. */
  longFrames = 0;
  private mode: Mode | null = null;
  private last = 0;
  private editor: EditorMode | null = null;
  /** An ad is on screen: the loop stops updating and rendering. */
  private adPlaying = false;
  /** The on-screen steering and pedals (the pills are bound in bindPills). */
  private readonly touchCtl: TouchControls;
  /**
   * The race start waiting (for an ad or a model), by the screen and mode it was made from: further taps
   * there do not start another. Once the player has left that screen (Back) it is stale, gives way to a
   * start from the new screen, and ends without a race or a toast.
   */
  private pendingStart: { screen: Element | null; mode: Mode | null } | null = null;
  /** The latest steering pick (setSteerMode): a tilt check that finds a newer one has been overtaken. */
  private steerPick: object | null = null;
  /** Frame-rate governor: the pixel ratio within the tier, and with Auto quality the tier (render/autoQuality.ts). */
  readonly governor: FrameGovernor;
  /** JS time of the previous frame (update + render calls), ms, for the governor. */
  private lastWork = 0;
  /** Which frames are drawn while the mode thins them out (RaceMode.renderEvery). */
  private readonly frameSkip = new FrameSkip();
  /** Google Play billing for the Full Game (Android builds; null elsewhere and until start()). */
  purchases: Purchases | null = null;
  /** Campaign > the set (theme) on show; a campaign race opens its own set. */
  private campaignSet: string | null = null;
  /** Settings > taps on the version line, for the debug builds' dev switch. */
  private versionTaps = 0;
  /** GitHub release check: APK installs on Android only (never Google Play installs, web or portal builds). */
  readonly updates = new UpdateChecker({ channel: runtimeChannel });
  /** An update the automatic check found while the home page was not on show: offered on the next one. */
  private pendingUpdate: UpdateInfo | null = null;

  constructor(readonly ads: Ads = new Ads()) {
    const canvas = $<HTMLCanvasElement>('#view');
    this.world = new World(canvas);
    this.rig = new CameraRig(this.world.camera);
    const s0 = this.store.settings;
    this.world.setQuality(s0.quality);
    this.governor = new FrameGovernor({
      tier: s0.quality,
      auto: s0.qualityAuto,
      failed: s0.qualityFailed,
      deviceDpr: window.devicePixelRatio || 1,
    });
    this.world.setRenderScale(this.governor.pixelRatio);
    setModelRenderer(this.world.renderer);
    // Before applySettings, which lays the controls out. A race toast sits clear of the 3-2-1.
    this.touchCtl = new TouchControls($('#touch'), this.input, (msg) => toast(msg, 3000), () => this.syncEdgeGuard());
    this.applySettings();
    if (isTouchDevice()) document.body.classList.add('touch');

    window.addEventListener('resize', () => {
      if (this.governor.setDeviceDpr(window.devicePixelRatio || 1)) this.world.setRenderScale(this.governor.pixelRatio);
      this.world.resize();
      this.syncEdgeGuard();
    });
    // A 180-degree flip keeps the window size (no resize) but can move the safe area and the
    // gesture strips to the other side.
    window.addEventListener('orientationchange', () =>
      setTimeout(() => {
        this.world.resize();
        this.syncEdgeGuard();
      }, 200),
    );
    const autoPause = (reason: 'focus' | 'hidden', d?: FocusDetail) => {
      if (this.mode instanceof RaceMode) this.mode.setPaused(true, reason, d);
    };
    document.addEventListener('visibilitychange', () => {
      // The first frame back would otherwise count the whole time away as one long frame.
      this.last = 0;
      if (document.hidden) {
        autoPause('hidden');
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });
    // Sent by MainActivity when the window has lost focus for 500 ms without the page being
    // hidden: notification shade, assistant overlay, a dialog or another app over the game.
    window.addEventListener('vb-focuslost', (e) => autoPause('focus', (e as CustomEvent<FocusDetail | undefined>).detail));
    (window as unknown as { vbBack: () => boolean }).vbBack = () => this.back();
    // Audio needs a user gesture to start (mobile browsers, WebViews).
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    void deviceInfo().then((d) => (this.device = d));
    watchGestureInsets((g) => this.applyGestureInsets(g));

    this.input.onAction((a, src) => this.mode?.onAction?.(a, src));
    this.bindPills();
    this.bindAds();

    requestAnimationFrame((t) => this.loop(t));
  }

  private loop(t: number): void {
    const gap = this.last ? t - this.last : 0;
    // Hitches are counted so the pause screen can tell a stutter from a real pause. Not during the
    // countdown: the track load and shader warm-up land there and are not stutters.
    if (isLongFrame(gap) && !this.adPlaying && this.mode instanceof RaceMode && this.mode.isDriving) this.longFrames++;
    const dt = this.last ? Math.min(0.1, gap / 1000) : 1 / 60;
    this.last = t;
    // Nothing moves or renders under an ad; dt is capped, so the game picks up smoothly after.
    if (!this.adPlaying) {
      const t0 = performance.now();
      this.govern(gap);
      this.mode?.update(dt);
      this.world.update(dt);
      const every = this.mode instanceof RaceMode ? this.mode.renderEvery : 1;
      if (this.frameSkip.due(every, this.world.dirty)) {
        this.world.render();
        this.mode?.afterRender?.();
      }
      this.lastWork = performance.now() - t0;
    }
    const racing = this.mode instanceof RaceMode && this.mode.isRacing;
    this.ads.gameplay(racing && !this.adPlaying);
    keepAwake(racing || this.mode instanceof ReplayMode);
    requestAnimationFrame((tt) => this.loop(tt));
  }

  /**
   * The frame-rate governor, before the frame: a new pixel ratio applies at once (a canvas resize); a
   * tier change from Auto waits for a quiet moment (RaceMode.quiet, or any other mode but a replay).
   */
  private govern(gap: number): void {
    const m = this.mode;
    const driving = m instanceof RaceMode && m.isDriving && !document.hidden;
    const g = this.governor;
    if (g.frame(gap, this.lastWork, driving)) {
      this.world.setRenderScale(g.pixelRatio);
      console.info('[vb] pixel ratio', g.pixelRatio.toFixed(2), `(${g.lastStats.fps.toFixed(0)} fps)`);
    }
    if (g.pendingTier && (m instanceof RaceMode ? m.quiet : !(m instanceof ReplayMode))) this.applyAutoTier(g.pendingTier);
    // A tier step that gained nothing is not failed after all (the governor took the mark back).
    const s = this.store.settings;
    if (g.auto && !g.pendingTier && g.failed !== s.qualityFailed) {
      s.qualityFailed = g.failed;
      this.store.saveSettings();
    }
    if (FPS_OVERLAY) {
      const st = g.lastStats;
      this.world.fpsNote = `${g.auto ? 'auto' : 'fixed'} L${g.dprLevel} ${g.last} ${st.fps.toFixed(0)}fps w${st.workMs.toFixed(1)}ms${g.pendingTier ? ` -> ${g.pendingTier}` : ''}`;
    }
  }

  /** Auto quality moves to another tier (at a quiet moment) and remembers it for this device. */
  private applyAutoTier(q: Quality): void {
    const s = this.store.settings;
    const down = tierCmp(q, s.quality) < 0;
    console.info('[vb] auto quality', s.quality, '->', q, `(${this.governor.lastStats.fps.toFixed(0)} fps)`);
    s.quality = q;
    s.qualityFailed = this.governor.failed;
    this.store.saveSettings();
    this.setQuality(q, true);
    if (down) toast(`Graphics: Auto switched to ${QUALITY_LABEL[q]} for a smoother frame rate`, 2600);
  }

  /** Apply a graphics tier (Settings, or Auto): the world, then the governor's pixel ratio for it. */
  private setQuality(q: Quality, auto: boolean): void {
    this.world.setQuality(q);
    this.governor.setTier(q, auto);
    this.world.setRenderScale(this.governor.pixelRatio);
    // The tier change rebuilt the stadium (and on Low the road): compile before the next frame.
    this.world.requestWarm();
  }

  /**
   * Android Back (from MainActivity): pause or resume a race (or ignore a back swipe made over the
   * controls, see RaceMode.back), otherwise press the screen's own way out. Returns false on the
   * main menu so the app goes to the background.
   */
  back(): boolean {
    try {
      if (this.mode instanceof RaceMode && this.mode.back(this.touches.recent(), performance.now())) return true;
      // A pop-up over a menu (the update offer) closes before the screen under it is left.
      const popBack = document.querySelector<HTMLElement>('#screens > .popup [data-act="back"]');
      if (popBack) {
        popBack.click();
        return true;
      }
      const exit = document.querySelector<HTMLElement>(
        '#screens [data-act="back"], #screens [data-act="exit"], #screens [data-act="menu"]',
      );
      if (!exit) return false;
      exit.click();
      return true;
    } catch (e) {
      // MainActivity sends the app to the background unless this returns true: a bug here must
      // not look like the race pausing by itself.
      console.error('Back failed', e);
      return this.mode instanceof RaceMode;
    }
  }

  /**
   * Switch modes. The current mode exits BEFORE the next one is built: constructors set up the
   * track, HUD and touch controls, and an exit() run after them would undo it (RaceMode.exit
   * hides both, which is how "Next track" used to start with no HUD or controls). Always build
   * the mode inside `make`; never pass `() => alreadyBuiltMode`.
   */
  setMode(make: () => Mode): void {
    const old = this.mode;
    this.mode = null; // nothing is routed to a mode that is half torn down or half built
    try {
      old?.exit();
    } catch (e) {
      console.error('Mode exit failed', e); // still switch, or the app is left with no mode
    }
    this.mode = make();
  }

  /** The menu car behind every menu, home, setup and garage screen; a running one is kept. */
  ensureAttract(): void {
    if (!(this.mode instanceof AttractMode)) this.setMode(() => new AttractMode(this));
  }

  /**
   * The player's vehicle as the profile describes it: race, replay and the menu car all build it from
   * this. `vehicle` is the class of the run (default the profile's); the body style is the car's.
   */
  playerCarOptions(vehicle: VehicleClass = this.effectiveVehicle()): CarViewOptions {
    const p = this.store.profile;
    return {
      color: p.carColor,
      vehicle,
      body: p.carBody,
      // A realistic model without the Full Game is drawn Classic; the profile keeps the choice.
      model: effectiveModel(p, vehicle),
      avatar: p.showBadge ? { photo: this.store.profilePhoto(), ring: p.carColor } : null,
    };
  }

  /**
   * A profile value was saved. Only the menu car can be on screen while the profile is edited
   * (races and replays read the profile when they start). A colour is repainted in place; a body,
   * photo or badge change rebuilds the car; a vehicle change rebuilds the menu car's physics too
   * (a bike mesh on car physics would read the wrong suspension). The name is not shown on the car.
   */
  profileChanged(kind: ProfileChange): void {
    const m = this.mode;
    if (!(m instanceof AttractMode) || kind === 'name') return;
    if (kind === 'vehicle') m.setVehicle(this.effectiveVehicle());
    else if (kind === 'color') m.setColor(this.store.profile.carColor);
    else {
      m.refreshCar();
      if (kind === 'model') this.world.requestWarm();
    }
    // A realistic model not loaded yet: the classic vehicle shows until it arrives.
    if (kind === 'vehicle' || kind === 'model') this.preloadModel();
  }

  /**
   * Choose the vehicle class (Profile > Vehicle, the Campaign switch) and save it. Each run keeps the class
   * it started with. A class that needs the Full Game is not chosen (false): the caller opens the store.
   */
  setVehicle(v: VehicleClass): boolean {
    if (vehicleLocked(v)) return false;
    const p = this.store.profile;
    if (p.vehicle === v) return true;
    p.vehicle = v;
    this.store.saveProfile();
    this.profileChanged('vehicle');
    return true;
  }

  /** The class races use: the profile's, or the Car while that class needs the Full Game (the saved choice is kept). */
  effectiveVehicle(): VehicleClass {
    return effectiveVehicle(this.store.profile);
  }

  // ---------------------------------------------------------------- Full Game

  /**
   * Start Google Play billing (Android builds) and follow the entitlement. The local copy unlocks at once
   * (offline too); the store's answer confirms it, or takes it away after a refund.
   */
  async startBilling(): Promise<void> {
    const fg = fullGame();
    // An APK from GitHub (not a Play install): nothing can be bought there, so everything is open, as on
    // the web; the menus drawn before Android answered are redrawn without locks. The dev simulation
    // (?iap=) keeps the store.
    if (fg.billing && !devSimulation() && isSideloadInstall(await installSource())) {
      fg.markSideloaded();
      this.redrawLockScreens();
    }
    fg.onChange(() => this.fullGameChanged());
    if (!fg.billing) return;
    let find: () => CdvNamespace | undefined = findCdvPurchase;
    const sim = devSimulation();
    if (import.meta.env.DEV && sim) {
      const fake = (await import('../platform/fakeBilling')).fakeCdvPurchase(sim === 'owned');
      find = () => fake;
    }
    this.purchases = new Purchases(
      {
        owned: () => fg.storeSays(true),
        notOwned: () => fg.storeSays(false),
        changed: () => refreshFullGameScreen(),
      },
      find,
    );
    await this.purchases.init();
  }

  /**
   * The Full Game was bought, restored, refunded or switched in the dev menu: the menu car takes the
   * class and model the profile now allows, and the screens that show locks are redrawn.
   */
  fullGameChanged(): void {
    const unlocked = fullGame().unlocked;
    if (this.mode instanceof AttractMode) {
      if (this.mode.vehicle !== this.effectiveVehicle()) this.profileChanged('vehicle');
      else this.profileChanged('model');
    }
    if (fullGameScreenOpen()) {
      refreshFullGameScreen();
      return;
    }
    if (unlocked) toast('Full Game unlocked. Thank you!', 3000);
    this.redrawLockScreens();
  }

  /** Redraw the screens that show locks (home, campaign), keeping the campaign's scroll. */
  private redrawLockScreens(): void {
    const screen = currentScreen();
    if (screen?.classList.contains('home')) this.mainMenu();
    else if (screen?.classList.contains('campaign')) this.campaignMenu(screen.scrollTop);
  }

  /** The Full Game screen; Back goes to `back`. Every lock badge opens it. */
  showFullGame(back: () => void): void {
    this.ensureAttract();
    this.setGarageView(false);
    this.hud.show(false);
    this.showTouch(false);
    showFullGameScreen(this, back);
  }

  /** A race that needs the Full Game (its class, or a premium campaign track), or null when it may start. */
  entryLock(entry: Pick<RaceEntry, 'vehicle' | 'base'>): ReturnType<typeof entryLock> {
    return entryLock(entry, campaign());
  }

  /** Garage view for the profile pages: the menu car parks and the camera orbits it, right of centre. */
  setGarageView(on: boolean): void {
    if (this.mode instanceof AttractMode) this.mode.setShowcase(on);
  }

  /**
   * Choose the touch steering (pause menu, Settings, profile Controls tab) and save it. Tilt is
   * kept only if the motion sensor answers: otherwise this says why and returns false, and the
   * steering stays as it was. Call it straight from the tap: iOS asks for motion permission then.
   * A tilt check overtaken by another pick while it waited (Wheel within 1.5 s of Tilt) returns false
   * quietly: the later pick stands, with no "no motion sensor" toast.
   */
  async setSteerMode(m: SteerMode): Promise<boolean> {
    const s = this.store.settings;
    const pick = {};
    this.steerPick = pick;
    if (m === 'tilt') {
      const ok = await this.input.requestTilt();
      if (this.steerPick !== pick) return false;
      if (!ok) {
        toast('Tilt steering needs a motion sensor: none answered, or permission was denied.', 3200);
        this.applyControls();
        return false;
      }
    }
    s.steerMode = m;
    this.store.saveSettings();
    this.applyControls();
    return true;
  }

  applySettings(): void {
    const s = this.store.settings;
    this.audio.setVolume(s.volume);
    this.applyControls();
    this.rig.mode = s.camera;
  }

  /**
   * The driving settings to Input and the touch controls. Unlike applySettings it leaves the
   * camera alone, so the profile and menu screens can call it with the menu car on screen.
   */
  applyControls(): void {
    const s = this.store.settings;
    const i = this.input;
    i.autoAccelerate = s.autoAccelerate;
    i.tiltCenter = s.tiltCenter;
    this.applyTiltTuning();
    // No permission prompt here (not from a tap): on iOS tilt then works once setSteerMode asked.
    i.setTilt(s.steerMode === 'tilt');
    this.touchCtl.setLayout({ steer: s.steerMode, pedals: s.pedals, autoGas: s.autoAccelerate });
    this.syncEdgeGuard();
  }

  /** The tilt sliders' settings to Input, and nothing else: cheap enough for every move of a drag. */
  applyTiltTuning(): void {
    const s = this.store.settings;
    const i = this.input;
    i.tiltSensitivity = s.tiltSensitivity;
    i.tiltDeadzone = s.tiltDeadzone;
    i.tiltCurve = s.tiltCurve;
    i.tiltSmoothing = s.tiltSmoothing;
  }

  /** Once per install, on the first race on a touchscreen: where the steering and pedal options are. */
  showControlsTip(): void {
    const s = this.store.settings;
    if (s.controlsTipShown || !isTouchDevice()) return;
    s.controlsTipShown = true;
    this.store.saveSettings();
    toast(CONTROLS_TIP, 5000);
  }

  showTouch(v: boolean): void {
    this.touchCtl.show(v && isTouchDevice());
    this.syncEdgeGuard();
  }

  /**
   * Android back swipes are turned off over the shown [data-edge-guard] controls and back on
   * everywhere when they are hidden (menus, pause, results). Call it after the controls move.
   */
  syncEdgeGuard(): void {
    // The controls may have moved (rotation, gesture strips): their hit boxes too.
    this.touchCtl.measure();
    const root = $('#touch');
    const boxes = root.classList.contains('hidden')
      ? []
      : [...root.querySelectorAll<HTMLElement>('[data-edge-guard]')].map((el) => el.getBoundingClientRect());
    setGestureExclusion(innerWidth, innerHeight, edgeExclusionRects(boxes, innerWidth, innerHeight));
  }

  /** The Android app reported the system gesture strips: the touch controls (styles.css --ctl-*) move clear of them. */
  private applyGestureInsets(g: GestureInsets): void {
    this.gestureInsets = g;
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(gestureInsetVars(g))) style.setProperty(k, v);
    this.syncEdgeGuard();
  }

  /** The race pills (CP, Restart, Pause, Cam). Steering and pedals are TouchControls. */
  private bindPills(): void {
    const root = $('#touch');
    // The pills act on touch-down: Android generates no click for a tap made while another
    // finger is down, and during a race a thumb is almost always on gas or steering. Pause is
    // the exception: it acts when the finger lifts on it, so a thumb that lands on it while
    // reaching for Cam or Restart can slide off. pointerup is per finger, so a second finger
    // works too, and the capture sends it to the pill wherever the finger lifts.
    root.querySelectorAll<HTMLButtonElement>('.t-small').forEach((b) => {
      const a = b.dataset.a as Action;
      const act = () => this.mode?.onAction?.(a, 'touch');
      const onLift = a === 'pause';
      const pressing = new Set<number>();
      const release = (id: number) => {
        pressing.delete(id);
        b.classList.toggle('pressing', pressing.size > 0);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!onLift) return act();
        pressing.add(e.pointerId);
        b.classList.add('pressing');
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          // The pointer is already gone; its pointerup won't come.
        }
      });
      if (onLift) {
        b.addEventListener('pointerup', (e) => {
          if (!pressing.has(e.pointerId)) return;
          release(e.pointerId);
          // A hidden pill (paused some other way meanwhile) has an empty box, so it does nothing.
          if (liftInside(b.getBoundingClientRect(), e.clientX, e.clientY)) act();
        });
        b.addEventListener('pointercancel', (e) => release(e.pointerId));
        b.addEventListener('lostpointercapture', (e) => release(e.pointerId));
      }
      b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      // Clicks not made by a pointer (accessibility actions, element.click()) have detail 0.
      b.addEventListener('click', (e) => {
        if (e.detail === 0) act();
      });
    });
  }

  /**
   * Browser builds: input is blocked while an ad is requested or playing, and the game freezes
   * and goes quiet while one is on screen. Without an ad network these never fire.
   */
  private bindAds(): void {
    let inputWas = true;
    this.ads.hooks = {
      block: (on) => {
        if (on) inputWas = this.input.enabled;
        this.input.enabled = on ? false : inputWas;
        blockForAd(on);
      },
      playing: (on) => {
        this.adPlaying = on;
        this.audio.mute('ad', on);
        if (!on) this.last = 0; // the ad's time is not a long frame
      },
    };
    // CrazyGames can mute every game from its own page; that wins over the volume setting.
    this.ads.watchMute((m) => this.audio.mute('platform', m));
    if (this.ads.banners) new BannerSlot(this.ads);
  }

  // ---------------------------------------------------------------- Screens

  /** First screen after launch: the setup page until it has been done or skipped once, then home. */
  start(): void {
    void this.startBilling().catch((e) => console.warn('[iap] billing did not start', e));
    if (this.store.profile.setupDone) this.mainMenu();
    else this.profileScreen('setup', () => this.mainMenu());
    // A shared-run link: the browser game's own address, or (Android app) the link it was opened with.
    if (/[#&]run=/.test(location.hash)) {
      const link = location.href;
      history.replaceState(null, '', location.pathname + location.search);
      void this.openSharedRun(link);
    }
    watchRunLinks((url) => void this.openSharedRun(url));
    // The realistic model, if one is picked, loads once the menu is up; the menu car swaps to it.
    setTimeout(() => this.preloadModel(), 1500);
    // Who installed the app (no request): Settings shows Check for updates on APK installs only.
    void this.updates.channel();
    // `npm run dev` with ?update=demo: the update pop-up with sample data (no request), to check its layout.
    if (import.meta.env.DEV && /[?&]update=demo\b/.test(location.search)) {
      this.pendingUpdate = {
        version: '9.9.0',
        tag: 'v9.9.0',
        notes: 'New: <b>a demo</b> of the update pop-up.\n\n- Faster menus\n- A new Desert track\n- Fixes for the pause screen on Android 14 and a much longer line to see how the notes wrap inside the panel',
        apk: { name: 'VelocityBlocks-v9.9.0.apk', url: 'https://github.com/Mitovoid-AI/VelocityBlocks/releases/download/v9.9.0/VelocityBlocks-v9.9.0.apk', size: 31_400_000 },
      };
      setTimeout(() => this.offerUpdate(), 500);
    }
  }

  /**
   * Called once the menu is on screen (main.ts): the automatic update check, a few seconds later. It only
   * asks GitHub on an APK install, at most once a day (platform/updates.ts), and stays silent on failure.
   */
  checkUpdatesSoon(delayMs = 3000): void {
    setTimeout(() => {
      void this.updates.auto().then(
        (info) => {
          if (!info) return;
          this.pendingUpdate = info;
          this.offerUpdate();
        },
        () => {},
      );
    }, delayMs);
  }

  /**
   * Offer the pending update, on the home page only (never over a race, the editor or another menu). It stays
   * pending until the player answers it, so a home page redrawn under the pop-up offers it again.
   */
  private offerUpdate(): void {
    const info = this.pendingUpdate;
    if (!info || popupOpen() || !currentScreen()?.classList.contains('home')) return;
    showUpdatePopup(this.updates, info, () => {
      if (this.pendingUpdate === info) this.pendingUpdate = null;
    });
  }

  /**
   * Load the profile's realistic model for a class in the background. When it arrives and the menu car is
   * still that class wanting that model, the menu car is rebuilt with it (and its shaders built before the
   * next frame). A failed load leaves the classic vehicle.
   */
  preloadModel(vehicle: VehicleClass = this.effectiveVehicle()): void {
    const id = effectiveModel(this.store.profile, vehicle);
    if (!id) return;
    if (readyModel(id)) return;
    void loadModel(id).then((t) => {
      const m = this.mode;
      if (!t || !(m instanceof AttractMode) || m.vehicle !== vehicle || effectiveModel(this.store.profile, vehicle) !== id || m.drawnModel === id) return;
      m.refreshCar();
      this.world.requestWarm();
    });
  }

  /** Home page: the profile card (tap to edit) over the menu. No back act, so Android Back leaves the app. */
  mainMenu(): void {
    this.ensureAttract();
    this.setGarageView(false);
    this.hud.show(false);
    this.showTouch(false);
    showScreen(
      `${homeCardHtml(this)}
       <div class="logo">VELOCITY<br/>BLOCKS</div>
       <div class="tagline">Build it. Drive it. Beat the author time.</div>
       <div class="menu-list">
         <button class="btn primary" data-act="play">&#9654;&nbsp; Play campaign</button>
         <button class="btn" data-act="tracks">My tracks</button>
         <button class="btn" data-act="editor">Track editor</button>
         <button class="btn" data-act="settings">Settings</button>
         <button class="btn" data-act="help">How to play</button>
         <button class="btn" data-act="sharedRun">Open shared run</button>
         ${fullGame().unlocked ? '' : '<button class="btn fg-cta" data-act="fullgame">&#9733;&nbsp; Get Full Game</button>'}
       </div>`,
      'menu-main home with-banner',
      {
        fullgame: () => this.showFullGame(() => this.mainMenu()),
        profile: () => this.profileScreen('edit', () => this.mainMenu()),
        play: () => this.campaignMenu(),
        tracks: () => this.myTracks(),
        editor: () => this.openEditor(),
        settings: () => this.settingsMenu(() => this.mainMenu()),
        help: () => this.helpScreen(),
        sharedRun: () => this.sharedRunScreen(),
      },
    );
    this.offerUpdate();
  }

  /** Paste a shared-run link (from WhatsApp and the like) to watch it or race it. */
  sharedRunScreen(): void {
    const el = showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Open shared run</h2></div>
       <div class="panel" style="max-width:640px">
         <p>Paste the link a friend shared. The game drives their exact inputs on the same track, so you see their real lap, with their pedals and steering, and can race against it.</p>
         <textarea class="run-paste" rows="4" style="width:100%;box-sizing:border-box" placeholder="https://velocityblocks.vercel.app/play/#run=..."></textarea>
         <div class="row" style="gap:8px;margin-top:10px">
           <button class="btn" data-act="paste">Paste</button>
           <button class="btn primary" data-act="open">Open</button>
         </div>
       </div>`,
      'menu-sub',
      {
        back: () => this.mainMenu(),
        paste: () => {
          navigator.clipboard?.readText().then(
            (t) => (el.querySelector<HTMLTextAreaElement>('.run-paste')!.value = t),
            () => toast('Paste it into the box', 1800),
          );
        },
        open: () => void this.openSharedRun(el.querySelector<HTMLTextAreaElement>('.run-paste')!.value),
      },
    );
  }

  /**
   * Open a shared run (a link or its payload): drive its inputs here, then show the replay, verified when it
   * finishes at the shared time. "Race it" races the track with that lap as a ghost.
   */
  async openSharedRun(text: string): Promise<void> {
    const run = await parseRun(text);
    if (!run) {
      toast('That is not a Velocity Blocks run link', 2500);
      return;
    }
    const driven = driveRun(run);
    if (!driven) {
      toast(runTrackData(run) ? 'This run does not finish in this version of the game' : 'This run is on a track this game does not have', 3000);
      return;
    }
    const ci = campaign().findIndex((c) => `c:${c.id}` === run.base);
    const entry: RaceEntry =
      ci >= 0
        ? this.campaignEntry(ci, run.vehicle, run.walls)
        : { key: entryKey(run.base, run.vehicle, run.walls), base: run.base, vehicle: run.vehicle, walls: run.walls, data: runTrackData(run)!, label: run.label || 'Shared track', authorTime: null };
    const name = run.driver || 'Shared run';
    const race = () => this.startRace({ ...entry, rival: { ghost: driven.ghost, name } });
    this.world.setTrack(driven.track);
    this.setMode(
      () =>
        new ReplayMode(this, driven.track, driven.ghost, entry, () => this.mainMenu(), {
          title: 'Shared run',
          driver: run.driver,
          note: driven.verified ? '\u2713 verified' : 'not verified: another game version',
          onRace: race,
        }),
    );
  }

  /** The replay of a race entry's personal best (its ghost), or a note when none was kept. */
  watchBest(entry: RaceEntry, back: () => void): void {
    const ghost = this.store.ghost(entry.key);
    if (!ghost) {
      toast('No replay of this best lap was kept', 2000);
      return;
    }
    const track = new Track(entry.data, { walls: entry.walls });
    this.world.setTrack(track);
    this.setMode(() => new ReplayMode(this, track, ghost, entry, back, { title: 'Best lap' }));
  }

  /** Setup page or profile editor over the menu car; it turns the garage view on itself. */
  profileScreen(mode: ProfileMode, back: () => void): void {
    this.ensureAttract();
    this.hud.show(false);
    this.showTouch(false);
    showProfileScreen(this, mode, back);
  }

  /**
   * The campaign cards: PB, medal and author time for the profile's vehicle in the current wall mode
   * (the author time stays secret until beaten there). `scrollTop` keeps the grid where it was when
   * the vehicle switch re-renders it.
   */
  campaignMenu(scrollTop = 0): void {
    this.ensureAttract();
    const list = campaign();
    // The sets (Stadium, Desert, Water): one on show at a time, each with its own unlock chain.
    const sets = campaignSets(list);
    const set = sets.find((x) => x.theme === this.campaignSet) ?? sets[0];
    const unlocked = fullGame().unlocked;
    const premium = unlocked ? new Set<string>() : premiumTrackIds(list);
    // A finish under an earlier physics version, or with any vehicle or wall mode, unlocks the next
    // track of the set; PBs and medals come from this version's records for this vehicle and wall mode only.
    // Browser builds can open the first locked track with a rewarded ad.
    const locks = this.setLocks(set.indices);
    const canReward = this.ads.canReward();
    /** A card's campaign index (its data-id, else data-i), or -1 when it is not a track of the set on show. */
    const cardIndex = (el: HTMLElement): number => {
      const id = el.dataset.id;
      const idx = id ? list.findIndex((c) => c.id === id) : Number(el.dataset.i);
      return set.indices.includes(idx) ? idx : -1;
    };
    const cards = set.indices
      .map((idx, n) => {
        const ct = list[idx];
        // A premium track without the Full Game: the lock badge opens the store, whatever the chain says.
        const paid = premium.has(ct.id);
        const locked = paid || locks[n].locked;
        const offer = !paid && locks[n].unlockable && canReward;
        const name = ct.data.name.replace(/^\S+\s/, '');
        let meta: string;
        if (paid) meta = '<span class="fg-badge">&#128274; Full Game</span>';
        else if (offer) meta = '<span class="ad-mark">AD</span>Watch an ad to unlock<br/>or finish the previous track';
        else if (locked) meta = '&#128274; Finish the previous track';
        else {
          // The race's own key and author time, so the card and the race can never disagree.
          const e = this.campaignEntry(idx);
          const rec = this.store.record(e.key);
          const m = e.authorTime ? medalTimes(e.authorTime) : null;
          const medal = medalFor(rec?.best, m);
          meta = `${medal ? medalDot(medal) : ''}PB ${rec ? formatTime(rec.best) : '--'}<br/>${authorLabel(e.authorTime, authorRevealed(rec?.best, m))}`;
          // The best lap's replay (telemetry, its line, share it as a video or a run link).
          if (rec) meta += `<span class="card-best" data-act="best" data-i="${idx}">&#9654; Best lap</span>`;
        }
        return `<button class="card ${locked ? 'locked' : ''} ${paid ? 'premium' : ''} ${offer ? 'unlockable' : ''}" data-act="${paid ? 'premium' : offer ? 'unlock' : locked ? 'locked' : 'race'}" data-i="${idx}" data-id="${esc(ct.id)}">
          <div><span class="id">${ct.id}</span><span class="series s-${ct.series}">${ct.series}</span></div>
          <div class="name">${esc(name)}</div>
          <div class="meta">${meta}</div>
        </button>`;
      })
      .join('');
    const el = showScreen(
      `<div class="header campaign-head"><button class="btn small" data-act="back">&#8592; Back</button><h2>Campaign</h2><div class="spacer"></div>
         ${this.store.settings.walls ? WALLS_CHIP() : ''}${sets.length > 1 ? setSegHtml(sets, set.theme) : ''}${vehicleSegHtml(this.effectiveVehicle(), unlocked)}</div>
       <div class="grid">${cards}</div>`,
      'dim with-banner campaign',
      {
        back: () => this.mainMenu(),
        locked: () => toast('Finish the previous track to unlock this one.'),
        premium: () => this.showFullGame(() => this.campaignMenu()),
        unlock: (el) => {
          const idx = cardIndex(el);
          if (idx >= 0) this.unlockOffer(idx);
        },
        // The card's own track (by id), and only while it is on the set on show: never another set's track
        // at the same position. playRace checks the locks again.
        race: (el) => {
          const idx = cardIndex(el);
          if (idx >= 0) void this.playRace(this.campaignEntry(idx));
        },
        best: (el) => {
          const idx = cardIndex(el);
          if (idx >= 0) this.watchBest(this.campaignEntry(idx), () => this.campaignMenu(el.closest('.screen')?.scrollTop ?? 0));
        },
        set: (b) => {
          const t = sets.find((x) => x.theme === b.dataset.v);
          if (!t || t === set) return;
          this.campaignSet = t.theme;
          this.campaignMenu();
        },
        veh: (b) => {
          const v = VEHICLE_CLASSES.find((x) => x === b.dataset.v);
          if (!v || v === this.effectiveVehicle()) return;
          const top = el.scrollTop;
          if (!this.setVehicle(v)) return this.showFullGame(() => this.campaignMenu(top));
          this.campaignMenu(top);
        },
      },
    );
    if (scrollTop && el) el.scrollTop = scrollTop;
  }

  /** The unlock chain of one campaign set (its tracks' campaign indices, in order): finish one to open the next. */
  private setLocks(indices: readonly number[]): ReturnType<typeof campaignLocks> {
    const list = campaign();
    return campaignLocks(
      indices.map((i) => `c:${list[i].id}`),
      (k) => this.store.hasFinished(k),
      (k) => this.store.adUnlocked(k),
    );
  }

  /** The set a campaign track belongs to, and its place in that set (null: no such track). */
  private setOfTrack(i: number): { indices: number[]; pos: number } | null {
    for (const s of campaignSets(campaign())) {
      const pos = s.indices.indexOf(i);
      if (pos >= 0) return { indices: s.indices, pos };
    }
    return null;
  }

  /**
   * True when a campaign track is shut by its set's unlock chain: the track before it in the same set is
   * not finished (with any vehicle, wall mode or physics version) and no rewarded ad opened it. The first
   * track of every set (A01, D01, W01) is always open. The Full Game locks are separate (entryLock).
   */
  chainLocked(i: number): boolean {
    const s = this.setOfTrack(i);
    return !s || this.setLocks(s.indices)[s.pos].locked;
  }

  /** Rewarded ad offer for a locked campaign track. Both choices look the same (portal rule). */
  private unlockOffer(i: number): void {
    const list = campaign();
    const ct = list[i];
    const s = this.setOfTrack(i);
    const prev = s && s.pos > 0 ? list[s.indices[s.pos - 1]] : undefined;
    showScreen(
      `<div class="panel result" style="margin:auto;max-width:480px">
        <h2 style="margin:0 0 10px">Unlock ${esc(ct.id)}?</h2>
        <p>Watch a short ad to unlock <b>${esc(ct.data.name.replace(/^\S+\s/, ''))}</b> now, or finish ${esc(prev?.id ?? 'the previous track')} to unlock it for free.</p>
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn center" data-act="watch"><span class="ad-mark">AD</span>Watch ad</button>
          <button class="btn center" data-act="back">Not now</button>
        </div>
      </div>`,
      'dim',
      {
        watch: async () => {
          if (this.ads.busy) return;
          if (await this.ads.rewarded()) {
            this.store.unlockWithAd(`c:${ct.id}`);
            toast(`${ct.id} unlocked!`);
          } else {
            toast('The ad did not finish, so the track stays locked. Try again later.', 3000);
          }
          this.campaignMenu();
        },
        back: () => this.campaignMenu(),
      },
    );
  }

  /**
   * A campaign race: the profile's vehicle and the Walls setting unless given. Its key keeps records,
   * ghosts and medals per vehicle and wall mode; the author time is the class's (both wall modes).
   */
  campaignEntry(
    i: number,
    vehicle: VehicleClass = this.effectiveVehicle(),
    walls: boolean = this.store.settings.walls,
  ): RaceEntry {
    const ct = campaign()[i];
    const base = `c:${ct.id}`;
    return {
      key: entryKey(base, vehicle, walls),
      base,
      vehicle,
      walls,
      data: ct.data,
      label: ct.data.name,
      authorTime: campaignAuthorTime(ct.id, vehicle),
      campaignIndex: i,
    };
  }

  /**
   * "Next track": the next track of the same set (none after a set's last one: A12, D06 and W06 lead to the
   * menu, not into another set). It keeps the run's vehicle and wall mode.
   */
  nextCampaignEntry(e: RaceEntry): RaceEntry | null {
    if (e.campaignIndex === undefined) return null;
    const s = this.setOfTrack(e.campaignIndex);
    const n = s ? s.indices[s.pos + 1] : undefined;
    return n !== undefined ? this.campaignEntry(n, e.vehicle, e.walls) : null;
  }

  /**
   * Every race starts here (menus, Next track, Retry from a replay, editor test drives). One that needs the
   * Full Game opens its screen instead (false); Back from it goes to the menu the race belongs to. A
   * campaign track its set's chain still shuts never starts either (false: the campaign menu instead).
   */
  startRace(entry: RaceEntry): boolean {
    if (this.blockLocked(entry) || this.blockChained(entry)) return false;
    this.audio.unlock();
    if (entry.campaignIndex !== undefined) {
      const ct = campaign()[entry.campaignIndex];
      if (ct) this.campaignSet = trackTheme(ct);
    }
    this.setMode(() => new RaceMode(this, entry));
    return true;
  }

  /** A locked race: the Full Game screen instead, and true. Back goes to the campaign, the editor or My tracks. */
  blockLocked(entry: RaceEntry): boolean {
    if (!this.entryLock(entry)) return false;
    const back = entry.fromEditor ? () => this.openEditor() : entry.campaignIndex !== undefined ? () => this.campaignMenu() : () => this.myTracks();
    this.showFullGame(back);
    return true;
  }

  /** A campaign track its set's unlock chain shuts: say so, show the campaign, and true. */
  blockChained(entry: RaceEntry): boolean {
    if (entry.campaignIndex === undefined || !this.chainLocked(entry.campaignIndex)) return false;
    toast('Finish the previous track to unlock this one.');
    this.campaignMenu();
    return true;
  }

  /**
   * Start a race at a natural break (a track picked from a menu, Next track): browser builds
   * may play an interstitial first. Retry, Restart and editor test drives use startRace.
   */
  async playRace(entry: RaceEntry): Promise<void> {
    if (this.ads.busy) return;
    // No ad and no model load for a race that cannot start.
    if (this.blockLocked(entry) || this.blockChained(entry)) return;
    const screen = currentScreen();
    const mode = this.mode;
    const p = this.pendingStart;
    if (p && p.screen === screen && p.mode === mode) return; // a second tap while this screen's start waits
    this.audio.unlock(); // while the tap's user activation is still fresh
    const start = { screen, mode };
    this.pendingStart = start;
    // Back or another screen while it waits: no race (and no toast) from a screen the player has left.
    const current = () => this.pendingStart === start && this.mode === mode && currentScreen() === screen;
    let ok = true;
    let live = false;
    try {
      [, ok] = await Promise.all([this.ads.interstitial(), this.waitForModel(entry.vehicle, current)]);
      live = current();
    } finally {
      if (this.pendingStart === start) this.pendingStart = null;
    }
    if (!live) return;
    if (!ok) toast('The realistic model could not be loaded: racing the classic one.', 3000);
    this.startRace(entry);
  }

  /**
   * Before a race: the profile's realistic model for the class, loaded (startRace stays synchronous and
   * draws it from the cache). A slow load says so after a moment while the start is `current`; false when
   * it failed or timed out, and the race goes ahead with the classic vehicle instead of hanging.
   */
  private async waitForModel(vehicle: VehicleClass, current: () => boolean = () => true): Promise<boolean> {
    const id = effectiveModel(this.store.profile, vehicle);
    if (!id || readyModel(id)) return true;
    const tip = setTimeout(() => {
      if (current()) toast('Loading vehicle…', 2500);
    }, 300);
    const ok = await ensureModel(id, MODEL_WAIT_MS);
    clearTimeout(tip);
    return ok;
  }

  /**
   * A custom track's race (My tracks, or an editor test drive with `fromEditor`). `onAuthorTime` is
   * called when a test drive sets or lowers the vehicle's author time (see authorTimeAfter).
   */
  customEntry(
    data: TrackData,
    fromEditor = false,
    onAuthorTime?: (t: number) => void,
    vehicle: VehicleClass = this.effectiveVehicle(),
    walls: boolean = this.store.settings.walls,
  ): RaceEntry {
    const base = `u:${layoutHash(data)}`;
    return {
      key: entryKey(base, vehicle, walls),
      base,
      vehicle,
      walls,
      data,
      label: data.name,
      authorTime: customAuthorTime(data, vehicle),
      fromEditor,
      onAuthorTime,
    };
  }

  myTracks(): void {
    this.ensureAttract();
    const tracks = this.store.customTracks();
    const { vehicle } = this.store.profile;
    const { walls } = this.store.settings;
    const items = tracks.length
      ? tracks
          .map((t) => {
            // The race's key and author time for this vehicle and wall mode.
            const e = this.customEntry(t.data);
            const rec = this.store.record(e.key);
            const m = e.authorTime ? medalTimes(e.authorTime) : null;
            const medal = medalFor(rec?.best, m);
            // A road that is not joined end to end may need the grass between its parts, and walls fence that off.
            const warn = walls && !routeComplete(t.data) ? `<div class="walls-warn">${WALLS_ROUTE_NOTE}</div>` : '';
            return `<div class="list-item">
              <div class="grow"><div class="title">${esc(t.data.name)}</div>
              <div class="muted">${t.data.blocks.length} blocks &middot; by ${esc(t.data.author)} &middot; ${authorLabel(e.authorTime, authorRevealed(rec?.best, m))} &middot; ${medal ? medalDot(medal) : ''}PB ${rec ? formatTime(rec.best) : '--'}</div>${warn}</div>
              <button class="btn small" data-act="play" data-id="${t.id}">Play</button>
              <button class="btn small" data-act="edit" data-id="${t.id}">Edit</button>
              <button class="btn small" data-act="export" data-id="${t.id}">Export</button>
              <button class="btn small" data-act="del" data-id="${t.id}">Delete</button>
            </div>`;
          })
          .join('')
      : '<div class="panel muted">No tracks yet. Build one in the Track editor, or import a track file.</div>';
    const find = (el: HTMLElement) => tracks.find((t) => t.id === el.dataset.id)!;
    // Times are the profile's vehicle's in the current wall mode: say which.
    const chips = `${vehicle !== 'car' ? chipHtml(VEHICLE_LABEL[vehicle], 'Times and medals for this vehicle (Driver profile)') : ''}${
      this.store.settings.walls ? WALLS_CHIP() : ''
    }`;
    showScreen(
      `<div class="header campaign-head"><button class="btn small" data-act="back">&#8592; Back</button><h2>My tracks</h2>${chips}<div class="spacer"></div>
         <button class="btn small" data-act="import">Import file</button>
         <button class="btn small primary" data-act="new">New track</button></div>
       <div class="list">${items}</div>`,
      'dim with-banner',
      {
        back: () => this.mainMenu(),
        new: () => {
          // A new track replaces the one draft slot, so ask first, as the editor's own New does.
          const d = this.unsavedDraft();
          if (d && !confirm(`Start a new empty track? Unsaved changes to "${d.data.name}" are lost.`)) return;
          this.openEditor(null);
        },
        play: (el) => {
          const t = find(el);
          if (!new Track(t.data).start) return toast('This track has no Start block.');
          void this.playRace(this.customEntry(t.data));
        },
        edit: (el) => this.openEditor(find(el)),
        export: (el) => {
          const t = find(el);
          downloadText(`${t.data.name.replace(/[^\w-]+/g, '_') || 'track'}.vbtrack.json`, exportTrack(t.data));
        },
        del: (el) => {
          const t = find(el);
          if (confirm(`Delete "${t.data.name}"? This cannot be undone.`)) {
            this.store.deleteCustomTrack(t.id);
            this.myTracks();
          }
        },
        import: async () => {
          const text = await pickTextFile();
          if (!text) return;
          try {
            const data = importTrack(text);
            this.store.saveCustomTrack({ id: `imp-${layoutHash(data)}`, data, updated: Date.now() });
            toast(`Imported "${data.name}"`);
            this.myTracks();
          } catch (e) {
            toast((e as Error).message, 3200);
          }
        },
      },
    );
  }

  /**
   * No argument: back to the editor in use, else the draft left from last time. A saved track:
   * edit it. null: a new, empty track (its first edit replaces the draft).
   */
  openEditor(saved?: SavedTrack | null): void {
    this.audio.unlock();
    // The draft is read after the previous mode exits, because EditorMode.exit writes it.
    // enter() attaches the editor to the scene and UI.
    this.setMode(() => {
      if (saved !== undefined) this.editor = new EditorMode(this, saved);
      else if (!this.editor) this.editor = new EditorMode(this, this.store.editorDraft());
      return this.editor;
    });
    this.editor!.enter();
  }

  /** The editor draft, when it has blocks that My tracks doesn't hold (same id, name and layout). */
  private unsavedDraft(): SavedTrack | null {
    const d = this.store.editorDraft();
    if (!d?.data.blocks.length) return null;
    const s = this.store.customTracks().find((t) => t.id === d.id);
    return s && s.data.name === d.data.name && layoutHash(s.data) === layoutHash(d.data) ? null : d;
  }

  /** Called by the editor when it is left for good. */
  closeEditor(): void {
    this.editor = null;
    this.mainMenu();
  }

  /**
   * Game settings. Name, car, camera, pedals and auto-accelerate live in the driver profile;
   * touchscreens also get the steering choice here, where it is easy to find, and with tilt the
   * sensitivity slider, a live gauge, Recentre and More... (the Tilt steering screen).
   */
  settingsMenu(back: () => void): void {
    // Coming back from Edit driver profile: the menu car leaves the garage and laps again.
    this.setGarageView(false);
    const s = this.store.settings;
    const tiltHidden = s.steerMode === 'tilt' ? '' : 'hidden';
    // Buttons, not a drop-down, so a second-finger tap (pointerup routing in showScreen) works.
    const steer = isTouchDevice()
      ? `<label id="s-steer-l">Steering</label><div class="seg" role="group" aria-labelledby="s-steer-l">${STEER_MODES.map(
          (m) => `<button class="btn small ${m === s.steerMode ? 'sel' : ''}" data-act="steer" data-v="${m}" aria-pressed="${m === s.steerMode}">${STEER_LABEL[m]}</button>`,
        ).join('')}</div>
         <label id="s-sens-l" class="s-tilt ${tiltHidden}">Tilt sensitivity</label>
         <div class="s-tilt tilt-row ${tiltHidden}">${tiltSliderHtml('sens', s, 's-sens-l')}${tiltValHtml('sens', s)}</div>
         <label class="s-tilt ${tiltHidden}">Tilt now</label>
         <div class="s-tilt tilt-row ${tiltHidden}">${tiltGaugeHtml()}<button class="btn small" data-act="recentre">Recentre</button><button class="btn small" data-act="tilt-more" aria-label="More tilt steering settings">More&hellip;</button></div>`
      : '';
    const el = showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Settings</h2></div>
       <div class="panel"><div class="form">
         <label>Driver &amp; car</label><div><button class="btn small" data-act="profile">Edit driver profile</button></div>
         ${steer}
         <label for="s-q">Graphics quality</label>
         <select id="s-q">${qualityOptionsHtml(s.qualityAuto ? 'auto' : s.quality, s.quality)}</select>
         <label id="s-vol-l">Volume</label>
         <div class="tilt-row">${sliderHtml(VOLUME, s.volume, { id: 's-vol', labelledBy: 's-vol-l', text: volumeText(s.volume) })}<span class="tilt-val" id="s-vol-v">${volumeText(s.volume)}</span></div>
         <label for="s-ghost">Show personal-best ghost</label><input id="s-ghost" type="checkbox" ${s.showGhost ? 'checked' : ''}/>
         <label for="s-mghost">Show the target ghost and its line</label><input id="s-mghost" type="checkbox" ${s.medalGhosts ? 'checked' : ''}/>
         <label id="s-walls-l">Walls on all roads</label>
         <div><div class="seg" role="group" aria-labelledby="s-walls-l">${[false, true]
           .map((on) => `<button class="btn small ${on === s.walls ? 'sel' : ''}" data-act="walls" data-v="${on ? 'on' : 'off'}" aria-pressed="${on === s.walls}">${on ? 'On' : 'Off'}</button>`)
           .join('')}</div>
           <div class="muted form-note">Barriers on every road edge. Times with walls are kept apart.</div></div>
         ${this.fullGameSettingsHtml()}
         <label>Progress</label><div><button class="btn small" data-act="reset">Reset records &amp; ghosts</button></div>
         <label>Credits</label><div><button class="btn small" data-act="credits">Credits &amp; licenses</button></div>
         ${this.updates?.channelNow === 'sideload' ? '<label>Updates</label><div><button class="btn small" data-act="updates">Check for updates</button></div>' : ''}
       </div>
       <div class="s-version"><span data-act="ver" class="s-ver">Velocity Blocks ${APP_VERSION}</span></div>
       ${this.devSwitchHtml()}</div>`,
      'dim',
      {
        walls: (b) => {
          const on = b.dataset.v === 'on';
          el.querySelectorAll<HTMLElement>('[data-act="walls"]').forEach((x) => {
            x.classList.toggle('sel', x === b);
            x.setAttribute('aria-pressed', String(x === b));
          });
          if (on === s.walls) return;
          s.walls = on;
          this.store.saveSettings();
          this.wallsChanged();
        },
        back: () => {
          this.store.saveSettings();
          back();
        },
        profile: () => {
          this.store.saveSettings();
          this.profileScreen('edit', () => this.settingsMenu(back));
        },
        credits: () => {
          this.store.saveSettings();
          this.creditsScreen(() => this.settingsMenu(back));
        },
        fullgame: () => {
          this.store.saveSettings();
          this.showFullGame(() => this.settingsMenu(back));
        },
        ver: () => {
          // Debug Android builds: DEV_TAPS taps show the Full Game dev switch. Release builds: nothing.
          if (!fullGame().devTools) return;
          this.versionTaps++;
          if (this.versionTaps === DEV_TAPS) {
            toast('Developer options on');
            this.settingsMenu(back);
          }
        },
        'dev-fg': (b) => {
          const v = b.dataset.v;
          fullGame().setDev(v === 'owned' || v === 'free' ? v : null);
          this.store.saveSettings();
          this.settingsMenu(back);
        },
        updates: (b) => this.checkUpdatesNow(b),
        reset: () => {
          if (confirm('Reset all personal bests and ghosts? Your own tracks are kept.')) {
            this.store.resetProgress();
            toast('Records cleared');
          }
        },
        steer: (b) => {
          const m = STEER_MODES.find((x) => x === b.dataset.v);
          if (!m) return;
          const mark = (cur: SteerMode) => {
            el.querySelectorAll<HTMLElement>('[data-act="steer"]').forEach((x) => {
              x.classList.toggle('sel', x.dataset.v === cur);
              x.setAttribute('aria-pressed', String(x.dataset.v === cur));
            });
            el.querySelectorAll('.s-tilt').forEach((x) => x.classList.toggle('hidden', cur !== 'tilt'));
          };
          mark(m);
          // Tilt may be refused (no sensor): show what was kept.
          void this.setSteerMode(m).then(() => mark(s.steerMode));
        },
        recentre: () => recentreSaved(this),
        'tilt-more': () => {
          this.store.saveSettings();
          showTiltScreen(this, () => this.settingsMenu(back));
        },
      },
    );
    // No applySettings here: it also sets rig.mode, which would pull the menu camera off 'far'.
    // Each handler applies its own value.
    const on = (id: string, ev: string, fn: (t: HTMLInputElement & HTMLSelectElement) => void) =>
      $(id, el).addEventListener(ev, (e) => {
        fn(e.target as HTMLInputElement & HTMLSelectElement);
        this.store.saveSettings();
      });
    on('#s-q', 'change', (t) => {
      chooseQuality(s, t.value, isTouchDevice());
      // Back to Auto forgets the tiers it marked failed (chooseQuality), in this session's governor too.
      if (s.qualityAuto) this.governor.failed = null;
      this.setQuality(s.quality, s.qualityAuto);
      // The Auto option names the tier it is on.
      t.innerHTML = qualityOptionsHtml(s.qualityAuto ? 'auto' : s.quality, s.quality);
    });
    on('#s-ghost', 'change', (t) => (s.showGhost = t.checked));
    on('#s-mghost', 'change', (t) => (s.medalGhosts = t.checked));
    // Heard while dragged, saved when let go.
    el.querySelectorAll<HTMLElement>('#s-vol').forEach((v) =>
      bindSlider(v, VOLUME, s.volume, {
        text: volumeText,
        input: (x) => {
          s.volume = x;
          this.audio.setVolume(x);
          const t = el.querySelector('#s-vol-v');
          if (t) t.textContent = volumeText(x);
        },
        change: () => this.store.saveSettings(),
      }),
    );
    bindTiltControls(el, this);
  }

  /** Settings > Check for updates: asks GitHub now and says what it found (or shows the offer). */
  private checkUpdatesNow(btn: HTMLElement): void {
    const b = btn as HTMLButtonElement;
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = 'Checking…';
    void this.updates.manual().then((r) => {
      b.disabled = false;
      b.textContent = 'Check for updates';
      if (!b.isConnected) return; // left Settings meanwhile
      if (r.kind === 'update') showUpdatePopup(this.updates, r.info);
      else if (r.kind === 'current') toast(`You're up to date (${APP_VERSION})`);
      else toast("Couldn't check for updates. Check the connection and try again later.", 3200);
    });
  }

  /** Settings > Full Game: Get it (store builds without it), or that it is owned with Restore at hand. */
  private fullGameSettingsHtml(): string {
    const fg = fullGame();
    if (!fg.billing) return '';
    return `<label>Full Game</label><div>${
      fg.unlocked
        ? '<span class="fg-owned">&#10003; Unlocked</span> <button class="btn small" data-act="fullgame">Details</button>'
        : '<button class="btn small fg-cta" data-act="fullgame">&#9733; Get Full Game</button>'
    }</div>`;
  }

  /** Debug builds, after DEV_TAPS taps on the version: simulate owning the Full Game or not. */
  private devSwitchHtml(): string {
    const fg = fullGame();
    if (!fg.devTools || this.versionTaps < DEV_TAPS) return '';
    const cur = fg.devOverride ?? 'store';
    const opt = (v: string, label: string) =>
      `<button class="btn small ${v === cur ? 'sel' : ''}" data-act="dev-fg" data-v="${v}" aria-pressed="${v === cur}">${label}</button>`;
    return `<div class="panel s-dev"><div class="muted">Developer: Full Game (debug builds only). Store says: ${fg.owned ? 'owned' : 'not owned'}.</div>
      <div class="seg" role="group" aria-label="Simulate the Full Game">${opt('store', 'Follow store')}${opt('owned', 'Owned')}${opt('free', 'Not owned')}</div></div>`;
  }

  private wallsTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Walls on all roads changed: the menu track behind Settings is rebuilt with or without them, a
   * moment later so quick toggling rebuilds (and recompiles) once. Races, test drives and the
   * editor read the setting when they start.
   */
  private wallsChanged(): void {
    clearTimeout(this.wallsTimer);
    this.wallsTimer = setTimeout(() => {
      if (this.mode instanceof AttractMode && this.mode.walls !== this.store.settings.walls) this.mode.reload();
    }, 300);
  }

  /**
   * Settings > Credits: the realistic vehicle models' authors, sources and licenses (CC BY 4.0), as plain
   * text. No links: the portals' rules on links out, and the app's WebView, make text the safe form.
   */
  creditsScreen(back: () => void): void {
    showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Credits</h2></div>
       <div class="panel credits" style="max-width:760px">
         <p>Velocity Blocks: game code, tracks and the Classic vehicles are original work, MIT licensed.</p>
         <p>The Realistic vehicles are third-party models used under <b>Creative Commons Attribution 4.0</b> (CC BY 4.0, ${esc(CC_BY_URL)}). They are not covered by the game's MIT license.</p>
         ${creditsHtml()}
       </div>`,
      'dim',
      { back },
    );
  }

  helpScreen(): void {
    showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>How to play</h2></div>
       <div class="panel" style="max-width:760px">
         <p>Drive from <b>Start</b> to <b>Finish</b> as fast as you can. Pass through <b>every checkpoint</b> first, in any order. Beat the bronze, silver and gold times, then the <b>secret author time</b>: it is revealed when you beat it. Your best run is saved as a ghost to race against.</p>
         <p>You can leave the road and drive on the grass, but grass is slow. A checkpoint only counts when you drive through its gate, between the posts. Settings &gt; <b>Walls on all roads</b> puts barriers along every road; times with walls are kept separately.</p>
         <p>Pick a <b>Car</b>, <b>Bike</b> or <b>Truck</b> in your driver profile or at the top of the Campaign. Each drives differently and has its own records, medals and author times; finishing a track with any of them unlocks the next one.${
           fullGame().billing
             ? ' The Bike, the Truck, the Realistic models and the Desert and Water tracks after the first come with the <b>Full Game</b>.'
             : ''
         }</p>
         <div class="keys">
           <div><kbd>&uarr;</kbd> <kbd>W</kbd></div><div>Accelerate</div>
           <div><kbd>&darr;</kbd> <kbd>S</kbd> <kbd>Space</kbd></div><div>Brake / reverse. Tap it while steering at speed to drift.</div>
           <div><kbd>&larr;</kbd><kbd>&rarr;</kbd> <kbd>A</kbd><kbd>D</kbd></div><div>Steer</div>
           <div><kbd>N</kbd> <kbd>Shift</kbd></div><div>Nitro: a 1.5 s boost. Braking ends it, and it charges again 6 s after it ends. Press it during 3-2-1 to fire at GO.</div>
           <div><kbd>Backspace</kbd> <kbd>R</kbd></div><div>Respawn at the last checkpoint (the clock keeps running)</div>
           <div><kbd>Enter</kbd> <kbd>Del</kbd></div><div>Restart the run</div>
           <div><kbd>C</kbd></div><div>Change camera</div>
           <div><kbd>G</kbd></div><div>Toggle ghost</div>
           <div><kbd>Esc</kbd> <kbd>P</kbd></div><div>Pause</div>
         </div>
         <p>If the car is stuck on its roof or side for 3 seconds it goes back to the last checkpoint by itself (or restarts if none has been passed).</p>
         <p>Downforce presses the car onto the road, so fast corners hold more grip than slow ones, and the steering lock eases off at speed. Brake in a straight line before the corner. Traction control trims the power when you ask for too much out of a slow corner; set it to Low in your driver profile (Controls) to let the rear wheels spin. Turn on the <b>racing line</b> in the pause menu: green is full throttle, yellow is lift, red is brake.</p>
         <p class="muted">Gamepad: left stick to steer, RT to accelerate, LT/B to brake, RB for nitro, Y to respawn, Back to restart.</p>
         <p class="muted">Phones and tablets: steer with the arrow buttons, a steering wheel or by tilting the device; pick one in the pause menu (Steering), in Settings or in your driver profile. The gas and brake bars are analog: a light touch on the gas gives a third of the power, and above the dashed line it is full. Any touch on the brake is strong enough for the drift (tap it while steering at speed); higher up it brakes harder. Tap the <b>N2O</b> button on the left, by the steering, for nitro (its ring counts down the 6 s recharge). With tilt, drag the sensitivity slider in Settings or your driver profile; More... has the dead zone, smoothing, centre feel and a live gauge, and Recentre sets how you hold the device as straight ahead (the pause menu has Recentre tilt too). Your driver profile (tap your card on the home screen) also has your photo, name and car, the starting camera, round on/off pedals and auto-accelerate. Cam changes the camera; the ghost and racing line toggles are in the pause menu. During a race, Back swipes that start on the controls are ignored, so tap the pause button to pause. In the track editor, drag to pan, pinch to zoom, and twist two fingers or hold the turn arrows to turn the view.</p>
         <p class="muted">Green pads give a boost and red pads a turbo; the nitro adds to both. It pushes only with the wheels on the road, so fire it before the ramp, not over it. Jumps need speed!</p>
       </div>`,
      'dim',
      { back: () => this.mainMenu() },
    );
  }
}

/**
 * Menu background: the autopilot laps campaign tracks while the camera follows. In the garage
 * view (profile pages) the car is parked on its start block and the camera orbits it instead.
 */
export class AttractMode implements Mode {
  private race!: RaceSession;
  private bot!: Autopilot;
  private track!: Track;
  private car: CarView | null = null;
  private prev!: PoseSnapshot;
  private acc = 0;
  private idx = 0;
  private time = 0;
  private showcase = false;
  private showT = 0;

  constructor(private readonly app: App) {
    this.idx = Math.floor(Math.random() * 4);
    this.load();
  }

  /** The wall mode the menu track was built with. */
  get walls(): boolean {
    return this.track.walls;
  }

  /** The class lapping the menu track. */
  get vehicle(): VehicleClass {
    return this.race.vehicle;
  }

  /** The realistic model the menu car is drawn with, or null (classic). */
  get drawnModel(): string | null {
    return this.car?.visual.model ?? null;
  }

  private load(): void {
    const ct = campaign()[this.idx % campaign().length];
    // The menu track shows Walls on all roads when it is on, and the profile's vehicle laps it.
    const track = new Track(ct.data, { walls: this.app.store.settings.walls });
    this.track = track;
    this.app.world.setTrack(track);
    this.app.rig.mode = 'far';
    this.startVehicle(this.app.effectiveVehicle());
    this.time = 0;
    // Sanity: a broken route would leave the bot stuck; skip such a track.
    if (!traceRoute(track).complete) this.idx++;
  }

  /** A session, autopilot and car of a vehicle class on the current track, from its start. */
  private startVehicle(v: VehicleClass): void {
    this.race = new RaceSession(this.track, undefined, v);
    this.bot = new Autopilot(this.track, v);
    this.refreshCar();
    this.prev = this.pose();
    this.acc = 0;
    this.app.rig.vehicle = v;
    this.app.rig.reset();
  }

  /** Settings > Walls on all roads changed: the same track again, with or without the walls. */
  reload(): void {
    this.load();
  }

  /**
   * The profile's vehicle changed: a new session, autopilot and car on the same track, in place (no
   * setMode). In the garage the new vehicle parks on the start block like the old one did.
   */
  setVehicle(v: VehicleClass): void {
    this.startVehicle(v);
    this.time = 0;
    this.showT = 0;
    // The new mesh's programs are built before it is drawn, not on its first frame.
    this.app.world.requestWarm();
  }

  /** Rebuild the car from the profile (body style, photo badge). update() poses it before the next render. */
  refreshCar(): void {
    this.car?.dispose();
    this.car = new CarView(this.app.world.scene, this.app.playerCarOptions(this.race.vehicle));
  }

  /** Repaint in place (the badge ring follows): a colour change needs no rebuild. */
  setColor(c: string): void {
    this.car?.setColor(c);
  }

  setShowcase(on: boolean): void {
    if (on === this.showcase) return;
    this.showcase = on;
    this.app.rig.boost = 0;
    if (on) {
      // restart() parks the car on the start block with its wheels on the road, and the
      // countdown does not step physics. When the garage closes the bot starts a fresh run,
      // so the track-switch timer starts again too.
      this.race.restart();
      this.prev = this.pose();
      this.acc = 0;
      this.showT = 0;
      this.time = 0;
    }
    this.app.rig.reset();
  }

  private pose(): PoseSnapshot {
    return { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
  }

  update(dt: number): void {
    if (this.showcase) {
      // No stepping, so the finish and 120 s track switches below wait until the garage closes.
      this.showT += dt;
      const c = this.race.car;
      this.car!.apply(this.prev, c, 1);
      this.app.rig.showcase(c.pos, this.showT, 0.5);
      this.app.world.focusShadow(c.pos.x, c.pos.y, c.pos.z);
      return;
    }
    // Every frame, not just in load(): whatever set rig.mode since (the player's camera
    // setting can be hood), the menu always uses the far chase.
    this.app.rig.mode = 'far';
    this.acc += dt;
    this.time += dt;
    while (this.acc >= DT) {
      this.prev = this.pose();
      const ctl = this.race.phase === 'racing' ? this.bot.controls(this.race) : { steer: 0, gas: 0, brake: 0 };
      // A flip respawn (or restart) is a teleport: don't interpolate across it or swing the camera.
      if (this.race.step(ctl).some((e) => e.type === 'respawn')) {
        this.prev = this.pose();
        this.app.rig.reset();
      }
      this.acc -= DT;
    }
    if (this.race.phase === 'finished' && this.race.ticks > 0 && this.time > 3) {
      this.idx++;
      this.load();
      return;
    }
    if (this.time > 120) {
      this.idx++;
      this.load();
      return;
    }
    const c = this.race.car;
    this.car!.apply(this.prev, c, this.acc / DT);
    // The autopilot fires its nitro too: the same FOV kick as in a race.
    this.app.rig.boost = this.car!.boost;
    const r = this.car!.visual.root;
    this.app.rig.follow(
      { x: r.position.x, y: r.position.y, z: r.position.z },
      { x: r.quaternion.x, y: r.quaternion.y, z: r.quaternion.z, w: r.quaternion.w },
      c.vel,
      dt,
      null,
    );
    this.app.world.focusShadow(c.pos.x, c.pos.y, c.pos.z);
  }

  exit(): void {
    this.car?.dispose();
    this.car = null;
    this.app.rig.mode = this.app.store.settings.camera;
    this.app.rig.boost = 0;
  }
}

