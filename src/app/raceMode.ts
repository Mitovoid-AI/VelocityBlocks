// Playing a track: fixed-step simulation, HUD, ghost, pause and results.

import { DT } from '../core/constants';
import { ghostPose, type Ghost } from '../game/ghost';
import { medalFor, medalTimes, MEDAL_COLORS, MEDAL_NAMES, type MedalTimes } from '../game/medals';
import { FLIP_RESPAWN_TICKS, FLIP_WARN_TICKS, formatTime, RaceSession, type RaceEvent } from '../game/race';
import type { Action } from '../input/input';
import { forwardOf, speedOf } from '../physics/vehicle';
import { GHOST_FADE_FAR, GHOST_FADE_NEAR } from '../render/avatar';
import { CAM_MODES } from '../render/cameraRig';
import { CarView, Smoke, type PoseSnapshot } from '../render/carView';
import { Track, type TrackData } from '../track/track';
import { clearScreen, esc, showScreen } from '../ui/dom';
import type { App, Mode } from './app';
import { ReplayMode } from './replayMode';

const GHOST_COLOR = '#7fd3ff';

export interface RaceEntry {
  /** Key for records and ghosts. */
  key: string;
  data: TrackData;
  label: string;
  authorTime: number | null;
  /** Campaign position: enables "Next track", and quitting goes to the campaign menu (else My tracks). */
  campaignIndex?: number;
  /** Return to the editor instead of the menu. */
  fromEditor?: boolean;
  /** Called with the finish time (editor uses it to set the author time). */
  onFinish?: (time: number) => void;
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
  private medals: MedalTimes | null;
  private resultsShown = false;
  private finishDelay = 0;
  /** Frame counter: grass dust is emitted every other frame. */
  private dustFrame = 0;

