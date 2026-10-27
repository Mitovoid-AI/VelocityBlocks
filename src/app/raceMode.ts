// Playing a track: fixed-step simulation, HUD, ghost, pause and results.

import { DT } from '../core/constants';
import { entryKey, VEHICLE_LABEL, type VehicleClass } from '../core/vehicles';
import { ghostPose, newGhostPose, type Ghost } from '../game/ghost';
import { MEDAL_COLORS, MEDAL_NAMES, medalFor, medalTimes, type MedalTimes } from '../game/medals';
import type { ProPilot } from '../game/proDriver';
import { drivenLineData } from '../game/drivenLine';
import { autoChase, GhostDelta, RouteProgress } from '../game/ghostDelta';
import { proGhostJob, proLapFor, proPilot, stretchGhost } from '../game/proLaps';
import { traceRoute } from '../track/route';
import * as THREE from 'three';
import { FLIP_RESPAWN_TICKS, FLIP_WARN_TICKS, quantise, RaceSession, type RaceEvent } from '../game/race';
import { lineJobs, type RacingLineData } from '../game/racingLine';
import { CHASE_TARGETS, type ChaseTarget, type Settings } from '../game/storage';
import { isTouchDevice, type Action, type ActionSource } from '../input/input';
import { nextSteerMode, STEER_LABEL } from '../input/touchModel';
import type { SysCancel } from '../input/touchWatch';
import { assistsFor, forwardOf, NO_CONTROLS, speedOf, type Assists, type Controls } from '../physics/vehicle';
import { GHOST_FADE_FAR, GHOST_FADE_NEAR } from '../render/avatar';
import { CAM_MODES } from '../render/cameraRig';
import { CarView, Smoke, vehicleFx, type PoseSnapshot, type VehicleFx } from '../render/carView';
import { RacingLineView, warmRacingLine } from '../render/racingLine';
import { Track, type TrackData } from '../track/track';
import { clearScreen, esc, prefersReducedMotion, showScreen, toast } from '../ui/dom';
import { nitroView } from '../ui/nitroView';
import { ScoreClock, scoreCardHtml, scoreModel } from '../ui/scoreCard';
import { ScoreCardView } from '../ui/scoreCardView';
import type { App, Mode } from './app';
import { AUTHOR_WALLS_NOTE, authorTimeAfter } from './authorTime';
import { backOutcome, diagLine, pauseWhy, SWALLOW_HINT, type FocusDetail, type PauseReason } from './pauseGuard';
import { ghostYawRate, ReplayMode } from './replayMode';

const GHOST_COLOR = '#7fd3ff';

export interface RaceEntry {
  /** Key for records, ghosts and medals: entryKey(base, vehicle, walls). */
  key: string;
  /** The track's own key ('c:A01', 'u:<layout hash>'): unlocks are shared by every vehicle and wall mode. */
  base: string;
  /** Vehicle class for the whole run (Retry, Replay and Next track keep it). */
  vehicle: VehicleClass;
  /** Settings > Walls on all roads, as it was when the track was picked. */
  walls: boolean;
  data: TrackData;
  label: string;
  /** This vehicle class's author time (shared by both wall modes). */
  authorTime: number | null;
  /** Campaign position: enables "Next track", and quitting goes to the campaign menu (else My tracks). */
  campaignIndex?: number;
  /** Return to the editor instead of the menu. */
  fromEditor?: boolean;
  /** A shared run raced as a ghost (App.openSharedRun): chased unless another target is picked. */
  rival?: { ghost: Ghost; name: string };
  /** Editor test drives: this run set or lowered the class's author time (walls-off runs only, see authorTimeAfter). */
  onAuthorTime?: (time: number) => void;
}

/** The racing line's key: the class's line, the same in both wall modes (lines are open-road lines). */
export const lineKeyOf = (e: RaceEntry): string => entryKey(e.base, e.vehicle, false);

/**
 * Read-only tags for the results card and (`short`) the HUD's track line: the vehicle class (not the
 * car) and the wall mode. The HUD's are short so the line stays clear of the race pills at 640 px.
 */
export function entryTags(e: RaceEntry, short = false): string[] {
  const t: string[] = [];
  if (e.vehicle !== 'car') t.push(VEHICLE_LABEL[e.vehicle]);
  if (e.walls) t.push(short ? 'Walls' : 'Walls on');
  return t;
}

/**
 * The analog steering assist (a quicker steering rack, assistsFor) for a run: on a touchscreen,
 * with settings.analogSteer, steering with the wheel or with tilt whose sensor answers (a tilt run
 * that fell back to the buttons keeps the buttons' rack). Keys, buttons and the autopilot never get it.
 */
export function analogSteerFor(s: Pick<Settings, 'analogSteer' | 'steerMode'>, touch: boolean, tiltLive: boolean): boolean {
  return s.analogSteer && touch && (s.steerMode === 'wheel' || (s.steerMode === 'tilt' && tiltLive));
}

/** Pause > Recentre tilt takes the device's roll this long after the tap, once the tap's jolt has settled. */
export const RECENTRE_SETTLE_MS = 350;

/**
 * `?autoplay` in the address: the pro driver (game/proDriver.ts) drives every race instead of the player,
 * with its tuned settings on campaign tracks. For testing on devices and emulators (App exposes window.vbTest).
 */
export const AUTOPLAY = typeof location !== 'undefined' && /[?&]autoplay\b/.test(location.search);
/** `?autoplay=base`: the untuned pro driver (slower than the author lap), to watch it chase the medal ghosts. */
const AUTOPLAY_BASE = typeof location !== 'undefined' && /[?&]autoplay=base\b/.test(location.search);

