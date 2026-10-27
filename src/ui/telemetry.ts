// Replay telemetry: what the driver was doing at each moment of a recorded run, from its input log: gas and
// brake pedals (bars with percentages), steering (a wheel with its angle), the nitro, the speed and the lap
// clock, plus the splits at the checkpoints passed. Drawn on a canvas over the 3D view (not DOM), so a replay
// video (app/replayVideo.ts) copies the same pixels into every frame.

export interface TelemetryFrame {
  /** Banner: track, who drove it and the lap time. */
  title: string;
  subtitle: string;
  timeMs: number;
  speedKmh: number;
  /** null when the run has no input log (recorded before input logs). */
  input: { steer: number; gas: number; brake: number; nitro: boolean } | null;
  /** The nitro was pushing. */
  nitroOn: boolean;
  /** Checkpoint splits passed so far, e.g. "CP1 0:03.21". */
  splits: readonly string[];
}

const GAS = '#3ee07a';
const BRAKE = '#ff5040';
const NITRO = '#9e6bff';
const PANEL = 'rgba(6, 10, 24, 0.62)';

function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export class TelemetryOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'telemetry';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  dispose(): void {
    this.canvas.remove();
  }

  draw(f: TelemetryFrame): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const x = this.ctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    // Scale the layout with the screen (designed for 640 x 360 CSS px).
    const u = Math.max(0.8, Math.min(1.6, Math.min(w / 640, h / 360)));
    x.font = `italic 800 ${14 * u}px system-ui, sans-serif`;
    x.textBaseline = 'middle';

    // Banner: under the replay's button row.
    const by = 58 * u;
    this.panel(12 * u, by, Math.max(x.measureText(f.title).width, 150 * u) + 20 * u, 44 * u);
    x.fillStyle = '#fff';
    x.fillText(f.title, 22 * u, by + 15 * u);
    x.font = `italic 600 ${11 * u}px system-ui, sans-serif`;
    x.fillStyle = '#c9d4ea';
    x.fillText(f.subtitle, 22 * u, by + 32 * u);

    // Splits down the left.
    x.font = `italic 700 ${11 * u}px system-ui, sans-serif`;
    f.splits.slice(-5).forEach((s, i) => {
      const y = by + 54 * u + i * 18 * u;
      this.panel(12 * u, y, 104 * u, 16 * u);
      x.fillStyle = '#dfe7f7';
      x.fillText(s, 20 * u, y + 8 * u);
    });

    // Clock and speed, bottom centre.
    const cx = w / 2;
    this.panel(cx - 84 * u, h - 62 * u, 168 * u, 50 * u);
    x.textAlign = 'center';
    x.fillStyle = '#fff';
    x.font = `italic 900 ${24 * u}px system-ui, sans-serif`;
    x.fillText(fmt(f.timeMs), cx, h - 44 * u);
    x.font = `italic 700 ${12 * u}px system-ui, sans-serif`;
    x.fillStyle = '#c9d4ea';
    x.fillText(`${Math.round(f.speedKmh)} km/h`, cx, h - 22 * u);
    x.textAlign = 'left';

    const inp = f.input;
    // Pedals, bottom right: brake then gas, filled to their travel, with the percentage.
    const ph = 110 * u, pw = 26 * u, py = h - 18 * u - ph;
    const pedal = (px: number, v: number, color: string, label: string) => {
      this.panel(px, py, pw, ph);
      x.fillStyle = color;
      const fh = (ph - 4 * u) * Math.max(0, Math.min(1, v));
      x.fillRect(px + 2 * u, py + ph - 2 * u - fh, pw - 4 * u, fh);
      x.textAlign = 'center';
      x.font = `italic 800 ${10 * u}px system-ui, sans-serif`;
      x.fillStyle = '#fff';
      x.fillText(label, px + pw / 2, py - 18 * u);
      x.fillText(inp ? `${Math.round(v * 100)}%` : '--', px + pw / 2, py - 7 * u);
      x.textAlign = 'left';
    };
    pedal(w - 16 * u - pw, inp?.gas ?? 0, GAS, 'GAS');
    pedal(w - 24 * u - 2 * pw, inp?.brake ?? 0, BRAKE, 'BRAKE');

    // Steering, bottom left: a wheel turned by the input, with an arc showing how far.
    const r = 34 * u, sx = 18 * u + r, sy = h - 22 * u - r;
    x.beginPath();
    x.arc(sx, sy, r + 6 * u, 0, Math.PI * 2);
    x.fillStyle = PANEL;
    x.fill();
    const steer = inp?.steer ?? 0;
    // Full lock drawn as 120 degrees of wheel turn.
    const ang = (steer * Math.PI * 2) / 3;
    x.lineWidth = 5 * u;
    x.strokeStyle = '#cfd8ea';
    x.beginPath();
    x.arc(sx, sy, r, 0, Math.PI * 2);
    x.stroke();
    if (Math.abs(steer) > 0.01) {
      x.strokeStyle = '#ffcf3f';
      x.beginPath();
      x.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + ang, ang < 0);
      x.stroke();
    }
    x.save();
    x.translate(sx, sy);
    x.rotate(ang);
    x.strokeStyle = '#fff';
    x.lineWidth = 4 * u;
    x.beginPath();
    x.moveTo(-r, 0);
    x.lineTo(r, 0);
    x.moveTo(0, 0);
    x.lineTo(0, r);
    x.moveTo(0, -r);
    x.lineTo(0, -r + 8 * u);
    x.stroke();
    x.restore();
    x.textAlign = 'center';
    x.font = `italic 800 ${10 * u}px system-ui, sans-serif`;
    x.fillStyle = '#fff';
    x.fillText(inp ? `${steer < 0 ? 'L' : steer > 0 ? 'R' : ''} ${Math.round(Math.abs(steer) * 100)}%` : 'no input log', sx, sy - r - 14 * u);
    x.textAlign = 'left';

    // Nitro, beside the wheel.
    const nx = sx + r + 18 * u, ny = sy + r - 22 * u;
    this.panel(nx, ny, 58 * u, 22 * u);
    x.fillStyle = f.nitroOn || inp?.nitro ? NITRO : 'rgba(255,255,255,0.35)';
    x.font = `italic 900 ${12 * u}px system-ui, sans-serif`;
    x.fillText('N₂O', nx + 10 * u, ny + 11 * u);
  }

  private panel(px: number, py: number, pw: number, ph: number): void {
    const x = this.ctx;
    x.fillStyle = PANEL;
    x.beginPath();
    x.roundRect(px, py, pw, ph, Math.min(8, ph / 2));
    x.fill();
  }
}
