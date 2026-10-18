// Turns a picked image into the small square profile photo, entirely on the device.
// No DOM access at module top level, so node tests can import cropRect.

import { isPhotoDataUrl, PHOTO_PX } from '../core/photo';

/** JPEG qualities tried in order until the result is small enough. */
export const PHOTO_QUALITIES: readonly number[] = [0.85, 0.72, 0.6];
/** About 30 KB of JPEG as base64. */
export const PHOTO_TARGET_CHARS = 40_000;
/** Bigger files are refused before decoding (a 50 MP photo can exhaust a phone's memory). */
export const PHOTO_MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Fills transparent PNG areas, which JPEG can't keep. */
export const PHOTO_BG = '#1b2448';
/** Portrait crops lean towards the top third, where the face usually is. */
export const PORTRAIT_FACE_BIAS = 0.3;

/** The largest centred square of a w x h image (biased up for portraits). */
export function cropRect(w: number, h: number): { sx: number; sy: number; s: number } {
  const s = Math.min(w, h);
  return {
    sx: Math.round((w - s) / 2),
    sy: Math.round(h > w ? (h - s) * PORTRAIT_FACE_BIAS : (h - s) / 2),
    s: Math.round(s),
  };
}

function canvas(size: number): { cv: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  if (!g) throw new Error('no 2d canvas');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  return { cv, g };
}

/**
 * Crop and downscale an image file to a size x size JPEG data URL. Rejects for anything the
 * browser can't decode (HEIC, corrupt files, non-images).
 */
export async function squarePhoto(
  file: Blob,
  size = PHOTO_PX,
  qualities: readonly number[] = PHOTO_QUALITIES,
): Promise<string> {
  const url = URL.createObjectURL(file);
  const canvases: HTMLCanvasElement[] = [];
  try {
    // An <img> rather than createImageBitmap: Chrome 81+ applies the EXIF orientation to
    // naturalWidth/Height and drawImage, so camera portraits come out upright.
    const img = new Image();
    const load = new Promise<void>((res, rej) => {
      img.addEventListener('load', () => res(), { once: true });
      img.addEventListener('error', () => rej(new Error('not an image')), { once: true });
    });
    img.src = url;
    // decode() rejects for HEIC and corrupt files, but Chrome holds it back while the page
    // isn't rendering (just back from the chooser, hidden), so the load event also counts.
    const decode = img.decode();
    // The loser of the race may still reject later; that is not an error.
    decode.catch(() => {});
    load.catch(() => {});
    await Promise.race([decode, load]);
    const { sx, sy, s } = cropRect(img.naturalWidth, img.naturalHeight);
    if (s <= 0) throw new Error('empty image');
    let src: CanvasImageSource = img;
    let srcX = sx, srcY = sy, srcS = s;
    // One big downscale step skips most source pixels; halve through an intermediate first.
    if (s > size * 4) {
      const mid = canvas(size * 2);
      canvases.push(mid.cv);
      mid.g.drawImage(img, sx, sy, s, s, 0, 0, size * 2, size * 2);
      src = mid.cv;
      srcX = srcY = 0;
      srcS = size * 2;
    }
    const out = canvas(size);
    canvases.push(out.cv);
    out.g.fillStyle = PHOTO_BG;
    out.g.fillRect(0, 0, size, size);
    out.g.drawImage(src, srcX, srcY, srcS, srcS, 0, 0, size, size);
    let data = '';
    for (const q of qualities) {
      data = out.cv.toDataURL('image/jpeg', q);
      if (data.length <= PHOTO_TARGET_CHARS) break;
    }
    if (!isPhotoDataUrl(data)) throw new Error('encode failed');
    return data;
  } finally {
    URL.revokeObjectURL(url);
    // Release the pixel buffers now rather than at the next GC.
    for (const cv of canvases) cv.width = cv.height = 0;
  }
}
