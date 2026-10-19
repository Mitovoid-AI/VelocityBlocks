// Application shell: render loop, mode switching and the menu screens.

import { Ads } from '../ads/ads';
import { BannerSlot, blockForAd } from '../ads/adsUi';
import { GameAudio } from '../audio/audio';
import { DT } from '../core/constants';
import { Autopilot } from '../game/bot';
import { campaignAuthorTime, medalFor, medalTimes, MEDAL_COLORS } from '../game/medals';
import { formatTime, RaceSession } from '../game/race';
import { layoutHash, Store, STEER_MODES, type SavedTrack, type SteerMode } from '../game/storage';
import { campaignLocks } from '../game/unlocks';
import { edgeExclusionRects, gestureInsetVars, type GestureInsets } from '../input/edgeGuard';
import { Input, isTouchDevice, type Action, type ActionSource } from '../input/input';
import { TouchControls } from '../input/touchControls';
import { STEER_LABEL } from '../input/touchModel';
import { TouchWatch } from '../input/touchWatch';
import { deviceInfo, keepAwake, setGestureExclusion, watchGestureInsets, type DeviceInfo } from '../platform/native';
import { CameraRig } from '../render/cameraRig';
import { CarView, type CarViewOptions, type PoseSnapshot } from '../render/carView';
import { World } from '../render/world';
import { campaign } from '../track/campaign';
import { exportTrack, importTrack } from '../track/format';
import { Track, type TrackData } from '../track/track';
import { traceRoute } from '../track/route';
import { $, downloadText, esc, pickTextFile, showScreen, toast } from '../ui/dom';
import { Hud } from '../ui/hud';
import { EditorMode } from './editorMode';
import { isLongFrame, liftInside, type FocusDetail } from './pauseGuard';
import { homeCardHtml, showProfileScreen, type ProfileMode } from './profileScreen';
import { RaceMode, type RaceEntry } from './raceMode';
import { ReplayMode } from './replayMode';

/**
 * Built only inside the factory passed to App.setMode, after the previous mode has exited.
 * Constructors may set up the scene, HUD and touch controls. App.mode is null while the
 * previous mode exits and while the factory runs, so never read it there. A factory must not
 * call setMode or startRace.
 */
export interface Mode {
  update(dt: number): void;
  exit(): void;
  onAction?(a: Action, src?: ActionSource): void;
}

/** What profileScreen reports through App.profileChanged. */
export type ProfileChange = 'color' | 'body' | 'photo' | 'name' | 'badge';

