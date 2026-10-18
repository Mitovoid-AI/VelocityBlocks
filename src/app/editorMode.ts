// Grid track editor: place/rotate/erase blocks across levels, validate, test drive, save and share.

import * as THREE from 'three';
import { CELL, GRID, LEVEL_H, MAX_LEVEL, wrapDir, type Dir } from '../core/constants';
import { runBot } from '../game/bot';
import { formatTime } from '../game/race';
import { newId, type SavedTrack } from '../game/storage';
import type { Action } from '../input/input';
import { buildTrackVisual, type TrackVisual } from '../render/trackMesh';
import { BLOCK_LIST, type BlockType } from '../track/blocks';
import { exportTrack, importTrack } from '../track/format';
import { traceRoute } from '../track/route';
import { cellsFor, Track, type Placement, type TrackData } from '../track/track';
import { $, downloadText, esc, pickTextFile, showScreen, toast } from '../ui/dom';
import type { App, Mode } from './app';

const DIR_NAMES = ['N', 'E', 'S', 'W'];

const blankTrack = (author: string): TrackData => ({ name: 'My track', author, blocks: [] });

export class EditorMode implements Mode {
  private id: string;
  private data: TrackData;
  private type: BlockType = 'straight';
  private dir: Dir = 0;
  private level = 0;
  private erase = false;
  private undo: Placement[][] = [];
  private track!: Track;
  private visual: TrackVisual | null = null;
  private preview: TrackVisual | null = null;
  private previewKey = '';
  private grid: THREE.Group;
  private hover: { i: number; j: number } | null = null;
  private target = new THREE.Vector3(GRID * CELL * 0.5, 0, GRID * CELL * 0.5);
  private yaw = Math.PI * 0.25;
  private pitch = 0.95;
  private dist = 700;
  private pointers = new Map<number, { x: number; y: number }>();
  /** Furthest the first finger (or mouse) has strayed from where it went down, in CSS px. */
  private dragMoved = 0;
  private down = { x: 0, y: 0 };
  /** Movement below this still counts as a tap. Fingers wobble more than a mouse. */
  private slop = 6;
  /** A second finger joined the gesture, so lifting fingers must not tap. */
  private multi = false;
  /** Distance and angle between two fingers at the last move; pinch 0 means not measured yet. */
  private pinch = 0;
  private twist = 0;
  /** Direction the view turns while a turn button is held (-1, 0 or 1), and by which pointer. */
  private spin = 0;
  private spinPointer = -1;
  private screenEl: HTMLElement | null = null;
  private readonly ray = new THREE.Raycaster();
  private listeners: [EventTarget, string, EventListener][] = [];
  private dirty = true;

  /** `saved` is the track to edit (a saved one or the draft); null starts a new, empty track. */
  constructor(
    private readonly app: App,
    saved: SavedTrack | null,
  ) {
    this.id = saved?.id ?? newId();
    this.data = saved
      ? { ...saved.data, blocks: saved.data.blocks.map((b) => ({ ...b })) }
      : blankTrack(app.store.profile.name);
    this.grid = new THREE.Group();
    this.frameBlocks();
  }

  /** Point the camera at the middle of the existing blocks. */
  private frameBlocks(): void {
    const cells = this.data.blocks.flatMap((b) => cellsFor(b));
    if (!cells.length) {
      this.dist = 700;
      return;
    }
    const is = cells.map((c) => c[0]);
    const js = cells.map((c) => c[1]);
    const i0 = Math.min(...is), i1 = Math.max(...is) + 1;
    const j0 = Math.min(...js), j1 = Math.max(...js) + 1;
    this.target.set(((i0 + i1) / 2) * CELL, 0, ((j0 + j1) / 2) * CELL);
    this.dist = Math.max(220, Math.min(1100, Math.max(i1 - i0, j1 - j0) * CELL * 1.25));
  }

