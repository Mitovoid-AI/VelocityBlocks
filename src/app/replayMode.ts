// Replay viewer: plays back a recorded ghost with alternating chase and trackside cameras, with its telemetry
// (pedals, steering, nitro, speed, splits: from the run's input log) and the line it drove on the road
// (coloured by what the driver did), or the ideal racing line. A replay can be shared as a video (recorded
// from the screen, app/replayVideo.ts) or, when it kept its inputs, as a link that drives the same lap in
// anyone's game (game/runShare.ts).

import { DT, MAX_SPEED } from '../core/constants';
import { qrotate, type Quat, type V3 } from '../core/vec';
import { drivenLineData } from '../game/drivenLine';
import { ghostEndTick, ghostNitro, ghostPose, type Ghost } from '../game/ghost';
import { INPUT_STRIDE } from '../game/inputLog';
import { formatTime } from '../game/race';
import { lineJobs } from '../game/racingLine';
import { runFile, runFileName, runLink, runOf } from '../game/runShare';
import { APP_VERSION } from '../platform/appVersion';
import { shareFile, shareText } from '../platform/native';
import { RacingLineView } from '../render/racingLine';
import { TelemetryOverlay } from '../ui/telemetry';
import { canRecordVideo, VideoRecorder } from './replayVideo';
import type { Action } from '../input/input';
import { CarView } from '../render/carView';
import { nearestPoint, traceRoute, type Route } from '../track/route';
import type { Track } from '../track/track';
import { downloadText, esc, showScreen, toast } from '../ui/dom';
import type { App, Mode } from './app';
import { AUTOPLAY, lineKeyOf, type RaceEntry } from './raceMode';

/** What the replay draws on the road: the line this run drove, the ideal racing line, or nothing. */
type LineShown = 'driven' | 'ideal' | 'off';
const LINE_LABEL: Record<LineShown, string> = { driven: 'Line: driven', ideal: 'Line: ideal', off: 'Line: off' };

export interface ReplayOptions {
  /** The banner's title ('Replay': the player's own run). */
  title?: string;
  /** Who drove it, for the banner and a shared link ('' : the player). */
  driver?: string;
  /** A line under the title (a shared run: verified or not). */
  note?: string;
  /** A "Race it" button: race the track against this lap. */
  onRace?: () => void;
  /** An "Open in the app" link (the browser game: velocityblocks://... opens the installed app). */
  appLink?: string;
}

/** Heading on the ground plane (rad; grows turning left, the way the yaw rate is signed). */
function headingOf(q: Quat): number {
  const f = qrotate(q, { x: 0, y: 0, z: 1 });
  return Math.atan2(f.x, f.z);
}

/**
 * A ghost's yaw rate at `tick` (rad/s, + turning left): the heading change across one sample
 * interval either side, so it is smooth between the stored samples. Draws a ghost bike's lean.
 */
export function ghostYawRate(g: Ghost, tick: number): number {
  const t0 = Math.max(0, tick - g.interval);
  const t1 = Math.min(ghostEndTick(g), tick + g.interval);
  const a = ghostPose(g, t0);
  const b = ghostPose(g, t1);
  if (!a || !b || t1 <= t0) return 0;
  const d = headingOf(b.rot) - headingOf(a.rot);
  return Math.atan2(Math.sin(d), Math.cos(d)) / ((t1 - t0) * DT);
}

export class ReplayMode implements Mode {
  private car: CarView;
  private tick = 0;
  private route: Route;
  private shot = 0;
  private shotTime = 0;
  private side: { x: number; y: number; z: number } | null = null;
  private lastPos = { x: 0, y: 0, z: 0 };
  /** Ghost tick shown last frame; -1 before the first frame. */
  private lastT = -1;
  private speed = 1;
  private readonly overlay: TelemetryOverlay;
  private lineShown: LineShown = 'driven';
  private lineView: RacingLineView | null = null;
  private lineCancel: (() => void) | null = null;
  private recorder: VideoRecorder | null = null;
  private screen: HTMLElement | null = null;
  private readonly title: string;
  private readonly driver: string;
  private readonly note: string;
  private alive = true;
  private readonly onRace: (() => void) | null;
  private readonly appLink: string | null;

  constructor(
    private readonly app: App,
    private readonly track: Track,
    private readonly ghost: Ghost,
    private readonly entry: RaceEntry,
    private readonly onExit: () => void,
    opts: ReplayOptions = {},
  ) {
    this.title = opts.title ?? 'Replay';
    this.driver = opts.driver ?? app.store.profile.name;
    this.note = opts.note ?? '';
    this.onRace = opts.onRace ?? null;
    this.appLink = opts.appLink ?? null;
    // The ghost knows the class that drove it.
    this.car = new CarView(app.world.scene, app.playerCarOptions(ghost.vehicle));
    this.route = traceRoute(track);
    app.hud.show(false);
    app.showTouch(false);
    app.rig.vehicle = ghost.vehicle;
    app.rig.reset();
    this.overlay = new TelemetryOverlay(document.querySelector<HTMLElement>('#app')!);
    this.showButtons();
    this.syncLine();
  }

