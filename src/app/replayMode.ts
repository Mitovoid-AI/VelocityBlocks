// Replay viewer: plays back a recorded ghost with alternating chase and trackside cameras.

import { DT, MAX_SPEED } from '../core/constants';
import { qrotate, type Quat, type V3 } from '../core/vec';
import { ghostEndTick, ghostPose, type Ghost } from '../game/ghost';
import { formatTime } from '../game/race';
import type { Action } from '../input/input';
import { CarView } from '../render/carView';
import { nearestPoint, traceRoute, type Route } from '../track/route';
import type { Track } from '../track/track';
import { esc, showScreen } from '../ui/dom';
import type { App, Mode } from './app';
import type { RaceEntry } from './raceMode';

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

  constructor(
    private readonly app: App,
    private readonly track: Track,
    private readonly ghost: Ghost,
    entry: RaceEntry,
    private readonly onExit: () => void,
  ) {
    this.car = new CarView(app.world.scene, app.playerCarOptions());
    this.route = traceRoute(track);
    app.hud.show(false);
    app.showTouch(false);
    app.rig.reset();
    showScreen(
      `<div class="row" style="position:absolute;top:calc(12px + var(--safe-t));left:calc(14px + var(--safe-l));right:calc(14px + var(--safe-r))">
        <div class="panel" style="padding:8px 14px"><b>REPLAY</b> &nbsp; ${esc(entry.label)} &nbsp; <span class="muted">${formatTime(ghost.time)}</span></div>
        <div class="spacer"></div>
        <button class="btn small" data-act="slow">Speed: 1x</button>
        <button class="btn small" data-act="restart">From start</button>
        <button class="btn small primary" data-act="exit">Exit replay</button>
      </div>`,
      'editor',
      {
        exit: () => this.onExit(),
        restart: () => {
          this.tick = 0;
          this.app.rig.reset();
        },
        slow: (el) => {
          this.speed = this.speed === 1 ? 0.5 : this.speed === 0.5 ? 0.25 : 1;
          el.textContent = `Speed: ${this.speed}x`;
        },
      },
    );
  }

  onAction(a: Action): void {
    if (a === 'pause' || a === 'restart') this.onExit();
  }

  update(dt: number): void {
    const end = ghostEndTick(this.ghost);
    this.tick += (dt / DT) * this.speed;
    if (this.tick > end + 150) {
      this.tick = 0;
      this.app.rig.reset();
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
    this.car.applyPose(p.pos, p.rot, p.steer, (sp * dt) / 0.36, sp);

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
    this.car.dispose();
    this.app.rig.mode = this.app.store.settings.camera;
  }
}