/** A shared run's ghost (App.openSharedRun). */
const SHARED_TAG_COLOR = '#ff9d2e';
/** The personal-best ghost's tag colour (its car is the ghost blue). */
const PB_TAG_COLOR = '#7fd8ff';
/** Ghost tags float this high (m) over the ghost car. */
const TAG_LIFT = 2.2;
/** Screen margin (CSS px) of tags pinned to the edge, and the spacing of stacked ones. */
const TAG_EDGE = 28;
const TAG_STACK = 24;
/** Tags of ghosts behind the camera sit this far (CSS px) from the top, under the race pills and split. */
const TAG_BEHIND_Y = 165;

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A ghost raced against: its tag, its car (none while the PB ghost's own car stands in), and its time gaps. */
interface Rival {
  key: Exclude<ChaseTarget, 'auto'> | 'pro' | 'shared';
  name: string;
  color: string;
  ghost: Ghost;
  delta: GhostDelta;
}


/** Milliseconds per frame the pro ghost lap may take while it is worked out (during the countdown, mostly). */
const PRO_JOB_MS = 4;

/** Walls on all roads: seconds on the grass (outside the walls) before the HUD says how to get back. */
export const OUTSIDE_HINT_S = 1.5;

/** The HUD hint for a car outside the walls: Respawn (the touch CP pill, R or Y) restarts before the first checkpoint. */
export function outsideWallsHint(touch: boolean, toStart: boolean): string {
  return `Outside the walls: ${touch ? 'tap CP' : 'press R'} to ${toStart ? 'restart' : 'respawn'}`;
}

export class RaceMode implements Mode {
  readonly track: Track;
  race: RaceSession;
  private car: CarView;
  private ghostCar: CarView | null = null;
  private smoke: Smoke;
  private prev: PoseSnapshot;
  private acc = 0;
  private paused = false;
  private pbGhost: Ghost | null;
  private pbSplits: number[] | null;
  /** This session's PB ghost when storage could not keep it (full): Retry races it all the same. */
  private sessionGhost: Ghost | null = null;
  private medals: MedalTimes | null;
  private resultsShown = false;
  /** The results card's reveal, while the results are up. */
  private card: ScoreClock | null = null;
  /** Where this class's tyre smoke comes from, and how close the PB ghost may get. */
  private readonly fx: VehicleFx;
  private finishDelay = 0;
  /** Frame counter: grass dust is emitted every other frame. */
  private dustFrame = 0;
  /** When the current stretch of racing, pause or results began (performance.now() ms), for the Back rules. */
  private phaseSince = 0;
  private lastBackAt = -Infinity;
  /** Diagnostics for the pause screen, counted from when the track was opened (restarts included). */
  private swallowedBacks = 0;
  private flipRespawns = 0;
  private framesAtStart = 0;
  private cancelsAtStart = 0;
  /** The pause menu's Steering row is checking for a tilt sensor. */
  private steerBusy = false;
  /** The racing line on the road, once lineJobs has it for this track (settings.racingLine). */
  private lineView: RacingLineView | null = null;
  private lineCancel: (() => void) | null = null;
  /** False after exit(): a line that arrives later is dropped. */
  private alive = true;
  /** The controls of the last physics step (the engine note follows them; read() is called once per step). */
  private lastCtl: Controls = NO_CONTROLS;
  /** The nitro was pressed during the 3-2-1: the button glows until it fires at GO. */
  private nitroArmed = false;
  /** Walls on all roads: seconds the car has been on the grass, and the hint was shown since the last (re)spawn. */
  private grassFor = 0;
  private outsideHinted = false;
  private readonly touch = isTouchDevice();
  /** The ghost's pose now and one tick back, reused every frame. */
  private readonly ghostAt = newGhostPose();
  private readonly ghostBack = newGhostPose();
  /** Medal ghosts (settings.medalGhosts): the pro driver's lap, stretched to each medal time, one car each. */
  private medalCars: { car: CarView; ghost: Ghost; label: string }[] = [];
  /** The pro lap being driven for them, a slice per frame; null when done or not wanted. */
  private proJob: Generator<void, Ghost | null> | null = null;
  /** The pro lap, once driven (null: none for this track). */
  private proGhost: Ghost | null | undefined = undefined;
  /** AUTOPLAY's driver. */
  private pilot: ProPilot | null = null;
  /** The target ghost's line on the road, for the whole lap (makeMedalCars). */
  private targetLine: RacingLineView | null = null;
  /** Every ghost raced against (PB, medals, pro), for the tags and the live gap. */
  private rivals: Rival[] = [];
  /** The player's place along the centre line, for the gaps. */
  private readonly progress: RouteProgress;
  /** Gaps (ms) to the chased ghost at each checkpoint passed this run, the latest first. */
  private deltaLog: number[] = [];
  private cpSeen = 0;
  private readonly tagVec = new THREE.Vector3();

  constructor(
    private readonly app: App,
    private readonly entry: RaceEntry,
  ) {
    this.phaseSince = performance.now();
    this.framesAtStart = app.longFrames;
    this.cancelsAtStart = app.touches.bursts;
    this.track = new Track(entry.data, { walls: entry.walls });
    app.world.setTrack(this.track);
    this.race = new RaceSession(this.track, this.assists(), entry.vehicle);
    this.car = new CarView(app.world.scene, app.playerCarOptions(entry.vehicle));
    this.fx = vehicleFx(entry.vehicle);
    this.smoke = new Smoke(app.world.scene);
    this.prev = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } };
    this.snapPrev();
    this.pbGhost = app.store.ghost(entry.key);
    this.pbSplits = app.store.record(entry.key)?.cpTimes ?? null;
    this.medals = entry.authorTime ? medalTimes(entry.authorTime) : null;
    this.progress = new RouteProgress(traceRoute(this.track));
    this.makeGhostCar();
    this.syncMedalGhosts();
    if (AUTOPLAY) this.pilot = proPilot(this.track, entry.vehicle, AUTOPLAY_BASE ? null : (proLapFor(entry.base, entry.vehicle)?.params ?? null));
    app.rig.mode = app.store.settings.camera;
    app.rig.vehicle = entry.vehicle;
    app.rig.reset();
    app.audio.setVoice(entry.vehicle);
    clearScreen();
    // Safe: App.setMode has already run the previous mode's exit(), which hides these.
    app.hud.show(true);
    app.showTouch(true);
    app.input.enabled = true;
    // A nitro pressed on the menus is not this run's.
    app.input.clearNitroPress();
    this.refreshHud();
    app.showControlsTip();
    // Compiled now, during the countdown, so a line that arrives mid-race never stalls a frame.
    if (app.store.settings.racingLine) warmRacingLine(app.world.renderer, app.world.scene, app.world.camera, app.world.compileTarget);
    this.syncLine();
  }

  /**
   * Traction control from the profile (auto-accelerate always races on 'normal'), and the analog
   * steering rack for wheel and tilt runs (analogSteerFor). Like traction control, it is applied when
   * a run starts or restarts, and records are shared with button runs.
   */
  private assists(): Readonly<Assists> {
    const s = this.app.store.settings;
    return assistsFor(s.tractionControl, s.autoAccelerate, analogSteerFor(s, this.touch, this.app.input.tiltLive));
  }

  /** Show or drop the racing line to match settings.racingLine. Campaign lines are precomputed; others are worked out in slices. */
  private syncLine(): void {
    const s = this.app.store.settings;
    if (!s.racingLine) {
      this.lineCancel?.();
      this.lineCancel = null;
      this.lineView?.dispose();
      this.lineView = null;
      return;
    }
    if (this.lineView || this.lineCancel) return;
    // Peek first: request() calls back synchronously on a cache hit.
    const key = lineKeyOf(this.entry);
    const cached = lineJobs.peek(key);
    if (cached !== undefined) return this.showLine(cached);
    this.lineCancel = lineJobs.request(key, this.track, (d) => {
      this.lineCancel = null;
      if (this.alive && this.app.store.settings.racingLine) this.showLine(d);
    });
  }

  /** null: this track has no line (the pause menu says n/a); no toast mid-race. */
  private showLine(d: RacingLineData | null): void {
    if (!d) return;
    // Auto-accelerate can't lift, so yellow would ask for something the player cannot do.
    this.lineView = new RacingLineView(d, { liftAsThrottle: this.app.store.settings.autoAccelerate });
    this.lineView.attach(this.app.world.scene);
  }

  private toggleLine(): void {
    const s = this.app.store.settings;
    s.racingLine = !s.racingLine;
    this.app.store.saveSettings();
    if (s.racingLine) warmRacingLine(this.app.world.renderer, this.app.world.scene, this.app.world.camera, this.app.world.compileTarget);
    this.syncLine();
  }

  private lineLabel(): string {
    if (!this.app.store.settings.racingLine) return 'Racing line: off';
    return lineJobs.peek(lineKeyOf(this.entry)) === null ? 'Racing line: n/a' : 'Racing line: on';
  }

  private makeGhostCar(): void {
    this.ghostCar?.dispose();
    this.ghostCar = null;
    this.buildRivals();
    if (this.pbGhost && this.app.store.settings.showGhost && this.chaseKey() === 'pb' && !this.entry.rival) {
      // The ghost is "you": the player's body and photo, in ghost blue with a dimmed badge.
      // Records and ghosts are kept per class, so the ghost is the same vehicle.
      const p = this.app.playerCarOptions(this.entry.vehicle);
      this.ghostCar = new CarView(this.app.world.scene, {
        color: GHOST_COLOR,
        ghost: true,
        vehicle: this.entry.vehicle,
        body: p.body,
        model: p.model,
        avatar: p.avatar ? { photo: p.avatar.photo, ring: GHOST_COLOR, dim: true } : null,
      });
    }
  }

  /** The interpolation's previous pose := the car's pose now (copied into the same objects: once per physics step). */
  private snapPrev(): void {
    const { pos, rot } = this.race.car;
    const p = this.prev;
    p.pos.x = pos.x;
    p.pos.y = pos.y;
    p.pos.z = pos.z;
    p.rot.x = rot.x;
    p.rot.y = rot.y;
    p.rot.z = rot.z;
    p.rot.w = rot.w;
  }

  private refreshHud(): void {
    const best = this.app.store.record(this.entry.key)?.best ?? null;
    this.app.hud.setTrack(this.entry.label, best, this.medals, this.track.checkpointCount, entryTags(this.entry, true));
  }

  restart(): void {
    // Retry, Restart and the restart key replay this entry: if it needs the Full Game now (refunded, or the
    // debug builds' dev switch), the Full Game screen opens instead (App.blockLocked leaves this mode).
    if (this.app.blockLocked(this.entry)) return;
    if (this.resultsShown || this.race.phase === 'finished') {
      // Retry after a finish (also a Restart in the 1.4 s before the results card): that run may have set
      // a new PB, so race its ghost and splits. A PB ghost storage could not keep is raced from memory.
      this.pbGhost = this.sessionGhost ?? this.app.store.ghost(this.entry.key);
      this.pbSplits = this.app.store.record(this.entry.key)?.cpTimes ?? null;
      this.makeGhostCar();
    }
    // A settings change since the last run (traction control, auto-accelerate) applies from here.
    this.race.assists = this.assists();
    this.race.restart();
    this.pilot?.reset();
    this.progress.reset();
    this.targetLine?.resetTracking();
    this.deltaLog = [];
    this.cpSeen = 0;
    this.app.input.clearNitroPress();
    this.nitroArmed = false;
    this.grassFor = 0;
    this.outsideHinted = false;
    this.lastCtl = NO_CONTROLS;
    this.lineView?.resetTracking();
    this.snapPrev();
    this.acc = 0;
    this.resultsShown = false;
    this.card = null; // its DOM goes with the screen
    this.finishDelay = 0;
    this.paused = false;
    this.phaseSince = performance.now();
    this.smoke.clear();
    this.app.rig.reset();
    this.app.hud.clearMessages();
    this.app.hud.show(true);
    this.app.showTouch(true);
    clearScreen();
    this.refreshHud();
  }

  onAction(a: Action, src: ActionSource = 'touch'): void {
    if (a === 'pause') {
      // On the results, Esc / P and the controller's Start skip the card's reveal.
      if (this.resultsShown) return void this.card?.skip();
      // Esc / P and the controller's Start still toggle, as desktop and controller players expect.
      this.setPaused(!this.paused, src === 'key' ? 'key' : src === 'gamepad' ? 'gamepad' : 'button');
      return;
    }
    if (this.paused) return;
    if (a === 'nitro') return this.nitroPressed();
    if (a === 'restart') {
      if (this.resultsShown) this.app.audio.click();
      this.restart();
    } else if (a === 'respawn') {
      if (this.race.phase === 'finished') return;
      // handle() resets the interpolation and camera, as for automatic flip respawns.
      this.handle(this.race.respawn());
    } else if (a === 'camera') {
      const i = CAM_MODES.indexOf(this.app.rig.mode);
      this.app.rig.mode = CAM_MODES[(i + 1) % CAM_MODES.length];
      this.app.store.settings.camera = this.app.rig.mode;
      this.app.store.saveSettings();
    } else if (a === 'ghost') {
      this.toggleGhost();
      const msg = this.app.store.settings.showGhost ? 'Ghost on' : 'Ghost off';
      // The HUD is hidden under the results card.
      if (this.resultsShown) toast(msg, 900);
      else this.app.hud.message(msg, 900);
    }
  }

  /**
   * A nitro press (key, controller, touch), for feedback only: the press itself reaches the race
   * through Input.read() on the next step. In the 3-2-1 the button glows until it fires at GO; while
   * it recharges the button shakes and buzzes (a press during the push is ignored quietly).
   */
  private nitroPressed(): void {
    if (this.resultsShown || this.race.phase === 'finished') return;
    if (this.race.phase === 'countdown') {
      this.nitroArmed = true;
      return;
    }
    const c = this.race.car;
    if (c.nitroTime === 0 && c.nitroCooldown > 0) {
      this.app.hud.nitroDeny();
      this.app.audio.deny();
    }
  }

  private toggleGhost(): void {
    this.app.store.settings.showGhost = !this.app.store.settings.showGhost;
    this.app.store.saveSettings();
    this.makeGhostCar();
  }

  private ghostLabel(): string {
    return this.app.store.settings.showGhost ? 'Ghost: on' : 'Ghost: off';
  }

  /** Show or drop the medal ghosts to match settings.medalGhosts (tracks with an author time only). */
  private syncMedalGhosts(): void {
    if (!this.medals) return;
    if (this.proGhost === undefined) {
      // The pro lap is driven whatever the setting: it is the author lap (gaps, tags, its replay).
      // Driven on the open-road track, as it was tuned: the same lap, tick for tick, as the stored one.
      const { base, vehicle, data } = this.entry;
      const lap = proLapFor(base, vehicle);
      if (lap && !this.proJob) this.proJob = proGhostJob(new Track(data), vehicle, lap.params);
      if (!lap) this.proGhost = null;
      return;
    }
    this.makeMedalCars();
  }

  /** A slice of the pro lap per frame, PRO_JOB_MS at most; the medal cars appear when it is done. */
  private pumpProJob(): void {
    if (!this.proJob) return;
    const t0 = performance.now();
    while (performance.now() - t0 < PRO_JOB_MS) {
      const r = this.proJob.next();
      if (!r.done) continue;
      this.proJob = null;
      this.proGhost = r.value;
      this.makeMedalCars();
      return;
    }
  }

  /**
   * The target ghost (settings.medalGhosts): one car in its medal colour (the PB's is the player-look ghost car,
   * makeGhostCar) and its line on the road for the whole lap, coloured by what it does there, to follow.
   */
  private makeMedalCars(): void {
    this.disposeMedalCars();
    this.buildRivals();
    const t = this.rivals[0];
    if (!t || !this.app.store.settings.medalGhosts) return;
    if (t.key !== 'pb') {
      const car = new CarView(this.app.world.scene, { color: t.color, ghost: true, vehicle: this.entry.vehicle, avatar: null });
      this.medalCars.push({ car, ghost: t.ghost, label: t.name });
    }
    // A medal ghost is the pro lap slowed down: the same line, so it is drawn from the pro lap (its own inputs).
    const src = t.key === 'gold' || t.key === 'author' || t.key === 'silver' || t.key === 'bronze' ? this.proGhost : t.ghost;
    const d = src ? drivenLineData(src) : null;
    if (d) {
      this.targetLine = new RacingLineView(d, { reach: Infinity, liftAsThrottle: this.app.store.settings.autoAccelerate });
      this.targetLine.attach(this.app.world.scene);
    }
  }

  private disposeMedalCars(): void {
    for (const m of this.medalCars) m.car.dispose();
    this.medalCars = [];
    this.targetLine?.dispose();
    this.targetLine = null;
  }

  /**
   * The ghost to race against, one at a time: a shared run when racing one, else the chase target (Gold until
   * gold is won, then the Author, then the PB; or the pause menu's pick), else whichever of those exists.
   */
  private buildRivals(): void {
    const route = this.progress.route;
    const out: Rival[] = [];
    const s = this.app.store.settings;
    const sr = this.entry.rival;
    if (sr) out.push({ key: 'shared', name: sr.name, color: SHARED_TAG_COLOR, ghost: sr.ghost, delta: new GhostDelta(route, sr.ghost) });
    if (this.pbGhost && s.showGhost) out.push({ key: 'pb', name: 'PB', color: PB_TAG_COLOR, ghost: this.pbGhost, delta: new GhostDelta(route, this.pbGhost) });
    const g = this.proGhost;
    const m = this.medals;
    if (g && m) {
      const tiers: [Rival['key'], number, string, string][] = [
        ['author', m.author, MEDAL_COLORS[4], MEDAL_NAMES[4]],
        ['gold', m.gold, MEDAL_COLORS[3], MEDAL_NAMES[3]],
        ['silver', m.silver, MEDAL_COLORS[2], MEDAL_NAMES[2]],
        ['bronze', m.bronze, MEDAL_COLORS[1], MEDAL_NAMES[1]],
      ];
      for (const [key, time, color, name] of tiers) {
        const sg = stretchGhost(g, time);
        out.push({ key, name, color, ghost: sg, delta: new GhostDelta(route, sg) });
      }
    }
    this.rivals = out;
    const t = this.chased();
    this.rivals = t ? [t] : [];
  }

  /** The chased ghost's key: the setting, or for 'auto' the next goal (autoChase). */
  private chaseKey(): Exclude<ChaseTarget, 'auto'> {
    const c = this.app.store.settings.chase;
    if (c !== 'auto') return c;
    return autoChase(this.app.store.record(this.entry.key)?.best ?? null, this.medals);
  }

  /** The chased rival: the chosen one, else Gold, the Author or the PB, whichever exists. */
  private chased(): Rival | null {
    const shared = this.rivals.find((x) => x.key === 'shared');
    if (shared && this.app.store.settings.chase === 'auto') return shared;
    const want = this.chaseKey();
    for (const k of [want, 'gold', 'author', 'pb'] as const) {
      const r = this.rivals.find((x) => x.key === k);
      if (r) return r;
    }
    return null;
  }

  /** Every frame: the live gap and checkpoint log against the chased ghost, and a tag on every ghost. */
  private updateRivals(): void {
    const hud = this.app.hud;
    const target = this.chased();
    const racing = this.race.phase !== 'countdown';
    const now = this.race.phase === 'finished' ? this.race.finishTime! : this.race.timeMs;
    const gap = (r: Rival) => (racing ? now - r.delta.timeAt(this.progress.s) : 0);
    // A checkpoint passed since last frame: log the gap there (the ghost's own split, so it is exact).
    while (target && this.cpSeen < this.race.cpTimes.length) {
      const t = this.race.cpTimes[this.cpSeen];
      const g = target.ghost.cpTimes[this.cpSeen];
      this.deltaLog.unshift(g !== undefined ? t - g : gap(target));
      this.cpSeen++;
    }
    hud.setDelta(target && !this.resultsShown ? { name: target.name, color: target.color } : null, target ? gap(target) : 0, this.deltaLog);
    // Tags: projected over each ghost; off screen or behind the camera, pinned to the nearest edge (behind: the bottom).
    const cam = this.app.world.camera;
    const w = this.app.world.renderer.domElement.clientWidth;
    const h = this.app.world.renderer.domElement.clientHeight;
    const tick = racing ? this.race.ticks + (this.paused ? 1 : this.acc / DT) : 0;
    let stacked = 0;
    const tags = this.resultsShown
      ? []
      : this.rivals.map((r) => {
          const p = ghostPose(r.ghost, tick, this.ghostAt);
          const v = this.tagVec.set(p?.pos.x ?? 0, (p?.pos.y ?? 0) + TAG_LIFT, p?.pos.z ?? 0);
          const behind = v.clone().applyMatrix4(cam.matrixWorldInverse).z > 0;
          v.project(cam);
          let x = ((v.x + 1) / 2) * w;
          let y = ((1 - v.y) / 2) * h;
          let edge = behind || x < TAG_EDGE || x > w - TAG_EDGE || y < TAG_EDGE || y > h - TAG_EDGE;
          if (behind) {
            // Top centre, clear of the touch controls (steering bottom left, pedals bottom right).
            x = clampNum(w - x, w * 0.35, w * 0.65);
            y = TAG_BEHIND_Y + stacked++ * TAG_STACK;
          } else if (edge) {
            x = clampNum(x, TAG_EDGE * 3, w - TAG_EDGE * 3);
            y = clampNum(y, TAG_EDGE + 40, h - TAG_EDGE);
          }
          const d = gap(r);
          // Where the ghost is from the player: ahead (up arrow) or behind (down arrow), and by how long.
          const text = racing ? `${r.name} ${d > 0 ? '\u25B2' : '\u25BC'} ${(Math.abs(d) / 1000).toFixed(2)}` : r.name;
          return { x, y, text, color: r.color, edge, target: r === target };
        });
    hud.setGhostTags(tags);
  }

  private toggleMedalGhosts(): void {
    this.app.store.settings.medalGhosts = !this.app.store.settings.medalGhosts;
    this.app.store.saveSettings();
    this.syncMedalGhosts();
  }

  private chaseLabel(): string {
    const c = this.app.store.settings.chase;
    const name = (k: string) => (k === 'pb' ? 'PB' : k[0].toUpperCase() + k.slice(1));
    return c === 'auto' ? `Chase: Auto (${name(this.chaseKey())})` : `Chase: ${name(c)}`;
  }

  private medalGhostLabel(): string {
    if (!this.medals) return 'Target ghost: n/a';
    return this.app.store.settings.medalGhosts ? 'Target ghost: on' : 'Target ghost: off';
  }

  private steerLabel(): string {
    return `Steering: ${STEER_LABEL[this.app.store.settings.steerMode] ?? STEER_LABEL.buttons}`;
  }

  /**
   * Pause menu: Buttons > Wheel > Tilt > Buttons, applied at once (the controls come back that
   * way on Resume). Tilt is passed over when its sensor doesn't answer (App.setSteerMode says why).
   */
  private async cycleSteering(el: HTMLElement): Promise<void> {
    if (this.steerBusy) return;
    this.steerBusy = true;
    const next = nextSteerMode(this.app.store.settings.steerMode);
    el.textContent = `Steering: ${STEER_LABEL[next]}`;
    try {
      // Only fall back while still paused: after Resume the player is already driving with the old layout.
      if (!(await this.app.setSteerMode(next)) && this.paused) await this.app.setSteerMode(nextSteerMode(next));
    } finally {
      this.steerBusy = false;
      el.textContent = this.steerLabel();
    }
  }

  /** Driving or counting down: not paused and not on the results screen. */
  get isRacing(): boolean {
    return !this.paused && !this.resultsShown;
  }

  /** The race clock is running: hitches here are in-race stutters, not track load or shader warm-up. */
  get isDriving(): boolean {
    return this.isRacing && this.race.phase === 'racing';
  }

  /**
   * Draw the 3D view every n-th frame: under the pause menu nothing moves but the smoke settling, and
   * under the results card the car only rolls to a stop, so a phone need not draw (and heat up) at the
   * full rate there. The canvas keeps showing the last frame drawn in between.
   */
  get renderEvery(): number {
    return this.paused ? 4 : this.resultsShown ? 2 : 1;
  }

  /**
   * A moment where a graphics tier change (a stall of a few frames while the stadium is rebuilt and
   * shaders compile) goes unnoticed: paused, the 3-2-1 (the track's own warm-up lands there too), or
   * the results once the card has played.
   */
  get quiet(): boolean {
    if (this.paused) return true;
    if (this.resultsShown) return this.card === null || this.card.done;
    return this.race.phase === 'countdown';
  }

  /**
   * Android Back: pauses a race and resumes a paused one; on the results screen it is left to the
   * Menu button (returns false). A back swipe that Android took from a finger on the controls is
   * swallowed instead (see backOutcome), with a hint during the race. `cancels` are the touches
   * the system took (App.touches), `now` is performance.now().
   */
  back(cancels: readonly SysCancel[], now: number): boolean {
    const phase = this.resultsShown ? 'results' : this.paused ? 'paused' : 'racing';
    const o = backOutcome({ phase, since: this.phaseSince, lastBackAt: this.lastBackAt }, cancels, now);
    this.lastBackAt = now;
    if (o === 'swallow') {
      this.swallowedBacks++;
      if (phase === 'racing') this.app.hud.message(SWALLOW_HINT, 2600);
      console.info('[vb] Back swallowed', phase);
    } else if (o === 'pause') {
      this.setPaused(true, 'back');
    } else if (o === 'resume') {
      this.setPaused(false);
    }
    return o !== 'leave';
  }

  /** Pause or resume. `reason` (and the focus-loss detail) is shown on the pause screen. */
  setPaused(p: boolean, reason: PauseReason = 'button', detail?: FocusDetail): void {
    if (this.resultsShown || p === this.paused) return;
    this.paused = p;
    this.phaseSince = performance.now();
    // A nitro press on the pause menu (N, Shift+Tab, RB) is not for the race; a held key still counts.
    this.app.input.clearNitroPress();
    if (p) {
      console.info('[vb] paused', reason, detail ?? '');
      this.app.audio.silence();
      this.app.showTouch(false);
      const diag = this.diagText();
      // Touchscreens: the steering choice is here, where a player looks for it mid-race, and with
      // tilt a recentre (a bad automatic centre at GO is fixed without leaving the race).
      const steer = isTouchDevice() ? `<button class="btn center" data-act="steer">${esc(this.steerLabel())}</button>` : '';
      const recentre =
        isTouchDevice() && this.app.store.settings.steerMode === 'tilt' ? '<button class="btn center" data-act="recentre">Recentre tilt</button>' : '';
      showScreen(
        `<div class="panel result">
          <h2 style="margin:0 0 14px;font-style:italic">Paused</h2>
          <div class="muted pause-why">${esc(pauseWhy(reason, detail))}</div>
          <div class="menu-list pause-list" style="margin:auto">
            <button class="btn primary center" data-act="resume">Resume</button>
            <button class="btn center" data-act="restart">Restart</button>
            <button class="btn center" data-act="ghost">${this.ghostLabel()}</button>
            <button class="btn center" data-act="medalGhosts">${esc(this.medalGhostLabel())}</button>
            <button class="btn center" data-act="chase">${esc(this.chaseLabel())}</button>
            <button class="btn center" data-act="line">${esc(this.lineLabel())}</button>
            ${steer}
            ${recentre}
            <button class="btn center" data-act="quit">${this.entry.fromEditor ? 'Back to editor' : 'Quit to menu'}</button>
          </div>
          ${diag ? `<div class="muted pause-diag">${esc(diag)}</div>` : ''}
        </div>`,
        'dim',
        {
          resume: () => this.setPaused(false),
          restart: () => this.restart(),
          // onAction ignores 'ghost' while paused, so the menu toggles it directly.
          ghost: (el) => {
            this.toggleGhost();
            el.textContent = this.ghostLabel();
          },
          medalGhosts: (el) => {
            this.toggleMedalGhosts();
            el.textContent = this.medalGhostLabel();
          },
          chase: (el) => {
            const s = this.app.store.settings;
            s.chase = CHASE_TARGETS[(CHASE_TARGETS.indexOf(s.chase) + 1) % CHASE_TARGETS.length];
            this.app.store.saveSettings();
            this.makeGhostCar();
            this.makeMedalCars();
            this.deltaLog = [];
            this.cpSeen = this.race.cpTimes.length;
            el.textContent = this.chaseLabel();
          },
          line: (el) => {
            this.toggleLine();
            el.textContent = this.lineLabel();
          },
          steer: (el) => void this.cycleSteering(el),
          recentre: (el) => this.recentreTilt(el),
          quit: () => this.quit(),
        },
      );
    } else {
      clearScreen();
      // Pause never hides the HUD; restoring it too is a cheap backstop, as in restart().
      this.app.hud.show(true);
      this.app.showTouch(true);
    }
  }

  /**
   * Pause > Recentre tilt: straight ahead becomes the way the device is held RECENTRE_SETTLE_MS after
   * the tap (the tap itself jolts it). A centre saved for every race (tiltCenterSet) is saved again;
   * otherwise it holds for this run, and the start of the next one takes its own at GO.
   */
  private recentreTilt(el: HTMLElement): void {
    el.textContent = 'Hold steady…';
    setTimeout(() => {
      // Resumed (or left) meanwhile: the player is driving, so the centre stays as it was.
      if (!this.paused || !this.alive) return;
      const c = this.app.input.recentreTilt();
      if (c === null) {
        el.textContent = 'Recentre tilt';
        toast('No tilt reading yet. Hold the device the way you drive, then try again.', 3000);
        return;
      }
      const s = this.app.store.settings;
      if (s.tiltCenterSet) {
        s.tiltCenter = Math.round(c * 10) / 10;
        this.app.store.saveSettings();
      }
      el.textContent = 'Recentred';
    }, RECENTRE_SETTLE_MS);
  }

  /** The pause screen's grey diagnostics line, so a screenshot of it says what has been going on. */
  private diagText(): string {
    const app = this.app;
    return diagLine({
      device: app.device,
      insets: app.gestureInsets,
      swallowedBacks: this.swallowedBacks,
      touchCancels: app.touches.bursts - this.cancelsAtStart,
      longFrames: app.longFrames - this.framesAtStart,
      flipRespawns: this.flipRespawns,
    });
  }

  /** Pause > Quit and the results Menu button: back to where the race was started from. */
  private quit(): void {
    if (this.entry.fromEditor) this.app.openEditor();
    else if (this.entry.campaignIndex !== undefined) this.app.campaignMenu();
    else this.app.myTracks();
  }

  update(dt: number): void {
    const app = this.app;
    // A custom track's line is worked out in slices: a little while driving (or while the results
    // card plays, which is timed from here too), more otherwise.
    lineJobs.pumpFrame(dt, this.isDriving || (this.card !== null && !this.card.done));
    this.card?.update(dt);
    // Nothing read()s the controller while paused, so its Start button could pause but not resume.
    if (this.paused) app.input.pollPad();
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 12) {
        this.snapPrev();
        // Once per step: a nitro press is taken by the first read after it (Input.read).
        const ctl = this.pilot && this.race.phase === 'racing' ? quantise(this.pilot.controls(this.race)) : app.input.read();
        if (ctl.nitro && this.race.phase === 'countdown') this.nitroArmed = true;
        this.lastCtl = ctl;
        this.handle(this.race.step(ctl));
        if (this.race.phase === 'racing') this.progress.update(this.race.car.pos.x, this.race.car.pos.y, this.race.car.pos.z);
        this.acc -= DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
      this.watchOutside(dt);
    }
    const alpha = this.paused ? 1 : this.acc / DT;
    const c = this.race.car;
    this.car.apply(this.prev, c, alpha);
    // The bike's hood camera rides with its drawn lean, and every camera widens with a nitro push.
    app.rig.lean = this.car.lean;
    app.rig.boost = this.car.boost;
    this.lineView?.update(this.car.visual.root.position);
    // The player's own badge would sit in front of the lens in hood view.
    this.car.setAvatarFade(app.rig.mode === 'hood' ? 0 : 1);

    // Ghost.
    if (this.ghostCar && this.pbGhost) {
      const tick = this.race.phase === 'countdown' ? 0 : this.race.ticks + alpha;
      const g = ghostPose(this.pbGhost, tick, this.ghostAt);
      if (g) {
        // The ghost's speed from one tick back, for its front-wheel lock.
        const g0 = ghostPose(this.pbGhost, Math.max(0, tick - 1), this.ghostBack);
        const gsp = g0 ? Math.hypot(g.pos.x - g0.pos.x, g.pos.z - g0.pos.z) / DT : 0;
        this.ghostCar.applyPose(g.pos, g.rot, g.steer, this.paused ? 0 : 0.3, gsp, ghostYawRate(this.pbGhost, tick));
        // Fade out when overlapping the player's car.
        const d = Math.hypot(g.pos.x - c.pos.x, g.pos.y - c.pos.y, g.pos.z - c.pos.z);
        this.ghostCar.setVisible(d > this.fx.ghostHide);
        // Linear badge fade with distance (clamped by CarView), so side by side it never flickers.
        this.ghostCar.setAvatarFade((d - GHOST_FADE_NEAR) / (GHOST_FADE_FAR - GHOST_FADE_NEAR));
      }
    }

    this.pumpProJob();
    if (this.medalCars.length) {
      const tick = this.race.phase === 'countdown' ? 0 : this.race.ticks + alpha;
      for (const m of this.medalCars) {
        const g = ghostPose(m.ghost, tick, this.ghostAt);
        if (!g) continue;
        const g0 = ghostPose(m.ghost, Math.max(0, tick - 1), this.ghostBack);
        const gsp = g0 ? Math.hypot(g.pos.x - g0.pos.x, g.pos.z - g0.pos.z) / DT : 0;
        m.car.applyPose(g.pos, g.rot, g.steer, this.paused ? 0 : 0.3, gsp, ghostYawRate(m.ghost, tick));
        m.car.setVisible(Math.hypot(g.pos.x - c.pos.x, g.pos.y - c.pos.y, g.pos.z - c.pos.z) > this.fx.ghostHide);
      }
    }

    this.targetLine?.update(this.car.visual.root.position);
    this.updateRivals();

    // Smoke from the rear wheels when sliding; on grass the low grip makes every corner a slide.
    // The emitters sit behind this class's rear tyres (vehicleFx; the car's at z -1.4, x +-0.9).
    const { smokeZ, smokeX, smokeY } = this.fx;
    if (!this.paused && !c.onGrass && c.grounded >= 2 && (c.slip > 0.25 || c.drift > 0.3) && speedOf(c) > 8) {
      const f = forwardOf(c);
      const n = c.drift > 0.3 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        for (const side of smokeX) {
          const x = c.pos.x + f.x * smokeZ + side * f.z;
          const z = c.pos.z + f.z * smokeZ - side * f.x;
          this.smoke.emit(x, c.pos.y + smokeY, z, c.vel.x * 0.15, 0.6, c.vel.z * 0.15);
        }
      }
    }
    // A light dust trail from the rear wheels when driving on the grass.
    if (!this.paused && c.onGrass && c.grounded >= 2 && speedOf(c) > 10 && this.dustFrame++ % 2 === 0) {
      const f = forwardOf(c);
      for (const side of smokeX) {
        const x = c.pos.x + f.x * smokeZ + side * f.z;
        const z = c.pos.z + f.z * smokeZ - side * f.x;
        this.smoke.emit(x, c.pos.y + smokeY - 0.05, z, c.vel.x * 0.1, 0.4, c.vel.z * 0.1);
      }
    }
    this.smoke.update(dt);

    // Camera & HUD.
    const pose = this.car.visual.root;
    app.rig.follow(pose.position, pose.quaternion, c.vel, dt, this.track);
    app.world.focusShadow(c.pos.x, c.pos.y, c.pos.z);
    const kmh = speedOf(c) * 3.6;
    const shownTime = this.race.phase === 'finished' ? this.race.finishTime! : this.race.timeMs;
    app.hud.frame(shownTime, kmh, c.boostTime / 1.6);
    app.hud.nitro(nitroView(c.nitroTime, c.nitroCooldown), this.nitroArmed && this.race.phase === 'countdown');
    // Where straight ahead is, while steering with tilt.
    const s = app.store.settings;
    app.hud.tilt(this.touch && s.steerMode === 'tilt' && app.input.tiltLive ? app.input.tiltSteer() : null);
    // Flipped-car warning from 1.5 s; also runs while paused, so the bar stays frozen under the menu.
    const ft = this.race.flipTicks;
    app.hud.flipWarning(
      this.race.phase === 'racing' && ft >= FLIP_WARN_TICKS
        ? (ft - FLIP_WARN_TICKS) / (FLIP_RESPAWN_TICKS - FLIP_WARN_TICKS)
        : null,
      !this.race.hasRespawnPoint,
    );
    // Under the results card the engine stays quiet (showResults silenced it): the card has its own cues.
    if (!this.paused && !this.resultsShown && this.race.phase !== 'countdown') {
      // The last step's controls, not a second read(): that would take a nitro press meant for the next step.
      const ctl = this.lastCtl;
      // Grass slides are soft, so they barely screech.
      const slip = (c.slip + c.drift * 0.6) * (c.onGrass ? 0.3 : 1);
      // The engine note dips when traction control cuts power out of a corner; the nitro roars over it.
      app.audio.drive(kmh, this.race.phase === 'racing' ? ctl.gas * (1 - c.tc) : 0, slip, c.grounded > 0, this.car.boost);
    } else if (this.race.phase === 'countdown') {
      app.audio.drive(0, 0, 0, true);
    }

    if (this.race.phase === 'finished' && !this.resultsShown) {
      this.finishDelay += dt;
      if (this.finishDelay > 1.4) this.showResults();
    }
  }

  /**
   * Walls on all roads: every road edge is walled, so a car on the grass is outside the walls (it
   * flew over one, or dropped into a jump's gap) and cannot drive back in. After OUTSIDE_HINT_S
   * there the HUD says how to get back, once until the next respawn or restart.
   */
  private watchOutside(dt: number): void {
    if (!this.entry.walls || this.race.phase !== 'racing') return;
    this.grassFor = this.race.car.onGrass ? this.grassFor + dt : 0;
    if (this.grassFor < OUTSIDE_HINT_S || this.outsideHinted) return;
    this.outsideHinted = true;
    this.app.hud.message(outsideWallsHint(this.touch, !this.race.hasRespawnPoint), 2500);
  }

  private handle(events: RaceEvent[]): void {
    const { hud, audio, rig } = this.app;
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          hud.countdown(String(e.n));
          audio.countdown(e.n);
          break;
        case 'go': {
          hud.countdown('GO!');
          audio.countdown(0);
          // Tilt: the way the device is held at the start is straight ahead (lying on a sofa
          // works too). Not saved, and not done once the profile's Recentre has saved a centre.
          const s = this.app.store.settings;
          if (s.steerMode === 'tilt' && !s.tiltCenterSet) this.app.input.recentreTilt();
          break;
        }
        case 'checkpoint': {
          const ref = this.pbSplits?.[e.taken - 1];
          const diff = ref !== undefined ? e.time - ref : null;
          hud.showSplit(e.time, diff);
          hud.setCheckpoints(e.taken, e.total);
          audio.checkpoint(diff === null ? null : diff <= 0);
          if (navigator.vibrate) navigator.vibrate(20);
          break;
        }
        case 'missing':
          hud.message(`${e.remaining} checkpoint${e.remaining > 1 ? 's' : ''} missing!`);
          audio.missing();
          break;
        case 'pad':
          audio.boost(e.kind === 'turbo');
          rig.shake = Math.max(rig.shake, e.kind === 'turbo' ? 0.35 : 0.2);
          break;
        case 'nitro':
          // Fired (at GO too, after a press in the 3-2-1): flames and the FOV kick follow CarView.boost.
          this.nitroArmed = false;
          audio.nitro();
          rig.shake = Math.max(rig.shake, 0.25);
          if (navigator.vibrate) navigator.vibrate(30);
          break;
        case 'nitroReady':
          audio.nitroReady();
          hud.nitroPop();
          break;
        case 'splash':
          // Into the water: the splash itself is drawn by World (it watches the followed car).
          audio.splash();
          rig.shake = Math.max(rig.shake, 0.3);
          if (navigator.vibrate) navigator.vibrate(40);
          break;
        case 'impact':
          audio.impact(e.speed);
          rig.shake = Math.max(rig.shake, Math.min(0.6, e.speed / 40));
          break;
        case 'respawn':
          // Manual or automatic (flipped 3 s): a teleport, so don't interpolate or swing the
          // camera across it. update() sets prev before each step, so this must happen here.
          hud.setCheckpoints(this.race.taken.size, this.track.checkpointCount);
          this.smoke.clear();
          // A fresh object (respawns are rare): snapPrev is for the per-step copy.
          this.prev = { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
          rig.reset();
          hud.flipWarning(null);
          // No checkpoint taken: it was a full restart, and the 3-2-1 replaces any message. The restart
          // dropped the session's armed nitro too, so the button stops glowing.
          if (this.race.phase === 'countdown') {
            hud.clearMessages();
            this.nitroArmed = false;
            this.app.input.clearNitroPress();
          }
          // A flip respawn's freeze (or 3-2-1) can look like the game pausing by itself.
          if (e.auto) this.flipRespawns++;
          this.grassFor = 0;
          this.outsideHinted = false;
          this.lineView?.resetTracking();
          break;
        case 'finish':
          this.onFinish(e.time);
          break;
      }
    }
  }

  /**
   * The finished run, for the results card. `medals` are the medal times as they were before this
   * finish: a test drive that lowers the author time is judged (and its reveal played) against the
   * time it beat, and `newAuthor` is what it set.
   */
  private finishInfo: {
    time: number;
    improved: boolean;
    previous: number | null;
    medals: MedalTimes | null;
    newAuthor: number | null;
  } | null = null;

  private onFinish(time: number): void {
    const { store } = this.app;
    const e = this.entry;
    const { improved, previous, saved } = store.addFinish(e.key, time, this.race.cpTimes);
    // Records and unlocks come before ghosts (addFinish evicts old ghosts for them); when even that is
    // not enough, say so rather than lose the run quietly on the next launch.
    if (!saved) toast('Storage is full: this result is kept only until the game closes.', 4000);
    // A new PB's ghost. When storage cannot keep it (saveGhost then drops the older, slower one), or the
    // record itself is only in memory, Retry in this session still races it.
    if (improved && this.race.ghost) this.sessionGhost = saved && store.saveGhost(e.key, this.race.ghost) ? null : this.race.ghost;
    const medals = this.medals;
    // A test drive sets this class's author time or lowers it (walls off only); the editor saves it,
    // and Retry and the HUD use the new one.
    const newAuthor = e.fromEditor ? authorTimeAfter(e.authorTime, time, e.walls) : null;
    if (newAuthor !== null) {
      e.authorTime = newAuthor;
      this.medals = medalTimes(newAuthor);
      e.onAuthorTime?.(newAuthor);
    }
    this.finishInfo = { time, improved, previous, medals, newAuthor };
    // A first author medal is the rare moment CrazyGames' "happy time" is meant for.
    if (medalFor(time, medals) === 4 && medalFor(previous, medals) < 4 && !e.fromEditor) this.app.ads.happytime();
    this.app.audio.finish(improved);
    // The card says FIRST FINISH for a first run, so the finish line does not say RECORD.
    this.app.hud.countdown(improved && previous !== null ? 'RECORD!' : 'FINISH');
  }

  private showResults(): void {
    this.resultsShown = true;
    this.phaseSince = performance.now();
    const f = this.finishInfo!;
    const { app, entry } = this;
    app.showTouch(false);
    // The card has the time and the medals; the HUD's medal line under it would still show the "?".
    app.hud.show(false);
    app.audio.silence();
    const next = app.nextCampaignEntry(entry);
    if (next && app.store.settings.racingLine) lineJobs.prefetch(lineKeyOf(next), new Track(next.data));
    const model = scoreModel({
      label: entry.label,
      tags: entryTags(entry),
      time: f.time,
      previous: f.previous,
      improved: f.improved,
      medals: f.medals,
      newAuthor: f.newAuthor,
      note: entry.fromEditor && entry.walls ? AUTHOR_WALLS_NOTE : '',
      respawns: this.race.respawns,
      hasNext: !!next,
      nextLocked: !!next && !!app.entryLock(next),
      fromEditor: !!entry.fromEditor,
      authorReplay: !!this.proGhost,
      bestReplay: !f.improved && !!app.store.ghost(entry.key),
    });
    const animate = !prefersReducedMotion();
    const el = showScreen(scoreCardHtml(model, animate), 'dim score-screen', {
      // A tap on the card (not on a button) skips the reveal; the buttons work from the first frame.
      skip: () => this.card?.skip(),
      retry: () => this.restart(),
      replay: () => {
        // A const: the narrowing of this.race.ghost doesn't carry into the factory.
        const ghost = this.race.ghost;
        if (!ghost) return;
        // exit() leaves the world on this track, so the replay drives it.
        app.setMode(() => new ReplayMode(app, this.track, ghost, entry, () => app.startRace(entry)));
      },
      replayBest: () => {
        const ghost = app.store.ghost(entry.key);
        if (ghost) app.setMode(() => new ReplayMode(app, this.track, ghost, entry, () => app.startRace(entry)));
      },
      replayAuthor: () => {
        const ghost = this.proGhost;
        if (ghost) app.setMode(() => new ReplayMode(app, this.track, ghost, entry, () => app.startRace(entry), { title: 'Author lap', driver: 'Velocity Blocks AI' }));
      },
      // A natural break: browser builds may play an interstitial before the next track.
      next: () => next && void app.playRace(next),
      menu: () => this.quit(),
    });
    const { audio, store } = app;
    // Particles are halved below High quality (phones default to Medium).
    this.card = new ScoreClock(model, new ScoreCardView(el, model, { lowFx: store.settings.quality !== 'high' }), (c) =>
      audio.scoreCue(c.kind, c.n),
    );
    if (!animate) {
      // Reduced motion: the final state at once, with one cue for the best medal of the run.
      this.card.skip();
      if (model.authorNew) audio.scoreCue('author');
      else if (model.medal) audio.scoreCue('medal', model.medal);
    }
  }

  exit(): void {
    this.alive = false;
    this.card = null;
    this.lineCancel?.();
    this.lineCancel = null;
    this.lineView?.dispose();
    this.lineView = null;
    this.car.dispose();
    this.ghostCar?.dispose();
    this.proJob = null;
    this.disposeMedalCars();
    this.app.hud.setDelta(null, 0, []);
    this.app.hud.setGhostTags([]);
    this.smoke.dispose();
    // Hide it here rather than relying on the next race's setTrack().
    this.app.hud.flipWarning(null);
    this.app.hud.tilt(null);
    this.app.hud.show(false);
    this.app.showTouch(false);
    this.app.audio.silence();
    this.app.rig.lean = 0;
    this.app.rig.boost = 0;
  }
}