  /** (Re)attach the editor to the scene and UI. */
  enter(): void {
    const app = this.app;
    app.hud.show(false);
    app.showTouch(false);
    app.input.enabled = false;
    this.rebuild();
    this.buildGrid();
    app.world.scene.add(this.grid);
    this.renderUi();
    const c = app.world.canvas;
    this.pointers.clear();
    this.spin = 0;
    this.on(c, 'pointerdown', (e) => this.pointerDown(e as PointerEvent));
    this.on(window, 'pointermove', (e) => this.pointerMove(e as PointerEvent));
    this.on(window, 'pointerup', (e) => this.pointerUp(e as PointerEvent));
    this.on(window, 'pointercancel', (e) => {
      if (!this.pointers.delete((e as PointerEvent).pointerId)) return;
      this.pinch = 0;
      this.multi = this.pointers.size > 0;
    });
    // A held turn button stops wherever its finger or mouse button is let go.
    const endSpin = (e: Event) => {
      if ((e as PointerEvent).pointerId === this.spinPointer) this.spin = 0;
    };
    this.on(window, 'pointerup', endSpin);
    this.on(window, 'pointercancel', endSpin);
    // Stops Android's long-press gesture (a haptic buzz when a finger rests before panning).
    this.on(c, 'touchstart', (e) => e.preventDefault());
    this.on(c, 'wheel', (e) => {
      const w = e as WheelEvent;
      w.preventDefault();
      this.dist = Math.max(60, Math.min(1400, this.dist * (1 + Math.sign(w.deltaY) * 0.1)));
    });
    this.on(c, 'contextmenu', (e) => e.preventDefault());
    this.on(window, 'keydown', (e) => this.key(e as KeyboardEvent));
  }

  private on(t: EventTarget, ev: string, fn: EventListener): void {
    t.addEventListener(ev, fn, { passive: false });
    this.listeners.push([t, ev, fn]);
  }

  exit(): void {
    this.listeners.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
    this.listeners = [];
    this.spin = 0;
    this.app.world.scene.remove(this.grid);
    this.visual && this.app.world.scene.remove(this.visual.group);
    this.visual?.dispose();
    this.visual = null;
    this.clearPreview();
    this.app.input.enabled = true;
    this.saveDraft();
  }

  onAction(_a: Action): void {}

  // ------------------------------------------------------------ state

  private saveDraft(): void {
    this.app.store.saveEditorDraft({ id: this.id, data: this.data, updated: Date.now() });
  }

  private commit(next: Placement[]): void {
    this.undo.push(this.data.blocks);
    if (this.undo.length > 100) this.undo.shift();
    this.data = { ...this.data, blocks: next, authorTime: undefined };
    this.dirty = true;
    this.rebuild();
    this.saveDraft();
    this.updateStatus();
  }

  private rebuild(): void {
    const world = this.app.world;
    world.setTrack(null);
    this.track = new Track(this.data);
    if (this.visual) {
      world.scene.remove(this.visual.group);
      this.visual.dispose();
    }
    this.visual = buildTrackVisual(this.track);
    world.scene.add(this.visual.group);
    this.previewKey = '';
  }

