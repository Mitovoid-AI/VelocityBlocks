// Validation for the driver's profile photo: a small inline image kept in localStorage.
// Dependency-free so storage, the UI, the renderer and node tests can all share it.

/** Edge length the profile writer crops and downscales photos to before saving. */
export const PHOTO_PX = 192;
/** Hard cap on a stored photo, in characters. A 192 px JPEG is roughly 16-40k. */
export const PHOTO_MAX_CHARS = 200_000;

const PHOTO_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * True for a strict base64 image data URL. The character class rules out quotes, angle
 * brackets and whitespace, so the value can't inject markup when placed in an attribute,
 * and remote URLs (which would taint a canvas) and SVG are rejected.
 */
export function isPhotoDataUrl(s: unknown): s is string {
  return typeof s === 'string' && s.length > 30 && s.length <= PHOTO_MAX_CHARS && PHOTO_RE.test(s);
}