  constructor(
    private readonly app: App,
    private readonly entry: RaceEntry,
  ) {
    this.track = new Track(entry.data);
    app.world.setTrack(this.track);
    this.race = new RaceSession(this.track);
    this.car = new CarView(app.world.scene, app.playerCarOptions());
    this.smoke = new Smoke(app.world.scene);
    this.prev = { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
    this.pbGhost = app.store.ghost(entry.key);
    this.pbSplits = app.store.record(entry.key)?.cpTimes ?? null;
    this.medals = entry.authorTime ? medalTimes(entry.authorTime) : null;
    this.makeGhostCar();
    app.rig.mode = app.store.settings.camera;
    app.rig.reset();
    clearScreen();
    // Safe: App.setMode has already run the previous mode's exit(), which hides these.
    app.hud.show(true);
    app.showTouch(true);
    app.input.enabled = true;
    this.refreshHud();
  }

  private makeGhostCar(): void {
    this.ghostCar?.dispose();
    this.ghostCar = null;
    if (this.pbGhost && this.app.store.settings.showGhost) {
      // The ghost is "you": the player's body and photo, in ghost blue with a dimmed badge.
      const p = this.app.playerCarOptions();
      this.ghostCar = new CarView(this.app.world.scene, {
        color: GHOST_COLOR,
        ghost: true,
        body: p.body,
        avatar: p.avatar ? { photo: p.avatar.photo, ring: GHOST_COLOR, dim: true } : null,
      });
    }
  }

  private refreshHud(): void {
    const best = this.app.store.record(this.entry.key)?.best ?? null;
    this.app.hud.setTrack(this.entry.label, best, this.medals, this.track.checkpointCount);
  }

  restart(): void {
    if (this.resultsShown) {
      // Retry after a finish: that run may have saved a new PB, so race its ghost and splits.
      this.pbGhost = this.app.store.ghost(this.entry.key);
      this.pbSplits = this.app.store.record(this.entry.key)?.cpTimes ?? null;
      this.makeGhostCar();
    }
    this.race.restart();
    this.prev = { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
    this.acc = 0;
    this.resultsShown = false;
    this.finishDelay = 0;
    this.paused = false;
    this.smoke.clear();
    this.app.rig.reset();
    this.app.hud.clearMessages();
    this.app.hud.show(true);
    this.app.showTouch(true);
    clearScreen();
    this.refreshHud();
  }

  onAction(a: Action): void {
    if (a === 'pause') {
      if (this.resultsShown) return;
      this.setPaused(!this.paused);
      return;
    }
    if (this.paused) return;
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
      this.app.hud.message(this.app.store.settings.showGhost ? 'Ghost on' : 'Ghost off', 900);
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

  /** Driving or counting down: not paused and not on the results screen. */
  get isRacing(): boolean {
    return !this.paused && !this.resultsShown;
  }

  /** Android Back toggles the pause menu; on the results screen it is left to the Menu button. */
  back(): boolean {
    if (this.resultsShown) return false;
    this.setPaused(!this.paused);
    return true;
  }

  setPaused(p: boolean): void {
    if (this.resultsShown || p === this.paused) return;
    this.paused = p;
    if (p) {
      this.app.audio.silence();
      this.app.showTouch(false);
      showScreen(
        `<div class="panel result">
          <h2 style="margin:0 0 14px;font-style:italic">Paused</h2>
          <div class="menu-list" style="margin:auto">
            <button class="btn primary center" data-act="resume">Resume</button>
            <button class="btn center" data-act="restart">Restart</button>
            <button class="btn center" data-act="ghost">${this.ghostLabel()}</button>
            <button class="btn center" data-act="quit">${this.entry.fromEditor ? 'Back to editor' : 'Quit to menu'}</button>
          </div>
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

  /** Pause > Quit and the results Menu button: back to where the race was started from. */
  private quit(): void {
    if (this.entry.fromEditor) this.app.openEditor();
    else if (this.entry.campaignIndex !== undefined) this.app.campaignMenu();
    else this.app.myTracks();
  }

  update(dt: number): void {
    const app = this.app;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 12) {
        this.prev = { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
        const ctl = app.input.read();
        this.handle(this.race.step(ctl));
        this.acc -= DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
    }
    const alpha = this.paused ? 1 : this.acc / DT;
    const c = this.race.car;
    this.car.apply(this.prev, c, alpha);
    // The player's own badge would sit in front of the lens in hood view.
    this.car.setAvatarFade(app.rig.mode === 'hood' ? 0 : 1);

    // Ghost.
    if (this.ghostCar && this.pbGhost) {
      const tick = this.race.phase === 'countdown' ? 0 : this.race.ticks + alpha;
      const g = ghostPose(this.pbGhost, tick);
      if (g) {
        this.ghostCar.applyPose(g.pos, g.rot, g.steer, this.paused ? 0 : 0.3);
        // Fade out when overlapping the player's car.
        const d = Math.hypot(g.pos.x - c.pos.x, g.pos.y - c.pos.y, g.pos.z - c.pos.z);
        this.ghostCar.setVisible(d > 3.5);
        // Linear badge fade with distance (clamped by CarView), so side by side it never flickers.
        this.ghostCar.setAvatarFade((d - GHOST_FADE_NEAR) / (GHOST_FADE_FAR - GHOST_FADE_NEAR));
      }
    }

    // Smoke from the rear wheels when sliding; on grass the low grip makes every corner a slide.
    if (!this.paused && !c.onGrass && c.grounded >= 2 && (c.slip > 0.25 || c.drift > 0.3) && speedOf(c) > 8) {
      const f = forwardOf(c);
      const n = c.drift > 0.3 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        for (const side of [-1, 1]) {
          const x = c.pos.x - f.x * 1.4 + side * 0.9 * f.z;
          const z = c.pos.z - f.z * 1.4 - side * 0.9 * f.x;
          this.smoke.emit(x, c.pos.y - 0.45, z, c.vel.x * 0.15, 0.6, c.vel.z * 0.15);
        }
      }
    }
    // A light dust trail from the rear wheels when driving on the grass.
    if (!this.paused && c.onGrass && c.grounded >= 2 && speedOf(c) > 10 && this.dustFrame++ % 2 === 0) {
      const f = forwardOf(c);
      for (const side of [-1, 1]) {
        const x = c.pos.x - f.x * 1.4 + side * 0.9 * f.z;
        const z = c.pos.z - f.z * 1.4 - side * 0.9 * f.x;
        this.smoke.emit(x, c.pos.y - 0.5, z, c.vel.x * 0.1, 0.4, c.vel.z * 0.1);
      }
    }
    this.smoke.update(dt);

    // Camera & HUD.
    const pose = this.car.visual.root;
    app.rig.follow(
      { x: pose.position.x, y: pose.position.y, z: pose.position.z },
      { x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w },
      c.vel,
      dt,
      this.track,
    );
    app.world.focusShadow(c.pos.x, c.pos.y, c.pos.z);
    const kmh = speedOf(c) * 3.6;
    const shownTime = this.race.phase === 'finished' ? this.race.finishTime! : this.race.timeMs;
    app.hud.frame(shownTime, kmh, c.boostTime / 1.6);
    // Flipped-car warning from 1.5 s; also runs while paused, so the bar stays frozen under the menu.
    const ft = this.race.flipTicks;
    app.hud.flipWarning(
      this.race.phase === 'racing' && ft >= FLIP_WARN_TICKS
        ? (ft - FLIP_WARN_TICKS) / (FLIP_RESPAWN_TICKS - FLIP_WARN_TICKS)
        : null,
      !this.race.hasRespawnPoint,
    );
    if (!this.paused && this.race.phase !== 'countdown') {
      const ctl = app.input.read();
      // Grass slides are soft, so they barely screech.
      const slip = (c.slip + c.drift * 0.6) * (c.onGrass ? 0.3 : 1);
      app.audio.drive(kmh, this.race.phase === 'racing' ? ctl.gas : 0, slip, c.grounded > 0);
    } else if (this.race.phase === 'countdown') {
      app.audio.drive(0, 0, 0, true);
    }

    if (this.race.phase === 'finished' && !this.resultsShown) {
      this.finishDelay += dt;
      if (this.finishDelay > 1.4) this.showResults();
    }
  }

  private handle(events: RaceEvent[]): void {
    const { hud, audio, rig } = this.app;
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          hud.countdown(String(e.n));
          audio.countdown(e.n);
          break;
        case 'go':
          hud.countdown('GO!');
          audio.countdown(0);
          break;
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
        case 'impact':
          audio.impact(e.speed);
          rig.shake = Math.max(rig.shake, Math.min(0.6, e.speed / 40));
          break;
        case 'respawn':
          // Manual or automatic (flipped 3 s): a teleport, so don't interpolate or swing the
          // camera across it. update() sets prev before each step, so this must happen here.
          hud.setCheckpoints(this.race.taken.size, this.track.checkpointCount);
          this.smoke.clear();
          this.prev = { pos: { ...this.race.car.pos }, rot: { ...this.race.car.rot } };
          rig.reset();
          hud.flipWarning(null);
          // No checkpoint taken: it was a full restart, and the 3-2-1 replaces any message.
          if (this.race.phase === 'countdown') hud.clearMessages();
          break;
        case 'finish':
          this.onFinish(e.time);
          break;
      }
    }
  }

  private finishInfo: { time: number; improved: boolean; previous: number | null; medal: number; prevMedal: number } | null = null;

  private onFinish(time: number): void {
    const store = this.app.store;
    const prevBest = store.record(this.entry.key)?.best ?? null;
    const { improved, previous } = store.addFinish(this.entry.key, time, this.race.cpTimes);
    if (improved && this.race.ghost) store.saveGhost(this.entry.key, this.race.ghost);
    this.entry.onFinish?.(time);
    if (this.entry.fromEditor && this.entry.authorTime === null) {
      // The first finish in the editor becomes the author time.
      this.entry.authorTime = time;
      this.medals = medalTimes(time);
    }
    const medal = medalFor(time, this.medals);
    const prevMedal = medalFor(prevBest, this.medals);
    this.finishInfo = { time, improved, previous, medal, prevMedal };
    // A first author medal is the rare moment CrazyGames' "happy time" is meant for.
    if (medal === 4 && prevMedal < 4 && !this.entry.fromEditor) this.app.ads.happytime();
    this.app.audio.finish(improved);
    this.app.hud.countdown(improved ? 'RECORD!' : 'FINISH');
  }

  private showResults(): void {
    this.resultsShown = true;
    const f = this.finishInfo!;
    this.app.showTouch(false);
    this.app.audio.silence();
    const m = this.medals;
    const delta =
      f.previous === null
        ? '<div class="delta ahead">First finish!</div>'
        : `<div class="delta ${f.time <= f.previous ? 'ahead' : 'behind'}">${esc(formatTime(f.time - f.previous, true))} vs PB ${esc(formatTime(f.previous))}</div>`;
    const rows = m
      ? [4, 3, 2, 1]
          .map((n) => {
            const t = n === 4 ? m.author : n === 3 ? m.gold : n === 2 ? m.silver : m.bronze;
            return `<tr class="${f.medal >= n ? 'hit' : ''}"><td><span class="medal" style="background:${MEDAL_COLORS[n]}"></span>${MEDAL_NAMES[n]}</td><td>${formatTime(t)}</td></tr>`;
          })
          .join('')
      : '';
    const medalHtml =
      f.medal > 0
        ? `<div class="medal-big" style="background:${MEDAL_COLORS[f.medal]}"></div><div style="font-weight:800">${MEDAL_NAMES[f.medal]} medal${f.medal > f.prevMedal ? ' earned!' : ''}</div>`
        : '';
    const next = this.app.nextCampaignEntry(this.entry);
    showScreen(
      `<div class="panel result">
        <div class="muted">${esc(this.entry.label)}</div>
        <div class="time">${formatTime(f.time)}</div>
        ${delta}
        <div style="margin-top:12px">${medalHtml}</div>
        ${rows ? `<table class="medals-table">${rows}</table>` : ''}
        ${this.race.respawns ? `<div class="muted">Respawns: ${this.race.respawns}</div>` : ''}
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn primary center" data-act="retry">Retry</button>
          <button class="btn center" data-act="replay">Watch replay</button>
          ${next ? '<button class="btn center" data-act="next">Next track</button>' : ''}
          <button class="btn center" data-act="menu">${this.entry.fromEditor ? 'Editor' : 'Menu'}</button>
        </div>
      </div>`,
      'dim',
      {
        retry: () => this.restart(),
        replay: () => {
          // A const: the narrowing of this.race.ghost doesn't carry into the factory.
          const ghost = this.race.ghost;
          if (!ghost) return;
          // exit() leaves the world on this track, so the replay drives it.
          this.app.setMode(() => new ReplayMode(this.app, this.track, ghost, this.entry, () => this.app.startRace(this.entry)));
        },
        // A natural break: browser builds may play an interstitial before the next track.
        next: () => next && void this.app.playRace(next),
        menu: () => this.quit(),
      },
    );
  }

  exit(): void {
    this.car.dispose();
    this.ghostCar?.dispose();
    this.smoke.dispose();
    // Hide it here rather than relying on the next race's setTrack().
    this.app.hud.flipWarning(null);
    this.app.hud.show(false);
    this.app.showTouch(false);
    this.app.audio.silence();
  }
}
