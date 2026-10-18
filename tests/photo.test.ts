import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPhotoDataUrl, PHOTO_MAX_CHARS, PHOTO_PX } from '../src/core/photo';
import {
  AVATAR_BOB_AMP,
  AVATAR_LIFT,
  AVATAR_SIZE,
  AVATAR_TEX,
  GHOST_FADE_FAR,
  GHOST_FADE_NEAR,
} from '../src/render/avatar';
import { avatarSrc, drawAvatar, loadAvatarImage, peekAvatarImage } from '../src/ui/avatarArt';

const B64 = 'A'.repeat(40) + '==';

describe('isPhotoDataUrl', () => {
  it('accepts strict base64 png, jpeg and webp', () => {
    for (const t of ['png', 'jpeg', 'webp']) expect(isPhotoDataUrl(`data:image/${t};base64,${B64}`), t).toBe(true);
  });

  it('rejects everything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      '',
      42,
      'http://example.com/a.png',
      `data:image/svg+xml;base64,${B64}`,
      `data:text/html;base64,${B64}`,
      `data:image/gif;base64,${B64}`,
      `data:image/jpg;base64,${B64}`,
      'javascript:alert(1)',
      'data:image/png;base64,',
      'data:image/png;base64,AAAA" onerror="x',
      `data:image/png;base64,${B64}" onerror="alert(1)`,
      `data:image/png;base64,AAAA AAAA${B64}`,
      `data:image/png;base64,AAAA\nAAAA${B64}`,
      `data:image/png;base64,<b>${B64}`,
    ];
    for (const v of bad) expect(isPhotoDataUrl(v), String(v)).toBe(false);
  });

  it('enforces the length cap', () => {
    const head = 'data:image/jpeg;base64,';
    const atCap = head + 'A'.repeat(PHOTO_MAX_CHARS - head.length);
    expect(isPhotoDataUrl(atCap)).toBe(true);
    expect(isPhotoDataUrl(atCap + 'A')).toBe(false);
  });
});

describe('avatar constants', () => {
  it('keep the badge clear of the car and the ghost fade sane', () => {
    expect(Math.log2(AVATAR_TEX) % 1).toBe(0);
    expect(AVATAR_LIFT - AVATAR_SIZE / 2 - AVATAR_BOB_AMP).toBeGreaterThanOrEqual(1.0);
    expect(GHOST_FADE_NEAR).toBeGreaterThan(3.5);
    expect(GHOST_FADE_FAR).toBeGreaterThan(GHOST_FADE_NEAR);
    expect(PHOTO_PX).toBe(192);
    expect(PHOTO_PX).toBeLessThanOrEqual(512);
    expect(PHOTO_MAX_CHARS).toBe(200_000);
  });
});

describe('avatar art', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a valid photo as the DOM source and never an invalid one', () => {
    const ok = `data:image/png;base64,${B64}`;
    expect(avatarSrc(ok)).toBe(ok);
    // No DOM in node, so the dummy can't be drawn: '' tells the caller to omit src.
    expect(avatarSrc('data:image/png;base64,AAAA" onerror="x')).toBe('');
    expect(avatarSrc(null)).toBe('');
  });

  it('cover-crops the photo into the inner disc', () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const g = new Proxy(
      {},
      {
        get: (_t, name) =>
          name === 'createLinearGradient'
            ? () => ({ addColorStop() {} })
            : (...args: unknown[]) => calls.push({ name: String(name), args }),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    const img = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement;
    drawAvatar(g, 128, img, '#e8452c');
    const draw = calls.find((c) => c.name === 'drawImage')!;
    // Inner disc radius 54: the short side scales to 108 and the long side is centred.
    expect(draw.args.slice(1)).toEqual([64 - 108, 10, 216, 108]);
    calls.length = 0;
    drawAvatar(g, 128, null, '#e8452c');
    expect(calls.some((c) => c.name === 'drawImage')).toBe(false);
    expect(calls.filter((c) => c.name === 'ellipse').length).toBe(1);
  });

  it('decodes once, shares the result and never rejects', async () => {
    let made = 0;
    let fail = false;
    class FakeImage {
      src = '';
      naturalWidth = 0;
      naturalHeight = 0;
      constructor() {
        made++;
      }
      decode(): Promise<void> {
        if (fail) return Promise.reject(new Error('corrupt'));
        this.naturalWidth = this.naturalHeight = 64;
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);
    const a = `data:image/jpeg;base64,${B64}`;
    const p1 = loadAvatarImage(a);
    const p2 = loadAvatarImage(a);
    expect(p2).toBe(p1);
    const im = await p1;
    expect(im).not.toBeNull();
    expect(peekAvatarImage(a)).toBe(im);
    expect(made).toBe(1);

    fail = true;
    const b = `data:image/png;base64,${B64}`;
    expect(await loadAvatarImage(b)).toBeNull();
    expect(peekAvatarImage(b)).toBeNull();
    expect(peekAvatarImage(a)).toBeNull(); // one-entry cache
  });
});