  private showButtons(): void {
    const canLink = !!this.ghost.inputs?.length;
    this.screen = showScreen(
      `<div class="row replay-bar" style="position:absolute;top:calc(12px + var(--safe-t));left:calc(14px + var(--safe-l));right:calc(14px + var(--safe-r));flex-wrap:wrap;gap:6px">
        <div class="spacer"></div>
        <button class="btn small" data-act="slow">Speed: ${this.speed}x</button>
        <button class="btn small" data-act="restart">From start</button>
        <button class="btn small" data-act="line">${LINE_LABEL[this.lineShown]}</button>
        <button class="btn small" data-act="video">Share video</button>
        ${canLink ? '<button class="btn small" data-act="link">Share run</button><button class="btn small" data-act="save">Save run file</button>' : ''}
        ${this.onRace ? '<button class="btn small" data-act="race">Race it</button>' : ''}
        ${this.appLink ? `<a class="btn small" href="${esc(this.appLink)}">Open in the app</a>` : ''}
        <button class="btn small primary" data-act="exit">Exit replay</button>
      </div>`,
      'editor',
      {
        exit: () => this.onExit(),
        restart: () => {
          this.tick = 0;
          this.app.rig.reset();
          this.lineView?.resetTracking();
        },
        slow: (el) => {
          this.speed = this.speed === 1 ? 0.5 : this.speed === 0.5 ? 0.25 : 1;
          el.textContent = `Speed: ${this.speed}x`;
        },
        line: (el) => {
          this.lineShown = this.lineShown === 'driven' ? 'ideal' : this.lineShown === 'ideal' ? 'off' : 'driven';
          el.textContent = LINE_LABEL[this.lineShown];
          this.syncLine();
        },
        video: () => this.recordVideo(),
        link: () => void this.shareLink(),
        save: () => this.saveRunFile(),
        race: () => this.onRace?.(),
      },
    );
  }

  /** Draw the chosen line: the run's own (from its poses and inputs) or the ideal racing line (worked out if need be). */
  private syncLine(): void {
    this.lineCancel?.();
    this.lineCancel = null;
    this.lineView?.dispose();
    this.lineView = null;
    if (this.lineShown === 'driven') {
      const d = drivenLineData(this.ghost);
      if (d) this.showLine(new RacingLineView(d));
    } else if (this.lineShown === 'ideal') {
      const key = lineKeyOf(this.entry);
      const cached = lineJobs.peek(key);
      const show = (d: Parameters<Parameters<typeof lineJobs.request>[2]>[0]) => {
        this.lineCancel = null;
        if (!this.alive || this.lineShown !== 'ideal') return;
        if (d) this.showLine(new RacingLineView(d));
        else toast('This track has no racing line', 1500);
      };
      if (cached !== undefined) show(cached);
      else this.lineCancel = lineJobs.request(key, this.track, show);
    }
  }

  private showLine(v: RacingLineView): void {
    this.lineView = v;
    v.attach(this.app.world.scene);
  }

  /** The replay from the start into a video, then the share sheet. */
  private recordVideo(): void {
    if (this.recorder) return;
    if (!canRecordVideo()) {
      toast('This device cannot record video', 2500);
      return;
    }
    try {
      this.recorder = new VideoRecorder(this.app.world.renderer.domElement, this.overlay.canvas);
    } catch {
      toast('Could not start the recording', 2500);
      return;
    }
    this.tick = 0;
    this.speed = 1;
    this.app.rig.reset();
    this.lineView?.resetTracking();
    this.screen = showScreen(
      `<div class="row" style="position:absolute;top:calc(12px + var(--safe-t));right:calc(14px + var(--safe-r))">
        <div class="panel replay-rec" style="padding:8px 14px"><b style="color:#ff5040">&#9679; REC</b> <span class="rec-pct">0%</span></div>
        <button class="btn small" data-act="cancel">Cancel</button>
      </div>`,
      'editor',
      {
        cancel: () => {
          this.recorder?.cancel();
          this.recorder = null;
          this.showButtons();
        },
      },
    );
  }

