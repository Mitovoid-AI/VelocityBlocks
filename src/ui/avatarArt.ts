// Avatar drawing shared by the 3D badge and the DOM profile card: the car-colour ring, the
// cover-cropped photo or a dummy silhouette, and a small decoded-image cache.
// No three.js and no DOM access at module top level, so node tests can import it.

import { isPhotoDataUrl } from '../core/photo';

/** Edge of the canvas the DOM dummy image is drawn on. */
const DUMMY_PX = 128;

// One decoded image, shared by every badge and kept independent of the order modes are
// created and exited in (the next mode can be built before the old one is disposed).
let cachedUrl: string | null = null;
let cachedImg: HTMLImageElement | null = null;
let pending: Promise<HTMLImageElement | null> | null = null;

/** The decoded image for url if it is the one in the cache, else null. */
export function peekAvatarImage(url: string): HTMLImageElement | null {
  return url === cachedUrl ? cachedImg : null;
}

/** Decode a photo off the main thread. Never rejects: resolves null on bad data. */
export function loadAvatarImage(url: string): Promise<HTMLImageElement | null> {
  if (url === cachedUrl && pending) return pending;
  cachedUrl = url;
  cachedImg = null;
  pending = new Promise<HTMLImageElement | null>((res) => {
    try {
      const img = new Image();
      let done = false;
      const ready = () => {
        if (done) return;
        done = true;
        const ok = img.naturalWidth > 0 && img.naturalHeight > 0;
        if (ok && cachedUrl === url) cachedImg = img;
        res(ok ? img : null);
      };
      const fail = () => {
        if (done) return;
        done = true;
        res(null);
      };
      // Chrome can hold decode() back while the page isn't rendering (hidden, or just back
      // from the photo chooser), so the load event also counts, as in squarePhoto.
      img.onload = ready;
      img.onerror = fail;
      img.src = url;
      // src never changes, so a rejection means a broken image, unless it has a size anyway.
      img.decode().then(ready, () => (img.naturalWidth > 0 ? ready() : fail()));
    } catch {
      res(null);
    }
  });
  return pending;
}

/** Inner-disc dummy: a grey head-and-shoulders silhouette. The caller clips to the disc. */
function drawDummy(g: CanvasRenderingContext2D, c: number, r0: number): void {
  const grad = g.createLinearGradient(0, c - r0, 0, c + r0);
  grad.addColorStop(0, '#5b6b84');
  grad.addColorStop(1, '#2a3346');
  g.fillStyle = grad;
  g.fillRect(c - r0, c - r0, 2 * r0, 2 * r0);
  g.fillStyle = '#dfe6f0';
  g.beginPath();
  g.arc(c, c - 0.18 * r0, 0.36 * r0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(c, c + 0.78 * r0, 0.72 * r0, 0.52 * r0, 0, 0, Math.PI * 2);
  g.fill();
}

function disc(g: CanvasRenderingContext2D, c: number, r: number, fill: string): void {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fill();
}

/**
 * Full badge on an S x S canvas: dark outline, car-colour ring, white separator, then the
 * photo cover-cropped into the inner disc (or the dummy when img is null).
 */
export function drawAvatar(g: CanvasRenderingContext2D, S: number, img: HTMLImageElement | null, ring: string): void {
  const c = S / 2;
  g.clearRect(0, 0, S, S);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  // The outline also hides the dark fringe that un-premultiplied alpha leaves at the edge.
  disc(g, c, c - 1, 'rgba(10,14,20,0.85)');
  disc(g, c, c - 3, ring);
  disc(g, c, c - 8, '#ffffff');
  const r0 = c - 10;
  g.save();
  g.beginPath();
  g.arc(c, c, r0, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = '#2a3346'; // backing for transparent PNGs
  g.fillRect(c - r0, c - r0, 2 * r0, 2 * r0);
  if (img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.max((2 * r0) / w, (2 * r0) / h);
    g.drawImage(img, c - (w * k) / 2, c - (h * k) / 2, w * k, h * k);
  } else {
    drawDummy(g, c, r0);
  }
  g.restore();
}

let dummyUrl: string | null = null;

/** PNG data URL of the dummy silhouette (inner disc only; CSS paints the ring). '' on failure. */
export function dummyAvatarDataUrl(): string {
  if (dummyUrl !== null) return dummyUrl;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = DUMMY_PX;
    const g = cv.getContext('2d');
    if (!g) return '';
    const c = DUMMY_PX / 2;
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.clip();
    drawDummy(g, c, c);
    dummyUrl = cv.toDataURL('image/png');
  } catch {
    return '';
  }
  return dummyUrl;
}

/** Image source for a DOM avatar: the validated photo, else the dummy. Callers esc() it and omit src when ''. */
export function avatarSrc(photo: string | null): string {
  return isPhotoDataUrl(photo) ? photo : dummyAvatarDataUrl();
}