  private buildGrid(): void {
    this.grid.clear();
    const size = GRID * CELL;
    const g = new THREE.GridHelper(size, GRID, 0xffffff, 0xffffff);
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.35;
    g.position.set(size / 2, this.level * LEVEL_H + 0.08, size / 2);
    this.grid.add(g);
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(size, 0.1, size)),
      new THREE.LineBasicMaterial({ color: 0xffcf3f }),
    );
    frame.position.copy(g.position);
    this.grid.add(frame);
  }

  // ------------------------------------------------------------ placement

  private occupied(cells: [number, number, number][], ignore?: Placement): boolean {
    const set = new Set(cells.map((c) => c.join(',')));
    return this.data.blocks.some((b) => b !== ignore && cellsFor(b).some((c) => set.has(c.join(','))));
  }

  private candidate(i: number, j: number): { p: Placement; ok: boolean; reason: string } {
    const p: Placement = { type: this.type, i, j, k: this.level, dir: this.dir };
    const cells = cellsFor(p);
    if (cells.some(([ci, cj, ck]) => ci < 0 || cj < 0 || ci >= GRID || cj >= GRID || ck < 0 || ck > MAX_LEVEL))
      return { p, ok: false, reason: 'Outside the grid' };
    if (this.occupied(cells)) return { p, ok: false, reason: 'Space taken' };
    if (p.type === 'start' && this.data.blocks.some((b) => b.type === 'start'))
      return { p, ok: false, reason: 'Only one Start' };
    return { p, ok: true, reason: '' };
  }

  private place(i: number, j: number): void {
    if (this.erase) {
      const hit = this.blockAt(i, j);
      if (hit) this.commit(this.data.blocks.filter((b) => b !== hit));
      return;
    }
    const c = this.candidate(i, j);
    if (!c.ok) {
      toast(c.reason, 1200);
      return;
    }
    this.commit([...this.data.blocks, c.p]);
    this.app.audio.click();
    // Advance the cursor along the road so tapping again keeps building.
    const nx = new Track({ name: '', author: '', blocks: [c.p] }).blocks[0].nextAnchor();
    if (nx.k >= 0 && nx.k <= MAX_LEVEL) {
      this.dir = nx.dir;
      if (nx.k !== this.level) {
        this.level = nx.k;
        this.buildGrid();
      }
      this.hover = { i: nx.i, j: nx.j };
      this.updateToolbar();
    }
  }

  /** Block occupying (i, j) on the current level, else the top-most one in that column. */
  private blockAt(i: number, j: number): Placement | null {
    let best: Placement | null = null;
    for (const b of this.data.blocks) {
      for (const [ci, cj, ck] of cellsFor(b)) {
        if (ci !== i || cj !== j) continue;
        if (ck === this.level) return b;
        if (!best || b.k > best.k) best = b;
      }
    }
    return best;
  }

  private clearPreview(): void {
    if (this.preview) {
      this.app.world.scene.remove(this.preview.group);
      this.preview.dispose();
      this.preview = null;
    }
  }

  private updatePreview(): void {
    if (!this.hover) {
      this.clearPreview();
      this.previewKey = '';
      return;
    }
    const { i, j } = this.hover;
    if (this.erase) {
      const b = this.blockAt(i, j);
      const key = b ? `e${b.type}${b.i},${b.j},${b.k},${b.dir}` : 'e-';
      if (key === this.previewKey) return;
      this.previewKey = key;
      this.clearPreview();
      if (b) {
        this.preview = buildTrackVisual(new Track({ name: '', author: '', blocks: [b] }), { ghostColor: 0xff3344, light: true });
        this.preview.group.position.y = 0.05;
        this.app.world.scene.add(this.preview.group);
      }
      return;
    }
    const c = this.candidate(i, j);
    const key = `${c.p.type}${i},${j},${c.p.k},${c.p.dir}${c.ok}`;
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.clearPreview();
    this.preview = buildTrackVisual(new Track({ name: '', author: '', blocks: [c.p] }), {
      ghostColor: c.ok ? 0x3fe0ff : 0xff3344,
      light: true,
    });
    this.preview.group.position.y = 0.1;
    this.app.world.scene.add(this.preview.group);
  }

  // ------------------------------------------------------------ input

  private pick(x: number, y: number): { i: number; j: number } | null {
    const rect = this.app.world.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.app.world.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.level * LEVEL_H);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(plane, hit)) return null;
    const i = Math.floor(hit.x / CELL);
    const j = Math.floor(hit.z / CELL);
    if (i < 0 || j < 0 || i >= GRID || j >= GRID) return null;
    return { i, j };
  }

  private pointerDown(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragMoved = 0;
      this.down = { x: e.clientX, y: e.clientY };
      this.slop = e.pointerType === 'mouse' ? 6 : 12;
      this.multi = false;
      // The cancelled touchstart keeps focus in the name field; drop it to close the keyboard.
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.tagName === 'INPUT') focused.blur();
    } else {
      this.multi = true;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
        this.twist = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') {
        const h = this.pick(e.clientX, e.clientY);
        if (h?.i !== this.hover?.i || h?.j !== this.hover?.j) this.hover = h;
      }
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    // Distance from the start point, not path length: finger jitter on a real touchscreen
    // adds up to several px of path during an ordinary tap.
    this.dragMoved = Math.max(this.dragMoved, Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinch > 0) {
        this.dist = Math.max(60, Math.min(1400, this.dist * (this.pinch / d)));
        // Twisting the fingers turns the grid with them (clockwise twist, clockwise grid).
        // The change is wrapped so crossing +-180 degrees doesn't spin the view round.
        const turn = angle - this.twist;
        this.yaw += Math.atan2(Math.sin(turn), Math.cos(turn));
      }
      this.pinch = d;
      this.twist = angle;
      return;
    }
    if (this.dragMoved < this.slop) return;
    const rotate = e.buttons === 2 || e.shiftKey;
    if (rotate) {
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(0.35, Math.min(1.45, this.pitch + dy * 0.004));
    } else {
      // Pan in the ground plane.
      const k = this.dist / 700;
      // Screen-right and screen-forward directions on the ground plane.
      const sx = -Math.cos(this.yaw), sz = Math.sin(this.yaw);
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.target.x -= (dx * sx - dy * fx) * k;
      this.target.z -= (dx * sz - dy * fz) * k;
      const max = GRID * CELL;
      this.target.x = Math.max(0, Math.min(max, this.target.x));
      this.target.z = Math.max(0, Math.min(max, this.target.z));
    }
  }

  private pointerUp(e: PointerEvent): void {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    // Re-measure on the next move: going from three fingers to two pairs up different ones.
    if (had) this.pinch = 0;
    const multi = this.multi;
    if (this.pointers.size === 0) this.multi = false;
    if (!had || multi || this.dragMoved >= this.slop) return;
    if (e.target !== this.app.world.canvas) return;
    const h = this.pick(e.clientX, e.clientY);
    if (!h) return;
    if (e.button === 2) {
      const prev = this.erase;
      this.erase = true;
      this.place(h.i, h.j);
      this.erase = prev;
      return;
    }
    // On touch, the first tap moves the cursor; tapping the same cell again places.
    if (e.pointerType !== 'mouse' && (this.hover?.i !== h.i || this.hover?.j !== h.j)) {
      this.hover = h;
      return;
    }
    this.hover = h;
    this.place(h.i, h.j);
  }

  private key(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'KeyR') this.rotate(1);
    else if (e.code === 'KeyQ') this.yaw += 0.2;
    else if (e.code === 'KeyE' && !e.ctrlKey) this.yaw -= 0.2;
    else if (e.code === 'PageUp' || e.code === 'Equal') this.setLevel(this.level + 1);
    else if (e.code === 'PageDown' || e.code === 'Minus') this.setLevel(this.level - 1);
    else if (e.code === 'KeyX' || e.code === 'Delete') this.toggleErase();
    else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) this.doUndo();
    else if (e.code === 'Enter' && this.hover) this.place(this.hover.i, this.hover.j);
    else if (e.code.startsWith('Arrow') && this.hover) {
      const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.code]!;
      this.hover = {
        i: Math.max(0, Math.min(GRID - 1, this.hover.i + d[0])),
        j: Math.max(0, Math.min(GRID - 1, this.hover.j + d[1])),
      };
      e.preventDefault();
    } else return;
    e.preventDefault();
  }

  private rotate(n: number): void {
    this.dir = wrapDir(this.dir + n);
    this.updateToolbar();
  }

  private setLevel(l: number): void {
    this.level = Math.max(0, Math.min(MAX_LEVEL, l));
    this.buildGrid();
    this.updateToolbar();
    this.previewKey = '';
  }

  private toggleErase(): void {
    this.erase = !this.erase;
    this.updateToolbar();
    this.previewKey = '';
  }

  private doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.data = { ...this.data, blocks: prev, authorTime: undefined };
    this.rebuild();
    this.saveDraft();
    this.updateStatus();
  }

  // ------------------------------------------------------------ UI

  private renderUi(): void {
    const palette = BLOCK_LIST.map(
      (b) => `<button class="btn ${b.type === this.type ? 'sel' : ''}" data-act="type" data-type="${b.type}">${esc(b.label)}</button>`,
    ).join('');
    this.screenEl = showScreen(
      `<div class="ed-top">
         <button class="btn small" data-act="back">&#8592; Menu</button>
         <input id="ed-name" type="text" maxlength="40" value="${esc(this.data.name)}" aria-label="Track name"/>
         <button class="btn small" data-act="new">New</button>
         <button class="btn small" data-act="save">Save</button>
         <button class="btn small" data-act="export">Export</button>
         <button class="btn small" data-act="import">Import</button>
         <div class="spacer"></div>
         <button class="btn small" data-act="validate">Autopilot check</button>
         <button class="btn small primary" data-act="test">&#9654; Test drive</button>
       </div>
       <div class="ed-palette">${palette}</div>
       <div class="ed-bottom">
         <button class="btn small" data-act="rot" title="Rotate (R)">&#10227; <span id="ed-dir"></span></button>
         <button class="btn small" data-act="down" title="Level down (PgDn)">&#9660;</button>
         <span class="ed-status" id="ed-level"></span>
         <button class="btn small" data-act="up" title="Level up (PgUp)">&#9650;</button>
         <button class="btn small" data-act="erase" id="ed-erase" title="Erase (X)">Erase</button>
         <button class="btn small" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
         <button class="btn small ed-turn" data-spin="-1" title="Turn view (E)" aria-label="Turn view anticlockwise">&#8630;</button>
         <button class="btn small ed-turn" data-spin="1" title="Turn view (Q)" aria-label="Turn view clockwise">&#8631;</button>
         <span class="ed-status" id="ed-status"></span>
       </div>`,
      'editor',
      {
        back: () => this.app.closeEditor(),
        type: (el) => {
          this.type = el.dataset.type as BlockType;
          this.erase = false;
          this.screenEl!.querySelectorAll('.ed-palette .btn').forEach((b) => b.classList.toggle('sel', b === el));
          this.updateToolbar();
          this.previewKey = '';
        },
        rot: () => this.rotate(1),
        up: () => this.setLevel(this.level + 1),
        down: () => this.setLevel(this.level - 1),
        erase: () => this.toggleErase(),
        undo: () => this.doUndo(),
        new: () => {
          if (this.data.blocks.length && !confirm('Start a new empty track? Unsaved changes to this one are lost.')) return;
          this.id = newId();
          this.undo = [];
          this.data = blankTrack(this.app.store.profile.name);
          ($('#ed-name', this.screenEl!) as HTMLInputElement).value = this.data.name;
          this.rebuild();
          this.saveDraft();
          this.updateStatus();
        },
        save: () => {
          this.app.store.saveCustomTrack({ id: this.id, data: this.data, updated: Date.now() });
          this.dirty = false;
          toast(`Saved "${this.data.name}" to My tracks`);
        },
        export: () => downloadText(`${this.data.name.replace(/[^\w-]+/g, '_') || 'track'}.vbtrack.json`, exportTrack(this.data)),
        import: async () => {
          const text = await pickTextFile();
          if (!text) return;
          try {
            const data = importTrack(text);
            this.undo.push(this.data.blocks);
            this.id = newId();
            this.data = data;
            ($('#ed-name', this.screenEl!) as HTMLInputElement).value = data.name;
            this.frameBlocks();
            this.rebuild();
            this.saveDraft();
            this.updateStatus();
            toast(`Loaded "${data.name}"`);
          } catch (e) {
            toast((e as Error).message, 3200);
          }
        },
        validate: () => {
          const v = this.validation();
          if (!v.ok) return toast(v.msg, 2600);
          toast('Autopilot is driving your track...', 1200);
          setTimeout(() => {
            const r = runBot(new Track(this.data), 300);
            toast(
              r.finished
                ? `Autopilot finished in ${formatTime(r.time)}${r.respawns ? ` with ${r.respawns} respawn(s)` : ''}. Beat it in a test drive to set the author time.`
                : 'The autopilot could not finish. Check jumps and tight turns.',
              4000,
            );
          }, 50);
        },
        test: () => this.testDrive(),
      },
    );
    const nameInput = $('#ed-name', this.screenEl) as HTMLInputElement;
    nameInput.addEventListener('input', () => {
      this.data = { ...this.data, name: nameInput.value.trim() || 'My track' };
      this.saveDraft();
    });
    // The view turns for as long as a turn button is held, so a tap nudges it and a hold
    // goes all the way round. They act on pointerdown, like the race pills, because Android
    // sends no click for a tap made while another finger is down.
    this.screenEl.querySelectorAll<HTMLButtonElement>('[data-spin]').forEach((b) => {
      const dir = Number(b.dataset.spin);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        // Capture keeps the mouse's pointerup coming even if it is let go outside the window.
        b.setPointerCapture(e.pointerId);
        this.spin = dir;
        this.spinPointer = e.pointerId;
        // No click follows, so focus stays in the name field; drop it to close the keyboard.
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.tagName === 'INPUT') focused.blur();
      });
      b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      // Clicks not made by a pointer (keyboard, accessibility actions) have detail 0.
      b.addEventListener('click', (e) => {
        if (e.detail === 0) this.yaw += dir * 0.2;
      });
    });
    this.updateToolbar();
    this.updateStatus();
  }

  private updateToolbar(): void {
    if (!this.screenEl) return;
    $('#ed-dir', this.screenEl).textContent = DIR_NAMES[this.dir];
    $('#ed-level', this.screenEl).textContent = `Level ${this.level}`;
    $('#ed-erase', this.screenEl).classList.toggle('primary', this.erase);
  }

  private validation(): { ok: boolean; msg: string } {
    const starts = this.data.blocks.filter((b) => b.type === 'start').length;
    const finishes = this.data.blocks.filter((b) => b.type === 'finish').length;
    if (!starts) return { ok: false, msg: 'Place a Start block.' };
    if (!finishes) return { ok: false, msg: 'Place at least one Finish block.' };
    const route = traceRoute(this.track);
    if (!route.complete) return { ok: false, msg: 'The road from Start does not reach a Finish yet (blocks must connect end to end).' };
    return { ok: true, msg: `Route OK: ${Math.round(route.length)} m, ${this.track.checkpointCount} checkpoint(s).` };
  }

  private updateStatus(): void {
    if (!this.screenEl) return;
    const v = this.validation();
    const el = $('#ed-status', this.screenEl);
    const at = this.data.authorTime ? ` Author time ${formatTime(this.data.authorTime)}.` : v.ok ? ' Finish a test drive to set the author time.' : '';
    el.textContent = `${this.data.blocks.length} blocks. ${v.msg}${at}`;
    el.className = `ed-status ${v.ok ? 'ok' : 'warn'}`;
  }

  private testDrive(): void {
    const v = this.validation();
    if (!this.track.start) return toast('Place a Start block first.');
    if (!this.data.blocks.some((b) => b.type === 'finish')) return toast('Place a Finish block first.');
    if (!v.ok) toast(v.msg, 2500);
    this.saveDraft();
    const entry = this.app.customEntry(this.data, true, (time) => {
      if (!this.data.authorTime || time < this.data.authorTime) {
        this.data = { ...this.data, authorTime: time };
        this.saveDraft();
        if (!this.dirty) this.app.store.saveCustomTrack({ id: this.id, data: this.data, updated: Date.now() });
      }
    });
    this.app.startRace(entry);
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.yaw += this.spin * dt * 1.6;
    const cam = this.app.world.camera;
    const cp = Math.cos(this.pitch);
    cam.up.set(0, 1, 0);
    cam.position.set(
      this.target.x - Math.sin(this.yaw) * this.dist * cp,
      this.target.y + this.level * LEVEL_H + Math.sin(this.pitch) * this.dist,
      this.target.z - Math.cos(this.yaw) * this.dist * cp,
    );
    cam.lookAt(this.target.x, this.level * LEVEL_H, this.target.z);
    if (cam.fov !== 50) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
    this.app.world.focusShadow(this.target.x, 0, this.target.z);
    this.updatePreview();
  }
}