/** The one-time toast on the first race on a touchscreen after the controls update. */
export const CONTROLS_TIP = 'New: steering wheel, tilt and pedal bars - change them in the pause menu';

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

  constructor(readonly ads: Ads = new Ads()) {
    const canvas = $<HTMLCanvasElement>('#view');
    this.world = new World(canvas);
    this.rig = new CameraRig(this.world.camera);
    this.world.setQuality(this.store.settings.quality);
    // Before applySettings, which lays the controls out. A race toast sits clear of the 3-2-1.
    this.touchCtl = new TouchControls($('#touch'), this.input, (msg) => toast(msg, 3000), () => this.syncEdgeGuard());
    this.applySettings();
    if (isTouchDevice()) document.body.classList.add('touch');

    window.addEventListener('resize', () => {
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
      this.mode?.update(dt);
      this.world.update(dt);
      this.world.render();
    }
    const racing = this.mode instanceof RaceMode && this.mode.isRacing;
    this.ads.gameplay(racing && !this.adPlaying);
    keepAwake(racing || this.mode instanceof ReplayMode);
    requestAnimationFrame((tt) => this.loop(tt));
  }

  /**
   * Android Back (from MainActivity): pause or resume a race (or ignore a back swipe made over the
   * controls, see RaceMode.back), otherwise press the screen's own way out. Returns false on the
   * main menu so the app goes to the background.
   */
  back(): boolean {
    try {
      if (this.mode instanceof RaceMode && this.mode.back(this.touches.recent(), performance.now())) return true;
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

  /** The player's car as the profile describes it: race, replay and the menu car all build it from this. */
  playerCarOptions(): CarViewOptions {
    const p = this.store.profile;
    return {
      color: p.carColor,
      body: p.carBody,
      avatar: p.showBadge ? { photo: this.store.profilePhoto(), ring: p.carColor } : null,
    };
  }

  /**
   * A profile value was saved. Only the menu car can be on screen while the profile is edited
   * (races and replays read the profile when they start). A colour is repainted in place; a body,
   * photo or badge change rebuilds the car. The name is not shown on the car.
   */
  profileChanged(kind: ProfileChange): void {
    const m = this.mode;
    if (!(m instanceof AttractMode) || kind === 'name') return;
    if (kind === 'color') m.setColor(this.store.profile.carColor);
    else m.refreshCar();
  }

  /** Garage view for the profile pages: the menu car parks and the camera orbits it, right of centre. */
  setGarageView(on: boolean): void {
    if (this.mode instanceof AttractMode) this.mode.setShowcase(on);
  }

  /**
   * Choose the touch steering (pause menu, Settings, profile Controls tab) and save it. Tilt is
   * kept only if the motion sensor answers: otherwise this says why and returns false, and the
   * steering stays as it was. Call it straight from the tap: iOS asks for motion permission then.
   */
  async setSteerMode(m: SteerMode): Promise<boolean> {
    const s = this.store.settings;
    if (m === 'tilt' && !(await this.input.requestTilt())) {
      toast('Tilt steering needs a motion sensor: none answered, or permission was denied.', 3200);
      this.applyControls();
      return false;
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
    i.tiltSensitivity = s.tiltSensitivity;
    i.tiltCenter = s.tiltCenter;
    // No permission prompt here (not from a tap): on iOS tilt then works once setSteerMode asked.
    i.setTilt(s.steerMode === 'tilt');
    this.touchCtl.setLayout({ steer: s.steerMode, pedals: s.pedals, autoGas: s.autoAccelerate });
    this.syncEdgeGuard();
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
    if (this.store.profile.setupDone) this.mainMenu();
    else this.profileScreen('setup', () => this.mainMenu());
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
       </div>`,
      'menu-main home with-banner',
      {
        profile: () => this.profileScreen('edit', () => this.mainMenu()),
        play: () => this.campaignMenu(),
        tracks: () => this.myTracks(),
        editor: () => this.openEditor(),
        settings: () => this.settingsMenu(() => this.mainMenu()),
        help: () => this.helpScreen(),
      },
    );
  }

  /** Setup page or profile editor over the menu car; it turns the garage view on itself. */
  profileScreen(mode: ProfileMode, back: () => void): void {
    this.ensureAttract();
    this.hud.show(false);
    this.showTouch(false);
    showProfileScreen(this, mode, back);
  }

  campaignMenu(): void {
    this.ensureAttract();
    const list = campaign();
    // A finish under an earlier physics version still unlocks the next track; PBs and medals
    // come from this version's records only. Browser builds can open the first locked track
    // with a rewarded ad.
    const locks = campaignLocks(
      list.map((ct) => `c:${ct.id}`),
      (k) => this.store.hasFinished(k),
      (k) => this.store.adUnlocked(k),
    );
    const canReward = this.ads.canReward();
    const cards = list
      .map((ct, idx) => {
        const key = `c:${ct.id}`;
        const rec = this.store.record(key);
        const at = campaignAuthorTime(ct.id);
        const medal = medalFor(rec?.best, at ? medalTimes(at) : null);
        const { locked } = locks[idx];
        const offer = locks[idx].unlockable && canReward;
        const name = ct.data.name.replace(/^\S+\s/, '');
        return `<button class="card ${locked ? 'locked' : ''} ${offer ? 'unlockable' : ''}" data-act="${offer ? 'unlock' : locked ? 'locked' : 'race'}" data-i="${idx}">
          <div><span class="id">${ct.id}</span><span class="series s-${ct.series}">${ct.series}</span></div>
          <div class="name">${esc(name)}</div>
          <div class="meta">${
            offer
              ? '<span class="ad-mark">AD</span>Watch an ad to unlock<br/>or finish the previous track'
              : locked
                ? '&#128274; Finish the previous track'
                : `${medal ? `<span class="medal" style="background:${MEDAL_COLORS[medal]}"></span>` : ''}PB ${rec ? formatTime(rec.best) : '--'}<br/>Author ${at ? formatTime(at) : '--'}`
          }</div>
        </button>`;
      })
      .join('');
    showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Campaign</h2></div>
       <div class="grid">${cards}</div>`,
      'dim with-banner',
      {
        back: () => this.mainMenu(),
        locked: () => toast('Finish the previous track to unlock this one.'),
        unlock: (el) => this.unlockOffer(Number(el.dataset.i)),
        race: (el) => this.playRace(this.campaignEntry(Number(el.dataset.i))),
      },
    );
  }

  /** Rewarded ad offer for a locked campaign track. Both choices look the same (portal rule). */
  private unlockOffer(i: number): void {
    const list = campaign();
    const ct = list[i];
    const prev = list[i - 1];
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

  campaignEntry(i: number): RaceEntry {
    const ct = campaign()[i];
    return {
      key: `c:${ct.id}`,
      data: ct.data,
      label: ct.data.name,
      authorTime: campaignAuthorTime(ct.id),
      campaignIndex: i,
    };
  }

  nextCampaignEntry(e: RaceEntry): RaceEntry | null {
    if (e.campaignIndex === undefined) return null;
    const n = e.campaignIndex + 1;
    return n < campaign().length ? this.campaignEntry(n) : null;
  }

  startRace(entry: RaceEntry): void {
    this.audio.unlock();
    this.setMode(() => new RaceMode(this, entry));
  }

  /**
   * Start a race at a natural break (a track picked from a menu, Next track): browser builds
   * may play an interstitial first. Retry, Restart and editor test drives use startRace.
   */
  async playRace(entry: RaceEntry): Promise<void> {
    if (this.ads.busy) return;
    this.audio.unlock(); // while the tap's user activation is still fresh
    await this.ads.interstitial();
    this.startRace(entry);
  }

  customEntry(data: TrackData, fromEditor = false, onFinish?: (t: number) => void): RaceEntry {
    return {
      key: `u:${layoutHash(data)}`,
      data,
      label: data.name,
      authorTime: data.authorTime ?? null,
      fromEditor,
      onFinish,
    };
  }

  myTracks(): void {
    this.ensureAttract();
    const tracks = this.store.customTracks();
    const items = tracks.length
      ? tracks
          .map((t) => {
            const rec = this.store.record(`u:${layoutHash(t.data)}`);
            const medal = medalFor(rec?.best, t.data.authorTime ? medalTimes(t.data.authorTime) : null);
            return `<div class="list-item">
              <div class="grow"><div class="title">${esc(t.data.name)}</div>
              <div class="muted">${t.data.blocks.length} blocks &middot; by ${esc(t.data.author)} &middot; Author ${t.data.authorTime ? formatTime(t.data.authorTime) : '--'} &middot; ${medal ? `<span class="medal" style="background:${MEDAL_COLORS[medal]}"></span>` : ''}PB ${rec ? formatTime(rec.best) : '--'}</div></div>
              <button class="btn small" data-act="play" data-id="${t.id}">Play</button>
              <button class="btn small" data-act="edit" data-id="${t.id}">Edit</button>
              <button class="btn small" data-act="export" data-id="${t.id}">Export</button>
              <button class="btn small" data-act="del" data-id="${t.id}">Delete</button>
            </div>`;
          })
          .join('')
      : '<div class="panel muted">No tracks yet. Build one in the Track editor, or import a track file.</div>';
    const find = (el: HTMLElement) => tracks.find((t) => t.id === el.dataset.id)!;
    showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>My tracks</h2><div class="spacer"></div>
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
   * Game settings. Name, car, camera, pedals, tilt and auto-accelerate live in the driver profile;
   * touchscreens also get the steering choice here, where it is easy to find.
   */
  settingsMenu(back: () => void): void {
    // Coming back from Edit driver profile: the menu car leaves the garage and laps again.
    this.setGarageView(false);
    const s = this.store.settings;
    const sel = (v: string, cur: string) => (v === cur ? 'selected' : '');
    // Buttons, not a drop-down, so a second-finger tap (pointerup routing in showScreen) works.
    const steer = isTouchDevice()
      ? `<label id="s-steer-l">Steering</label><div class="seg" role="group" aria-labelledby="s-steer-l">${STEER_MODES.map(
          (m) => `<button class="btn small ${m === s.steerMode ? 'sel' : ''}" data-act="steer" data-v="${m}" aria-pressed="${m === s.steerMode}">${STEER_LABEL[m]}</button>`,
        ).join('')}</div>`
      : '';
    const el = showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Settings</h2></div>
       <div class="panel"><div class="form">
         <label>Driver &amp; car</label><div><button class="btn small" data-act="profile">Edit driver profile</button></div>
         ${steer}
         <label for="s-q">Graphics quality</label>
         <select id="s-q"><option value="low" ${sel('low', s.quality)}>Low (fastest)</option><option value="medium" ${sel('medium', s.quality)}>Medium</option><option value="high" ${sel('high', s.quality)}>High</option></select>
         <label for="s-vol">Volume</label><input id="s-vol" type="range" min="0" max="1" step="0.05" value="${s.volume}"/>
         <label for="s-ghost">Show personal-best ghost</label><input id="s-ghost" type="checkbox" ${s.showGhost ? 'checked' : ''}/>
         <label>Progress</label><div><button class="btn small" data-act="reset">Reset records &amp; ghosts</button></div>
       </div></div>`,
      'dim',
      {
        back: () => {
          this.store.saveSettings();
          back();
        },
        profile: () => {
          this.store.saveSettings();
          this.profileScreen('edit', () => this.settingsMenu(back));
        },
        reset: () => {
          if (confirm('Reset all personal bests and ghosts? Your own tracks are kept.')) {
            this.store.resetProgress();
            toast('Records cleared');
          }
        },
        steer: (b) => {
          const m = STEER_MODES.find((x) => x === b.dataset.v);
          if (!m) return;
          const mark = (cur: SteerMode) =>
            el.querySelectorAll<HTMLElement>('[data-act="steer"]').forEach((x) => {
              x.classList.toggle('sel', x.dataset.v === cur);
              x.setAttribute('aria-pressed', String(x.dataset.v === cur));
            });
          mark(m);
          // Tilt may be refused (no sensor): show what was kept.
          void this.setSteerMode(m).then(() => mark(s.steerMode));
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
      s.quality = t.value as typeof s.quality;
      this.world.setQuality(s.quality);
    });
    on('#s-vol', 'input', (t) => {
      s.volume = Number(t.value);
      this.audio.setVolume(s.volume);
    });
    on('#s-ghost', 'change', (t) => (s.showGhost = t.checked));
  }

  helpScreen(): void {
    showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>How to play</h2></div>
       <div class="panel" style="max-width:760px">
         <p>Drive from <b>Start</b> to <b>Finish</b> as fast as you can. Pass through <b>every checkpoint</b> first, in any order. Medals are awarded against the author time; your best run is saved as a ghost to race against.</p>
         <p>You can leave the road and drive on the grass, but grass is slow. A checkpoint only counts when you drive through its gate, between the posts.</p>
         <div class="keys">
           <div><kbd>&uarr;</kbd> <kbd>W</kbd></div><div>Accelerate</div>
           <div><kbd>&darr;</kbd> <kbd>S</kbd> <kbd>Space</kbd></div><div>Brake / reverse. Tap it while steering at speed to drift.</div>
           <div><kbd>&larr;</kbd><kbd>&rarr;</kbd> <kbd>A</kbd><kbd>D</kbd></div><div>Steer</div>
           <div><kbd>Backspace</kbd> <kbd>R</kbd></div><div>Respawn at the last checkpoint (the clock keeps running)</div>
           <div><kbd>Enter</kbd> <kbd>Del</kbd></div><div>Restart the run</div>
           <div><kbd>C</kbd></div><div>Change camera</div>
           <div><kbd>G</kbd></div><div>Toggle ghost</div>
           <div><kbd>Esc</kbd> <kbd>P</kbd></div><div>Pause</div>
         </div>
         <p>If the car is stuck on its roof or side for 3 seconds it goes back to the last checkpoint by itself (or restarts if none has been passed).</p>
         <p>Downforce presses the car onto the road, so fast corners hold more grip than slow ones, and the steering lock eases off at speed. Brake in a straight line before the corner. Traction control trims the power when you ask for too much out of a slow corner; set it to Low in your driver profile (Controls) to let the rear wheels spin. Turn on the <b>racing line</b> in the pause menu: green is full throttle, yellow is lift, red is brake.</p>
         <p class="muted">Gamepad: left stick to steer, RT to accelerate, LT/B to brake, Y to respawn, Back to restart.</p>
         <p class="muted">Phones and tablets: steer with the arrow buttons, a steering wheel or by tilting the device; pick one in the pause menu (Steering), in Settings or in your driver profile. The gas and brake bars are analog: a light touch on the gas gives a third of the power, and above the dashed line it is full. Any touch on the brake is strong enough for the drift (tap it while steering at speed); higher up it brakes harder. Your driver profile (tap your card on the home screen) also has your photo, name and car, the starting camera, round on/off pedals, tilt sensitivity and auto-accelerate. Cam changes the camera; the ghost and racing line toggles are in the pause menu. During a race, Back swipes that start on the controls are ignored, so tap the pause button to pause. In the track editor, drag to pan, pinch to zoom, and twist two fingers or hold the turn arrows to turn the view.</p>
         <p class="muted">Green pads give a boost and red pads a turbo. Jumps need speed!</p>
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
class AttractMode implements Mode {
  private race!: RaceSession;
  private bot!: Autopilot;
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

  private load(): void {
    const ct = campaign()[this.idx % campaign().length];
    const track = new Track(ct.data);
    this.app.world.setTrack(track);
    this.race = new RaceSession(track);
    this.bot = new Autopilot(track);
    this.refreshCar();
    this.prev = this.pose();
    this.app.rig.mode = 'far';
    this.app.rig.reset();
    this.time = 0;
    // Sanity: a broken route would leave the bot stuck; skip such a track.
    if (!traceRoute(track).complete) this.idx++;
  }

  /** Rebuild the car from the profile (body style, photo badge). update() poses it before the next render. */
  refreshCar(): void {
    this.car?.dispose();
    this.car = new CarView(this.app.world.scene, this.app.playerCarOptions());
  }

  /** Repaint in place (the badge ring follows): a colour change needs no rebuild. */
  setColor(c: string): void {
    this.car?.setColor(c);
  }

  setShowcase(on: boolean): void {
    if (on === this.showcase) return;
    this.showcase = on;
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
  }
}