  /** The recording reached the end of the lap: share it. */
  private async finishVideo(): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    const blob = await rec.stop();
    if (!this.alive) return;
    this.showButtons();
    const name = `VelocityBlocks-${this.entry.label.replace(/[^A-Za-z0-9]+/g, '-')}-${formatTime(this.ghost.time).replace(/[:.]/g, '-')}.${rec.ext}`;
    const r = await shareFile(name, blob, `${this.entry.label} in ${formatTime(this.ghost.time)} - Velocity Blocks`);
    if (r === 'downloaded') toast('Video saved', 2000);
    else if (r === 'failed') toast('Could not share the video', 2500);
  }

  /** Share the run as a link that drives the same lap in the receiver's game. */
  private async shareLink(): Promise<void> {
    const run = runOf(this.entry, this.ghost, this.driver);
    if (!run) return;
    const link = await runLink(run);
    // Autoplay test runs read the link back (DevTools) to open it as another phone would.
    if (AUTOPLAY) (window as unknown as { vbLastRunLink: string }).vbLastRunLink = link;
    const who = this.driver ? `${this.driver}'s` : 'My';
    const r = await shareText(`${who} ${this.entry.label} run: ${formatTime(this.ghost.time)} in Velocity Blocks. Watch it or race it: ${link}`);
    if (r === 'copied') toast('Link copied', 2000);
    else if (r === 'failed') toast('Could not share the link', 2500);
  }

  /** Save the run as a .vbst file (a PC has no share sheet): any Velocity Blocks opens it. */
  private saveRunFile(): void {
    const run = runOf(this.entry, this.ghost, this.driver);
    if (!run) return;
    // octet-stream: Android's "Save as" keeps the .vbst name instead of adding .json.
    downloadText(runFileName(run), runFile(run, APP_VERSION), 'application/octet-stream');
  }

  afterRender(): void {
    this.recorder?.frame();
  }

  onAction(a: Action): void {
    if (a === 'pause' || a === 'restart') this.onExit();
  }

  update(dt: number): void {
    // The ideal line loads (or is worked out) in slices; only race mode pumps them otherwise.
    if (this.lineCancel) lineJobs.pumpFrame(dt, false);
    const end = ghostEndTick(this.ghost);
    this.tick += (dt / DT) * this.speed;
    if (this.recorder) {
      const pct = this.screen?.querySelector('.rec-pct');
      if (pct) pct.textContent = `${Math.min(100, Math.round((this.tick / (end + 60)) * 100))}%`;
      // A moment on the finish, then the video is done.
      if (this.tick > end + 60) void this.finishVideo();
    } else if (this.tick > end + 150) {
      this.tick = 0;
      this.app.rig.reset();
      this.lineView?.resetTracking();
    }
    const t = Math.min(this.tick, end);
    const p = ghostPose(this.ghost, t);
    if (!p) return;
    // A respawn in the recorded run, the loop back to the start or "From start" is a cut, not
    // motion, so the camera must not swoop after it. Over 30 m is always a cut (MAX_SPEED covers
    // 27.8 m in the largest 0.1 s frame), but the 2-tick samples spread a teleport over a frame
    // or two, so the samples crossed this frame are checked as well.
    const jump = Math.hypot(p.pos.x - this.lastPos.x, p.pos.y - this.lastPos.y, p.pos.z - this.lastPos.z);
    const cut = this.lastT < 0 || t < this.lastT || jump > 30 || this.teleports(this.lastT, t);
    this.lastT = t;
    if (cut) {
      this.app.rig.reset();
      this.side = null;
    }
    const vel = cut
      ? { x: 0, y: 0, z: 0 }
      : {
          x: (p.pos.x - this.lastPos.x) / Math.max(1e-3, dt),
          y: (p.pos.y - this.lastPos.y) / Math.max(1e-3, dt),
          z: (p.pos.z - this.lastPos.z) / Math.max(1e-3, dt),
        };
    this.lastPos = { ...p.pos };
    const sp = Math.hypot(vel.x, vel.z);
    // The class's own wheel radius spins its wheels; the recorded nitro push shows its flames and FOV kick.
    this.car.applyPose(
      p.pos,
      p.rot,
      p.steer,
      (sp * dt) / this.car.spec.wheelRadius,
      sp,
      cut ? 0 : ghostYawRate(this.ghost, t),
      cut ? 0 : ghostNitro(this.ghost, t),
    );
    this.app.rig.lean = this.car.lean;
    this.app.rig.boost = this.car.boost;
    this.lineView?.update(p.pos);
    this.drawTelemetry(t, sp * 3.6);

    // Shot selection.
    this.shotTime += dt;
    if (this.shotTime > 4.5) {
      this.shotTime = 0;
      this.shot = (this.shot + 1) % 3;
      this.side = null;
    }
    if (this.shot === 1) {
      if (!this.side) this.side = this.tracksidePoint(p.pos, p.rot);
      this.app.rig.trackside(this.side, { x: p.pos.x, y: p.pos.y + 0.6, z: p.pos.z });
      if (Math.hypot(this.side.x - p.pos.x, this.side.z - p.pos.z) > 140) this.side = this.tracksidePoint(p.pos, p.rot);
    } else if (this.shot === 2) {
      this.app.rig.mode = 'far';
      this.app.rig.follow(p.pos, p.rot, sp > 1 ? vel : { x: 0, y: 0, z: 0 }, dt, this.track);
    } else {
      this.app.rig.mode = 'chase';
      this.app.rig.follow(p.pos, p.rot, sp > 1 ? vel : { x: 0, y: 0, z: 0 }, dt, this.track);
    }
    this.app.world.focusShadow(p.pos.x, p.pos.y, p.pos.z);
  }

  private drawTelemetry(t: number, kmh: number): void {
    const g = this.ghost;
    const k = Math.floor(t) * INPUT_STRIDE;
    const u = g.inputs;
    const input =
      u && k + 3 < u.length ? { steer: u[k] / 127, gas: u[k + 1] / 255, brake: u[k + 2] / 255, nitro: u[k + 3] === 1 } : u?.length ? { steer: 0, gas: 0, brake: 1, nitro: false } : null;
    const ms = Math.min(g.time, Math.round(t * DT * 1000));
    const by = this.driver ? `${this.driver} \u00b7 ` : '';
    this.overlay.draw({
      title: `${this.title}: ${this.entry.label}`,
      subtitle: `${by}${formatTime(g.time)}${this.note ? ` \u00b7 ${this.note}` : ''}`,
      timeMs: ms,
      speedKmh: kmh,
      input,
      nitroOn: ghostNitro(g, t) > 0,
      splits: g.cpTimes.filter((c) => c <= ms).map((c, i) => `CP${i + 1} ${formatTime(c)}`),
    });
  }

  /** True when a ghost sample step between ticks a and b is longer than any car can drive in it. */
  private teleports(a: number, b: number): boolean {
    const g = this.ghost;
    const n = g.interval;
    const limit = MAX_SPEED * DT * n + 3; // +3 m for contact pushes
    for (let k = Math.max(0, Math.floor(a / n)); k * n < b; k++) {
      const p0 = ghostPose(g, k * n);
      const p1 = ghostPose(g, (k + 1) * n);
      if (p0 && p1 && Math.hypot(p1.pos.x - p0.pos.x, p1.pos.y - p0.pos.y, p1.pos.z - p0.pos.z) > limit) return true;
    }
    return false;
  }

  /** A camera position beside the road a little ahead of the car. */
  private tracksidePoint(at: V3, rot: Quat): V3 {
    const pts = this.route.points;
    if (!pts.length) return { x: at.x + 20, y: at.y + 6, z: at.z + 20 };
    const i = nearestPoint(this.route, at.x, at.y, at.z);
    const side = this.shot % 2 ? 1 : -1;
    // Far off the road (grass): a route-based point would be aimed from 100+ m away at the
    // narrowest FOV and re-picked every frame, so frame the car from its own heading instead.
    if (Math.hypot(pts[i].x - at.x, pts[i].y - at.y, pts[i].z - at.z) > 40) return this.offroadPoint(at, rot, side);
    let j = i;
    while (j < pts.length - 1 && pts[j].s - pts[i].s < 55) j++;
    const q = pts[j];
    return { x: q.x + q.hz * 20 * side, y: q.y + 5, z: q.z - q.hx * 20 * side };
  }

  /** 20 m beside and a little ahead of the car's own heading, kept inside the stadium walls. */
  private offroadPoint(at: V3, rot: Quat, side: number): V3 {
    const f = qrotate(rot, { x: 0, y: 0, z: 1 });
    const l = Math.hypot(f.x, f.z);
    // A car standing on its nose has no heading on the ground plane.
    const hx = l > 0.1 ? f.x / l : 0;
    const hz = l > 0.1 ? f.z / l : 1;
    const e = this.track.extents();
    const m = 2; // the wall's inner face is 0.5 m inside the extents
    const x0 = e.x0 + m, x1 = e.x1 - m, z0 = e.z0 + m, z1 = e.z1 - m;
    const at20 = (s: number): V3 => ({ x: at.x + hx * 20 + hz * 20 * s, y: at.y + 5, z: at.z + hz * 20 - hx * 20 * s });
    let q = at20(side);
    // Near the stadium wall, look from the open side rather than from behind the wall.
    if (q.x < x0 || q.x > x1 || q.z < z0 || q.z > z1) q = at20(-side);
    q.x = Math.max(x0, Math.min(x1, q.x));
    q.z = Math.max(z0, Math.min(z1, q.z));
    return q;
  }

  exit(): void {
    this.alive = false;
    this.recorder?.cancel();
    this.recorder = null;
    this.lineCancel?.();
    this.lineView?.dispose();
    this.overlay.dispose();
    this.car.dispose();
    this.app.rig.mode = this.app.store.settings.camera;
    this.app.rig.lean = 0;
    this.app.rig.boost = 0;
  }
}
