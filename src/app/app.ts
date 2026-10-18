// Application shell: render loop, mode switching and the menu screens.

import { Ads } from '../ads/ads';
import { BannerSlot, blockForAd } from '../ads/adsUi';
import { GameAudio } from '../audio/audio';
import { DT } from '../core/constants';
import { Autopilot } from '../game/bot';
import { campaignAuthorTime, medalFor, medalTimes, MEDAL_COLORS } from '../game/medals';
import { formatTime, RaceSession } from '../game/race';
import { layoutHash, Store, type SavedTrack } from '../game/storage';
import { campaignLocks } from '../game/unlocks';
import { Input, isTouchDevice, type Action } from '../input/input';
import { keepAwake } from '../platform/native';
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
  onAction?(a: Action): void;
}

/** What profileScreen reports through App.profileChanged. */
export type ProfileChange = 'color' | 'body' | 'photo' | 'name' | 'badge';

export class App {
  readonly world: World;
  readonly rig: CameraRig;
  readonly input = new Input();
  readonly audio = new GameAudio();
  readonly store = new Store();
  readonly hud = new Hud();
  private mode: Mode | null = null;
  private last = 0;
  private editor: EditorMode | null = null;
  /** An ad is on screen: the loop stops updating and rendering. */
  private adPlaying = false;

  constructor(readonly ads: Ads = new Ads()) {
    const canvas = $<HTMLCanvasElement>('#view');
    this.world = new World(canvas);
    this.rig = new CameraRig(this.world.camera);
    this.world.setQuality(this.store.settings.quality);
    this.applySettings();
    if (isTouchDevice()) document.body.classList.add('touch');

    window.addEventListener('resize', () => this.world.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.world.resize(), 200));
    const autoPause = () => {
      if (this.mode instanceof RaceMode) this.mode.setPaused(true);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        autoPause();
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });
    // Sent by MainActivity when the window loses focus without the page being hidden:
    // notification shade, assistant overlay, a dialog from another app.
    window.addEventListener('vb-focuslost', autoPause);
    (window as unknown as { vbBack: () => boolean }).vbBack = () => this.back();
    // Audio needs a user gesture to start (mobile browsers, WebViews).
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.input.onAction((a) => this.mode?.onAction?.(a));
    this.bindTouch();
    this.bindAds();

    requestAnimationFrame((t) => this.loop(t));
  }

  private loop(t: number): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60;
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
   * Android Back (from MainActivity): pause or resume a race, otherwise press the screen's
   * own way out. Returns false on the main menu so the app goes to the background.
   */
  back(): boolean {
    if (this.mode instanceof RaceMode && this.mode.back()) return true;
    const exit = document.querySelector<HTMLElement>(
      '#screens [data-act="back"], #screens [data-act="exit"], #screens [data-act="menu"]',
    );
    if (!exit) return false;
    exit.click();
    return true;
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

  /** Tilt steering switch (profile Controls tab). Unchecks `t` and says why when sensors are denied. */
  async toggleTilt(t: HTMLInputElement): Promise<void> {
    const s = this.store.settings;
    // enableTilt is called before anything is awaited, so iOS still counts the tap as the
    // user gesture its motion permission prompt needs.
    const ok = await this.input.enableTilt(t.checked);
    if (t.checked && !ok) {
      t.checked = false;
      toast('Motion sensors are not available or permission was denied.');
    }
    s.tilt = t.checked && ok;
    this.store.saveSettings();
  }

  applySettings(): void {
    const s = this.store.settings;
    this.audio.setVolume(s.volume);
    this.input.autoAccelerate = s.autoAccelerate;
    this.input.tiltEnabled = s.tilt;
    this.rig.mode = s.camera;
  }

  showTouch(v: boolean): void {
    $('#touch').classList.toggle('hidden', !(v && isTouchDevice()));
    if (!v) this.releasePads();
  }

  private releasePads: () => void = () => this.input.clearTouch();

  private bindTouch(): void {
    const root = $('#touch');
    type Pad = 'left' | 'right' | 'gas' | 'brake';
    const pads = [...root.querySelectorAll<HTMLButtonElement>('.t-btn')];
    // Which pad each finger is on. A finger can slide from one pad onto another (left to
    // right, gas to brake); sliding off onto empty space keeps the last pad held.
    const held = new Map<number, Pad>();
    const sync = () => {
      const on = new Set(held.values());
      for (const b of pads) {
        const k = b.dataset.t as Pad;
        this.input.setTouch(k, on.has(k));
        b.classList.toggle('active', on.has(k));
      }
    };
    this.releasePads = () => {
      held.clear();
      sync();
    };
    const padAt = (x: number, y: number): Pad | undefined =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>('#touch .t-btn')?.dataset.t as Pad | undefined;
    for (const b of pads) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        held.set(e.pointerId, b.dataset.t as Pad);
        sync();
      });
      // Cancelling touchstart stops Android's long-press gesture, which otherwise buzzes
      // the phone (and may open a context menu) about half a second into every held pad.
      b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('pointermove', (e) => {
      // A touch that is not on a pad yet joins one it moves over: the gas thumb that stayed
      // down through the pause menu takes hold again right after Resume.
      if (!held.has(e.pointerId) && e.pointerType !== 'touch') return;
      const k = padAt(e.clientX, e.clientY);
      if (k && k !== held.get(e.pointerId)) {
        held.set(e.pointerId, k);
        sync();
      }
    });
    const lift = (e: PointerEvent) => {
      if (held.delete(e.pointerId)) sync();
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    // The pills act on touch-down: Android generates no click for a tap made while another
    // finger is down, and during a race a thumb is almost always on gas or steering.
    root.querySelectorAll<HTMLButtonElement>('.t-small').forEach((b) => {
      const act = () => this.mode?.onAction?.(b.dataset.a as Action);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        act();
      });
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

  /** Game settings. Name, car, camera, tilt and auto-accelerate live in the driver profile. */
  settingsMenu(back: () => void): void {
    // Coming back from Edit driver profile: the menu car leaves the garage and laps again.
    this.setGarageView(false);
    const s = this.store.settings;
    const sel = (v: string, cur: string) => (v === cur ? 'selected' : '');
    const el = showScreen(
      `<div class="header"><button class="btn small" data-act="back">&#8592; Back</button><h2>Settings</h2></div>
       <div class="panel"><div class="form">
         <label>Driver &amp; car</label><div><button class="btn small" data-act="profile">Edit driver profile</button></div>
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
         <p class="muted">Gamepad: left stick to steer, RT to accelerate, LT/B to brake, Y to respawn, Back to restart. On phones and tablets use the on-screen buttons (Cam changes the camera; the ghost toggle is in the pause menu). Tap your driver card on the home screen to change your photo, name and car, the starting camera, tilt steering and auto-accelerate. In the track editor, drag to pan, pinch to zoom, and twist two fingers or hold the turn arrows to turn the view.</p>
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

