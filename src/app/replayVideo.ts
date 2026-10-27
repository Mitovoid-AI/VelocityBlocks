// Replay video: records what the replay shows (the 3D view plus the telemetry overlay) into a video file to
// share (WhatsApp and the like). Each drawn frame is copied, with the overlay, into a 2D canvas right after
// it is rendered (the WebGL canvas is only readable then), and that canvas is recorded with MediaRecorder.
// MP4 (H.264) where the WebView can encode it (Chrome 126+: most phones), which WhatsApp plays inline;
// WebM otherwise, which it sends as a file.

/** Longest side of the video (px). */
const MAX_SIDE = 1280;
const FPS = 30;
const BITRATE = 6_000_000;

const TYPES = ['video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** Whether this browser can record a video at all. */
export function canRecordVideo(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && TYPES.some((t) => MediaRecorder.isTypeSupported(t));
}

export class VideoRecorder {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rec: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly done: Promise<Blob>;
  readonly type: string;

  constructor(
    private readonly view: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
  ) {
    const k = Math.min(1, MAX_SIDE / Math.max(view.width, view.height));
    // Even sizes: H.264 encoders refuse odd ones.
    this.canvas.width = Math.round((view.width * k) / 2) * 2;
    this.canvas.height = Math.round((view.height * k) / 2) * 2;
    this.ctx = this.canvas.getContext('2d')!;
    this.type = TYPES.find((t) => MediaRecorder.isTypeSupported(t))!;
    this.rec = new MediaRecorder(this.canvas.captureStream(FPS), { mimeType: this.type, videoBitsPerSecond: BITRATE });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.done = new Promise((resolve) => (this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.type.split(';')[0] }))));
    this.rec.start(1000);
  }

  /** The file extension for this recording. */
  get ext(): string {
    return this.type.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  /** Copy the frame just rendered, with the overlay over it. Call right after the 3D view is drawn. */
  frame(): void {
    const { width: w, height: h } = this.canvas;
    this.ctx.drawImage(this.view, 0, 0, w, h);
    this.ctx.drawImage(this.overlay, 0, 0, w, h);
  }

  stop(): Promise<Blob> {
    if (this.rec.state !== 'inactive') this.rec.stop();
    return this.done;
  }

  /** Stop and drop the recording. */
  cancel(): void {
    if (this.rec.state !== 'inactive') this.rec.stop();
  }
}
